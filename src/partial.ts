import { Account, Connection, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { homedir } from 'os';
import * as fs from 'fs';
import { findLargestTokenAccountForOwner, notify, sleep, STAKING_PROGRAM_ID, Wallet, ZERO } from './utils';
import { refreshReserveInstruction } from './instructions/refreshReserve';
import { refreshObligationInstruction } from './instructions/refreshObligation';
import { liquidateObligationInstruction } from './instructions/liquidateObligation';
import { AccountLayout, Token, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { redeemReserveCollateralInstruction } from './instructions/redeemReserveCollateral';
import { parsePriceData } from '@pythnetwork/client';
import Big from 'big.js';
import {Port} from '@port.finance/port-sdk'
import { PortBalance } from '@port.finance/port-sdk/lib/models/PortBalance';
import { ReserveContext } from '@port.finance/port-sdk/lib/models/ReserveContext';
import { ReserveInfo } from '@port.finance/port-sdk/lib/models/ReserveInfo';
import { ReserveId } from '@port.finance/port-sdk/lib/models/ReserveId';

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
  "7dXHPrJtwBjQqU1pLKfkHbq9TjQAK9jTms3rnj1i3G77": "SBR"
}

interface EnrichedObligation {
  riskFactor: number;
  // loan value in USD
  loanValue: Big;
  // collateral value in USD
  collateralValue: Big;
  obligation: PortBalance;
  borrowedAssetNames: string[];
  depositedAssetNames: string[];
}

async function runPartialLiquidator() {
  const clusterUrl = process.env.CLUSTER_URL || "https://api.mainnet-beta.solana.com"
  const checkInterval = parseFloat(process.env.CHECK_INTERVAL || "8000.0")
  const connection = new Connection(clusterUrl, 'singleGossip')

  // The address of the Port Finance on the blockchain
  const programId = new PublicKey(process.env.PROGRAM_ID || "Port7uDYB3wk6GJAw4KT1WpTeMtSu9bTcChBHkX2LfR")

  // liquidator's keypair
  const keyPairPath = process.env.KEYPAIR || `${homedir()}/.config/solana/id.json`
  const payer = new Account(JSON.parse(fs.readFileSync(keyPairPath, 'utf-8')))

  console.log(`Port liquidator launched on cluster=${clusterUrl}`);

  const reserveContext = await Port.forMainNet().getReserveContext()
  const wallets: Map<string, { publicKey: PublicKey; tokenAccount: Wallet }> = new Map();

  for (const reserve of reserveContext.getAllReserves()) {
    wallets.set(
      reserve.getAssetId().toString(),
      await findLargestTokenAccountForOwner(
        connection, payer, reserve.getAssetId().key));
    wallets.set(
      reserve.getShareId().toString(),
      await findLargestTokenAccountForOwner(
        connection, payer, reserve.getShareId().key));
  }

  while (true) {
    try {
      redeemRemainingCollaterals(reserveContext, programId, connection, payer, wallets);

      const unhealthyObligations = await getUnhealthyObligations(connection);
      console.log(`Time: ${new Date()} - payer account ${payer.publicKey.toBase58()}, we have ${unhealthyObligations.length} accounts for liquidation`)
      for (const unhealthyObligation of unhealthyObligations) {
        notify(
`Liquidating obligation account ${unhealthyObligation.obligation.getPortId().toString()} which is owned by ${unhealthyObligation.obligation.owner.toBase58()} with risk factor: ${unhealthyObligation.riskFactor}
which has borrowed ${unhealthyObligation.loanValue} ...
`
        )
        await liquidateAccount(connection, programId, payer, unhealthyObligation, reserveContext, wallets);
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

function redeemRemainingCollaterals(reserveContext: ReserveContext, programId: PublicKey, connection: Connection, payer: Account, wallets: Map<string, { publicKey: PublicKey; tokenAccount: Wallet; }>) {
  const lendingMarket: PublicKey = reserveContext.getAllReserves()[0].getReserveId().key
  reserveContext.getAllReserves().forEach(
    async (reserve) => {
      const [lendingMarketAuthority] = await PublicKey.findProgramAddress(
        [lendingMarket.toBuffer()],
        programId
      );
      const collateralWallet = await findLargestTokenAccountForOwner(connection, payer, reserve.getShareId().key);

      if (collateralWallet.tokenAccount.amount > 0) {
        await redeemCollateral(wallets, reserve, payer, collateralWallet, lendingMarketAuthority, connection);
      }
    }
  );
}

async function readSymbolPrice(connection: Connection, reserve: ReserveInfo): Promise<Big> {
  if (reserve.getOracleId() === null) {
    return reserve.getMarkPrice().getRaw();
  }

  const pythData = await connection.getAccountInfo(reserve.getOracleId()!.key);
  const parsedData = parsePriceData(pythData?.data!);

  return new Big(parsedData.price);
}

async function readTokenPrices(connection, reserveContext: ReserveContext): Promise<Map<string, Big>> {
  const tokenToCurrentPrice = new Map();

  for (const reserve of reserveContext.getAllReserves()) {
    tokenToCurrentPrice.set(
      reserve.getReserveId().toString(),
      await readSymbolPrice(connection, reserve)
    )
  }
  return tokenToCurrentPrice
}

function willNeverLiquidate(obligation: PortBalance): boolean {
  const loans = obligation.getLoans()
  const collaterals = obligation.getCollaterals()
  return loans.length === 1 && collaterals.length === 1 && loans[0].getReserveId().toString() === collaterals[0].getReserveId().toString()
}

function isInsolvent(obligation: PortBalance): boolean {
  return obligation.getLoans().length > 0 && obligation.getCollaterals().length === 0;
}

function isNoBorrow(obligation: PortBalance): boolean {
  return obligation.getLoans().length === 0;
}

async function getUnhealthyObligations(connection: Connection) {
  const mainnetPort = Port.forMainNet()
  const portBalances = await mainnetPort.getAllPortBalances()
  const reserves = await mainnetPort.getReserveContext()
  const tokenToCurrentPrice = await readTokenPrices(connection, reserves);
  const sortedObligations =  portBalances
    .filter(obligation => !isNoBorrow(obligation))
    .filter(obligation => !willNeverLiquidate(obligation))
    .filter(obligation => !isInsolvent(obligation))
    .map(obligation => generateEnrichedObligation(obligation, tokenToCurrentPrice, reserves))
    .sort(
      (obligation1, obligation2) => {
        return obligation2.riskFactor * 100 - obligation1.riskFactor * 100;
      }
    );

  console.log(`Total number of loans are ${portBalances.length} and possible liquidation debts are ${sortedObligations.length}`)
  sortedObligations.slice(0, DISPLAY_FIRST).forEach(
    ob => console.log(
`Risk factor: ${ob.riskFactor.toFixed(4)} borrowed amount: ${ob.loanValue} deposit amount: ${ob.collateralValue}
borrowed asset names: [${ob.borrowedAssetNames.toString()}] deposited asset names: [${ob.depositedAssetNames.toString()}]
obligation pubkey: ${ob.obligation.getPortId().toString()}
`
    )
  )

  tokenToCurrentPrice.forEach((price: Big, token: string) => {
    console.log(`name: ${reserveLookUpTable[token]} price: ${price.toString()}`)
  });
  console.log("\n");
  return sortedObligations.filter(obligation => obligation.riskFactor >= 1);
}

function generateEnrichedObligation(obligation: PortBalance, tokenToCurrentPrice: Map<string, Big>, reserveContext: ReserveContext): EnrichedObligation {
  let loanValue = ZERO;
  const borrowedAssetNames: string[] = [];
  for (const borrow of obligation.getLoans()) {
    let reservePubKey = borrow.getReserveId().toString();
    let name = reserveLookUpTable[reservePubKey];
    let reserve = reserveContext.getReserveByReserveId(borrow.getReserveId());
    let tokenPrice: Big = tokenToCurrentPrice.get(reservePubKey)!;
    let totalPrice = borrow.getAsset().getRaw().mul(tokenPrice).div(reserve.getQuantityContext().multiplier)
    loanValue = loanValue.add(totalPrice)
    borrowedAssetNames.push(name);
  }
  let collateralValue = ZERO;
  const depositedAssetNames: string[] = [];

  for (const deposit of obligation.getCollaterals()) {
    let reservePubKey = deposit.getReserveId().toString();
    let name = reserveLookUpTable[reservePubKey];
    let reserve = reserveContext.getReserveByReserveId(deposit.getReserveId());
    let exchangeRatio = reserve.getExchangeRatio().getPct()?.getRaw();
    let liquidationThreshold = reserve.params.liquidationThreshold.getRaw();
    let tokenPrice = tokenToCurrentPrice.get(reservePubKey)!;
    let totalPrice = deposit.getShare().getRaw().div(exchangeRatio).mul(tokenPrice).mul(liquidationThreshold).div(reserve.getQuantityContext().multiplier);
    collateralValue = collateralValue.add(totalPrice)
    depositedAssetNames.push(name);
  }

  const riskFactor = (collateralValue === ZERO || loanValue === ZERO) ? 0 : loanValue.div(collateralValue);

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
  obligation: EnrichedObligation, reserveContext: ReserveContext, wallets: Map<string, { publicKey: PublicKey; tokenAccount: Wallet }>) {
  const lendingMarket: PublicKey = reserveContext.getAllReserves()[0].getMarketId().key;
  const [lendingMarketAuthority] = await PublicKey.findProgramAddress(
    [lendingMarket.toBuffer()],
    programId,
  );
  const transaction: Transaction = new Transaction();
  const signers: Account[] = [];

  const toRefreshReserves: Set<ReserveId> = new Set();
  obligation.obligation.getLoans().forEach(
    borrow => {
      toRefreshReserves.add(borrow.getReserveId())
    }
  );
  obligation.obligation.getCollaterals().forEach(
    deposit => {
      toRefreshReserves.add(deposit.getReserveId())
    }
  );
  toRefreshReserves.forEach(
    reserve => {
      transaction.add(
        refreshReserveInstruction(
          reserveContext.getReserveByReserveId(reserve)
        )
      )
    }
  )
  
  const laons = obligation.obligation.getLoans()
  const collaterals = obligation.obligation.getCollaterals()
  // TODO: choose a more sensible value
  const repayReserve: ReserveInfo = reserveContext.getReserveByReserveId(laons[0].getReserveId());
  const withdrawReserve: ReserveInfo = reserveContext.getReserveByReserveId(collaterals[0].getReserveId());
  
  if (!repayReserve || !withdrawReserve) {
    return;
  }

  if (repayReserve.getAssetId().toString() !== SOL_MINT && (
      !wallets.has(repayReserve.getAssetId().toString()) ||
            !wallets.has(withdrawReserve.getShareId().toString()))) {
    return;
  }
  
  const payerAccount = await connection.getAccountInfo(payer.publicKey);
  const repayWallet = await findLargestTokenAccountForOwner(connection, payer, repayReserve.getAssetId().key)
  const withdrawWallet = await findLargestTokenAccountForOwner(connection, payer, withdrawReserve.getShareId().key)

  signers.push(payer);

  const transferAuthority = repayReserve.getAssetId().toString() !== SOL_MINT ?
    await liquidateByPayingToken(
      connection,
      transaction,
      signers,
      repayWallet.tokenAccount.amount,
      repayWallet.publicKey,
      withdrawWallet.publicKey,
      repayReserve,
      withdrawReserve,
      obligation.obligation,
      lendingMarket,
      lendingMarketAuthority,
      payer,
    ) :
    await liquidateByPayingSOL(
      connection,
      transaction,
      signers,
      payerAccount!.lamports - 100_000_000,
      wallets.get(withdrawReserve.getShareId().toString())!.publicKey,
      repayReserve,
      withdrawReserve,
      obligation.obligation,
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

  const tokenwallet = await findLargestTokenAccountForOwner(connection, payer, withdrawReserve.getShareId().key);

  await redeemCollateral(wallets, withdrawReserve, payer, tokenwallet, lendingMarketAuthority, connection);

}

function liquidateByPayingSOL(
  connection: Connection,
  transaction: Transaction,
  signers: Account[],
  amount: number,
  withdrawWallet: PublicKey,
  repayReserve: ReserveInfo,
  withdrawReserve: ReserveInfo,
  obligation: PortBalance,
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
  repayReserve: ReserveInfo,
  withdrawReserve: ReserveInfo,
  obligation: PortBalance,
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
            dataSize: 233
          },
          {
            memcmp: {
              offset: 1 + 16,
              bytes: obligation.owner.toBase58(),
            }
          },
          {
            memcmp: {
              offset: 1 + 16 + 32,
              bytes: withdrawReserve.staking_pool!.toBase58()
            }
          }
        ]
      }
    )

    const laons = obligation.getLoans()
    const collaterals = obligation.getCollaterals()

    transaction.add(
      refreshObligationInstruction(
        obligation.getPortId().key,
        collaterals.map(deposit => deposit.getReserveId().key),
        laons.map(borrow => borrow.getReserveId().key),
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
        repayReserve.getReserveId().key,
        repayReserve.getAssetBalanceId().key,
        withdrawReserve.getReserveId().key,
        withdrawReserve.getShareBalanceId().key,
        obligation.getPortId().key,
        lendingMarket,
        lendingMarketAuthority,
        transferAuthority.publicKey,
        withdrawReserve.staking_pool !== null ? withdrawReserve.staking_pool : undefined,
        withdrawReserve.staking_pool !== null ? stakeAccounts[0].pubkey : undefined,
      ),
    );

    return transferAuthority;
}

async function redeemCollateral(
  wallets: Map<string, { publicKey: PublicKey; tokenAccount: Wallet; }>,
  withdrawReserve: ReserveInfo,
  payer: Account,
  tokenwallet: { publicKey: PublicKey; tokenAccount: Wallet; },
  lendingMarketAuthority: PublicKey,
  connection: Connection
) {
  const transaction = new Transaction();
  const transferAuthority = new Account();
  if (tokenwallet.tokenAccount.amount === 0) {
    return;
  }

  transaction.add(
    Token.createApproveInstruction(
      TOKEN_PROGRAM_ID,
      wallets.get(withdrawReserve.getShareId().toString())!.publicKey,
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
      wallets.get(withdrawReserve.getAssetId().toString())!.publicKey!,
      withdrawReserve.getReserveId().key,
      withdrawReserve.getShareId().key,
      withdrawReserve.getAssetBalanceId().key,
      withdrawReserve.getMarketId().key,
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

