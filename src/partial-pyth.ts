import { Account, Connection, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { homedir } from 'os';
import * as fs from 'fs';
import { findLargestTokenAccountForOwner, getAllObligations, getParsedReservesMap, scaleToNormalNumber, notify, sleep, STAKING_PROGRAM_ID, TEN, WAD, wadToBN, wadToNumber, Wallet, ZERO } from './utils';
import { EnrichedObligation, Obligation } from './layouts/obligation';
import { EnrichedReserve} from './layouts/reserve';
import { refreshReserveInstruction } from './instructions/refreshReserve';
import { refreshObligationInstruction } from './instructions/refreshObligation';
import { liquidateObligationInstruction } from './instructions/liquidateObligation';
import { AccountLayout, Token, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { redeemReserveCollateralInstruction } from './instructions/redeemReserveCollateral';
import { parsePriceData } from '@pythnetwork/client';
import BN from 'bn.js';

const SOL_MINT = "So11111111111111111111111111111111111111112";
const DISPLAY_FIRST = 10;

const reserveLookUpTable = {
  "X9ByyhmtQH3Wjku9N5obPy54DbVjZV7Z99TPJZ2rwcs": "SOL",
  "DcENuKuYd6BWGhKfGr7eARxodqG12Bz1sN5WA8NwvLRx": "USDC",
  "4tqY9Hv7e8YhNQXuH75WKrZ7tTckbv2GfFVxmVcScW5s": "USDT",
  "DSw99gXoGzvc4N7cNGU7TJ9bCWFq96NU2Cczi1TabDx2": "PAI",
  "ZgS3sv1tJAor2rbGMFLeJwxsEGDiHkcrR2ZaNHZUpyF": "SRM",
  "DSST29PMCVkxo8cf5ht9LxrPoMc8jAZt98t6nuJywz8p": "BTC",
  "BnhsmYVvNjXK3TGDHLj1Yr1jBGCmD1gZMkAyCwoXsHwt": "MER",
  "9gDF5W94RowoDugxT8cM29cX8pKKQitTp2uYVrarBSQ7": "mSOL",
  "GRJyCEezbZQibAEfBKCRAg5YoTPP2UcRSTC7RfzoMypy": "pSOL",
}

async function runPartialLiquidator() {
  const cluster = process.env.CLUSTER || 'devnet'
  const clusterUrl = process.env.CLUSTER_URL || "https://api.devnet.solana.com"
  const checkInterval = parseFloat(process.env.CHECK_INTERVAL || "1000.0")
  const connection = new Connection(clusterUrl, 'singleGossip')

  // The address of the Port Finance on the blockchain
  const programId = new PublicKey(process.env.PROGRAM_ID || "Port7uDYB3wk6GJAw4KT1WpTeMtSu9bTcChBHkX2LfR")

  // liquidator's keypair
  const keyPairPath = process.env.KEYPAIR || `${homedir()}/.config/solana/id.json`
  const payer = new Account(JSON.parse(fs.readFileSync(keyPairPath, 'utf-8')))

  console.log(`Port liquidator launched on cluster=${cluster}`);

  const parsedReserveMap = await getParsedReservesMap(connection, programId);
  const wallets: Map<string, { publicKey: PublicKey; tokenAccount: Wallet }> = new Map();

  for (const reserve of parsedReserveMap.values()) {
    wallets.set(
      reserve.reserve.liquidity.mintPubkey.toBase58(),
      await findLargestTokenAccountForOwner(
        connection, payer, reserve.reserve.liquidity.mintPubkey));
    wallets.set(
      reserve.reserve.collateral.mintPubkey.toBase58(),
      await findLargestTokenAccountForOwner(
        connection, payer, reserve.reserve.collateral.mintPubkey));
  }

  while (true) {
    try {
      redeemRemainingCollaterals(parsedReserveMap, programId, connection, payer, wallets);

      const unhealthyObligations = await getUnhealthyObligations(connection, programId, parsedReserveMap);
      console.log(`Time: ${new Date()} - payer account ${payer.publicKey.toBase58()}, we have ${unhealthyObligations.length} accounts for liquidation`)
      for (const unhealthyObligation of unhealthyObligations) {
        notify(
          `Liquidating obligation account ${unhealthyObligation.obligation.publicKey.toBase58()} which is owned by ${unhealthyObligation.obligation.owner.toBase58()} with risk factor: ${unhealthyObligation.riskFactor}
           which has borrowed ${unhealthyObligation.loanValue} with liquidation borrowed value at ${unhealthyObligation.obligation.unhealthyBorrowValue} ...`)
        await liquidateAccount(connection, programId, payer, unhealthyObligation.obligation, parsedReserveMap, wallets);
      }

    } catch (e) {
      notify(`unknown error: ${e}`);
      console.error(e);
    } finally {
      await sleep(checkInterval)
    }
    // break;
  }

}

function redeemRemainingCollaterals(parsedReserveMap: Map<string, EnrichedReserve>, programId: PublicKey, connection: Connection, payer: Account, wallets: Map<string, { publicKey: PublicKey; tokenAccount: Wallet; }>) {
  parsedReserveMap.forEach(
    async (reserve) => {
      const lendingMarket: PublicKey = parsedReserveMap.values().next().value.reserve.lendingMarket;
      const [lendingMarketAuthority] = await PublicKey.findProgramAddress(
        [lendingMarket.toBuffer()],
        programId
      );
      const collateralWallet = await findLargestTokenAccountForOwner(connection, payer, reserve.reserve.collateral.mintPubkey);

      if (collateralWallet.tokenAccount.amount > 0) {
        await redeemCollateral(wallets, reserve, payer, collateralWallet, lendingMarketAuthority, connection);
      }
    }
  );
}

async function readSymbolPrice(connection: Connection, reserve: EnrichedReserve): Promise<BN> {
  if (reserve.reserve.liquidity.oracleOption === 0) {
    return reserve.reserve.liquidity.marketPrice.div(TEN.pow(new BN(8)));
  }

  const pythData = await connection.getAccountInfo(reserve.reserve.liquidity.oraclePubkey);
  const parsedData = parsePriceData(pythData?.data!);

  // we use a 10 ^ 10 scale.
  return new BN(parsedData.price * 10 ** 10);
}

async function readTokenPrices(connection, allReserve: Map<string, EnrichedReserve>): Promise<Map<string, BN>> {
  const tokenToCurrentPrice = new Map();

  for (const [_, reserve] of allReserve.entries()) {
    tokenToCurrentPrice.set(
      reserve.publicKey.toBase58(),
      await readSymbolPrice(connection, reserve)
    )
  }
  return tokenToCurrentPrice
}

async function getUnhealthyObligations(connection: Connection, programId: PublicKey, allReserve: Map<string, EnrichedReserve>) {
  const obligations = await getAllObligations(connection, programId)
  const tokenToCurrentPrice = await readTokenPrices(connection, allReserve);
  const sortedObligations =  obligations
    .filter(obligation => obligation.borrowedValue.gt(ZERO))
    .map(obligation => generateEnrichedObligation(obligation, tokenToCurrentPrice, allReserve))
    .sort(
      (obligation1, obligation2) => {
        return obligation2.riskFactor * 100 - obligation1.riskFactor * 100;
      }
    );

  console.log(`Total number of loans are: ${sortedObligations.length}`)
  sortedObligations.slice(0, DISPLAY_FIRST).forEach(
    ob => console.log(
`Risk factor: ${ob.riskFactor.toFixed(4)} borrowed amount: ${scaleToNormalNumber(ob.loanValue, 10)} deposit amount: ${scaleToNormalNumber(ob.collateralValue, 10)}
borrowed asset names: [${ob.borrowedAssetNames.toString()}] deposited asset names: [${ob.depositedAssetNames.toString()}]
obligation names: ${ob.obligation.publicKey.toBase58()}
`
    )
  )

  tokenToCurrentPrice.forEach((price: BN, token: string) => {
    console.log(`name: ${reserveLookUpTable[token]} price: ${scaleToNormalNumber(price, 10)}`)
  });
  console.log("\n");
  return sortedObligations.filter(obligation => obligation.riskFactor >= 1);
}

function generateEnrichedObligation(obligation: Obligation, tokenToCurrentPrice: Map<string, BN>, allReserve: Map<string, EnrichedReserve>): EnrichedObligation {
  let loanValue = ZERO;
  const borrowedAssetNames: string[] = [];
  for (const borrow of obligation.borrows) {
    let reservePubKey = borrow.borrowReserve.toBase58();
    let reserve = allReserve.get(reservePubKey)!.reserve;
    let name = reserveLookUpTable[reservePubKey];
    let tokenPriceWad = tokenToCurrentPrice.get(reservePubKey)!;
    let totalPriceWad = borrow.borrowedAmountWads.mul(tokenPriceWad).div(WAD).div(TEN.pow(new BN(reserve.liquidity.mintDecimals)))
    loanValue = loanValue.add(totalPriceWad)
    borrowedAssetNames.push(name);
  }
  let collateralValue = ZERO;
  const depositedAssetNames: string[] = [];

  for (const deposit of obligation.deposits) {

    let reservePubKey = deposit.depositReserve.toBase58();
    let name = reserveLookUpTable[reservePubKey];
    let reserve = allReserve.get(reservePubKey)!.reserve;
    let totalSupply = reserve.liquidity.availableAmount.add(wadToBN(reserve.liquidity.borrowedAmountWads));
    let collateralTotalSupply = reserve.collateral.mintTotalSupply;
    // In percentage
    let liquidationThreshold = reserve.config.liquidationThreshold!;
    let tokenPriceWad = tokenToCurrentPrice.get(reservePubKey)!;
    let totalPriceWad = deposit.depositedAmount.mul(totalSupply).mul(tokenPriceWad).mul(new BN(liquidationThreshold)).div(collateralTotalSupply).div(new BN(100)).div(TEN.pow(new BN(reserve.liquidity.mintDecimals)))
    collateralValue = collateralValue.add(totalPriceWad)
    depositedAssetNames.push(name);
  }

  const riskFactor = (collateralValue === ZERO || loanValue === ZERO) ? 0 : scaleToNormalNumber((loanValue.mul(WAD).div(collateralValue)), 18);

  return {
    loanValue,
    collateralValue,
    riskFactor,
    obligation,
    borrowedAssetNames,
    depositedAssetNames,
  }
}

async function liquidateAccount(
  connection: Connection, programId: PublicKey, payer: Account,
  obligation: Obligation, parsedReserveMap: Map<string, EnrichedReserve>, wallets: Map<string, { publicKey: PublicKey; tokenAccount: Wallet }>) {
  const lendingMarket: PublicKey = parsedReserveMap.values().next().value.reserve.lendingMarket;
  const [lendingMarketAuthority] = await PublicKey.findProgramAddress(
    [lendingMarket.toBuffer()],
    programId,
  );
  const transaction: Transaction = new Transaction();
  const signers: Account[] = [];

  const toRefreshReserves: Set<string> = new Set();
  obligation.borrows.forEach(
    borrow => {
      toRefreshReserves.add(borrow.borrowReserve.toBase58())
    }
  );
  obligation.deposits.forEach(
    deposit => {
      toRefreshReserves.add(deposit.depositReserve.toBase58())
    }
  );
  toRefreshReserves.forEach(
    reserve => {
      transaction.add(
        refreshReserveInstruction(
          parsedReserveMap.get(reserve)!
        )
      )
    }
  )

  // TODO: choose a more sensible value
  const repayReserve: EnrichedReserve | undefined = parsedReserveMap.get(obligation.borrows[0].borrowReserve.toBase58());
  const withdrawReserve: EnrichedReserve | undefined = parsedReserveMap.get(obligation.deposits[0].depositReserve.toBase58());
  
  if (!repayReserve || !withdrawReserve) {
    return;
  }

  if (repayReserve.reserve.liquidity.mintPubkey.toBase58() !== SOL_MINT && (
      !wallets.has(repayReserve.reserve.liquidity.mintPubkey.toBase58()) ||
            !wallets.has(withdrawReserve.reserve.collateral.mintPubkey.toBase58()))) {
    return;
  }
  
  const payerAccount = await connection.getAccountInfo(payer.publicKey);
  const repayWallet = await findLargestTokenAccountForOwner(connection, payer, repayReserve.reserve.liquidity.mintPubkey)
  const withdrawWallet = await findLargestTokenAccountForOwner(connection, payer, withdrawReserve.reserve.collateral.mintPubkey)

  signers.push(payer);

  const transferAuthority = repayReserve.reserve.liquidity.mintPubkey.toBase58() !== SOL_MINT ?
    await liquidateByPayingToken(
      connection,
      transaction,
      signers,
      repayWallet.tokenAccount.amount,
      repayWallet.publicKey,
      withdrawWallet.publicKey,
      repayReserve,
      withdrawReserve,
      obligation,
      lendingMarket,
      lendingMarketAuthority,
      payer,
    ) :
    await liquidateByPayingSOL(
      connection,
      transaction,
      signers,
      payerAccount!.lamports - 100_000_000,
      wallets.get(withdrawReserve.reserve.collateral.mintPubkey.toBase58())!.publicKey,
      repayReserve,
      withdrawReserve,
      obligation,
      lendingMarket,
      lendingMarketAuthority,
      payer
    );

  signers.push(transferAuthority);
  const sig = await connection.sendTransaction(
    transaction,
    signers,
  );
  console.log(`liqudiation transaction sent: ${sig}.`)

  const tokenwallet = await findLargestTokenAccountForOwner(connection, payer, withdrawReserve.reserve.collateral.mintPubkey);

  await redeemCollateral(wallets, withdrawReserve, payer, tokenwallet, lendingMarketAuthority, connection);

}

function liquidateByPayingSOL(
  connection: Connection,
  transaction: Transaction,
  signers: Account[],
  amount: number,
  withdrawWallet: PublicKey,
  repayReserve: EnrichedReserve,
  withdrawReserve: EnrichedReserve,
  obligation: Obligation,
  lendingMarket: PublicKey,
  lendingMarketAuthority: PublicKey,
  payer: Account,
) {
  const wrappedSOLTokenAccount = new Account();
  transaction.add(
    SystemProgram.createAccount(
      {
        fromPubkey: payer.publicKey,
        newAccountPubkey: wrappedSOLTokenAccount.publicKey,
        lamports: amount,
        space: AccountLayout.span,
        programId: new PublicKey(TOKEN_PROGRAM_ID),
      }
    ),
    Token.createInitAccountInstruction(
      new PublicKey(TOKEN_PROGRAM_ID),
      new PublicKey(SOL_MINT),
      wrappedSOLTokenAccount.publicKey,
      payer.publicKey
    )
  );

  const transferAuthority = liquidateByPayingToken(
    connection,
    transaction,
    signers,
    amount,
    wrappedSOLTokenAccount.publicKey,
    withdrawWallet,
    repayReserve,
    withdrawReserve,
    obligation,
    lendingMarket,
    lendingMarketAuthority,
    payer,
  );

  transaction.add(
    Token.createCloseAccountInstruction(
      TOKEN_PROGRAM_ID,
      wrappedSOLTokenAccount.publicKey,
      payer.publicKey,
      payer.publicKey,
      [],
    )
  );

  signers.push(
    wrappedSOLTokenAccount
  );

  return transferAuthority;
}

async function liquidateByPayingToken(
  connection: Connection,
  transaction: Transaction,
  signers: Account[],
  amount: number,
  repayWallet: PublicKey,
  withdrawWallet: PublicKey,
  repayReserve: EnrichedReserve,
  withdrawReserve: EnrichedReserve,
  obligation: Obligation,
  lendingMarket: PublicKey,
  lendingMarketAuthority: PublicKey,
  payer: Account,
) {

    const transferAuthority = new Account();
    const stakeAccounts = await connection.getProgramAccounts(
      STAKING_PROGRAM_ID,
      {
        filters: [
          {
            dataSize: 213
          },
          {
            memcmp: {
              offset: 1 + 6,
              bytes: obligation.owner.toBase58(),
            }
          },
          {
            memcmp: {
              offset: 1 + 6 + 32,
              bytes: withdrawReserve.reserve.deposit_staking_pool.toBase58()
            }
          }
        ]
      }
    )

    transaction.add(
      refreshObligationInstruction(
        obligation.publicKey,
        obligation.deposits.map(deposit => deposit.depositReserve),
        obligation.borrows.map(borrow => borrow.borrowReserve),
      ),
      Token.createApproveInstruction(
        TOKEN_PROGRAM_ID,
        repayWallet,
        transferAuthority.publicKey,
        payer.publicKey,
        [],
        amount,
      ),
      liquidateObligationInstruction(
        amount,
        repayWallet,
        withdrawWallet,
        repayReserve.publicKey,
        repayReserve.reserve.liquidity.supplyPubkey,
        withdrawReserve.publicKey,
        withdrawReserve.reserve.collateral.supplyPubkey,
        obligation.publicKey,
        lendingMarket,
        lendingMarketAuthority,
        transferAuthority.publicKey,
        withdrawReserve.reserve.deposit_staking_pool_option === 1 ? withdrawReserve.reserve.deposit_staking_pool : undefined,
        withdrawReserve.reserve.deposit_staking_pool_option === 1 ? stakeAccounts[0].pubkey : undefined,
      ),
    );

    return transferAuthority;
}

async function redeemCollateral(wallets: Map<string, { publicKey: PublicKey; tokenAccount: Wallet; }>, withdrawReserve: EnrichedReserve, payer: Account, tokenwallet: { publicKey: PublicKey; tokenAccount: Wallet; }, lendingMarketAuthority: PublicKey, connection: Connection) {
  const transaction = new Transaction();
  const transferAuthority = new Account();
  if (tokenwallet.tokenAccount.amount === 0) {
    return;
  }

  transaction.add(
    Token.createApproveInstruction(
      TOKEN_PROGRAM_ID,
      wallets.get(withdrawReserve.reserve.collateral.mintPubkey.toBase58())!.publicKey,
      transferAuthority.publicKey,
      payer.publicKey,
      [],
      1_000_000_000_000
    ),
    refreshReserveInstruction(
      withdrawReserve
    ),
    redeemReserveCollateralInstruction(
      tokenwallet.tokenAccount.amount,
      tokenwallet.publicKey,
      wallets.get(withdrawReserve.reserve.liquidity.mintPubkey.toBase58())!.publicKey!,
      withdrawReserve.publicKey,
      withdrawReserve.reserve.collateral.mintPubkey,
      withdrawReserve.reserve.liquidity.supplyPubkey,
      withdrawReserve.reserve.lendingMarket,
      lendingMarketAuthority,
      transferAuthority.publicKey
    )
  );

  const redeemSig = await connection.sendTransaction(
    transaction,
    [payer, transferAuthority]
  );

  console.log(`Redeem reserve collateral: ${redeemSig}.`);
}

async function sellToken(tokenAccount: Wallet) {
  // TODO: sell token using Serum or Raydium
}

runPartialLiquidator()

