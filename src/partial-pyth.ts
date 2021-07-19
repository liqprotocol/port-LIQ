import { Account, Connection, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { homedir } from 'os';
import * as fs from 'fs';
import { findLargestTokenAccountForOwner, getAllObligations, getAssetPrice, getParsedReservesMap, getUnixTs, lamportToNumber, notify, sleep, wadToLamport, Wallet } from './utils';
import BN = require('bn.js');
import { EnrichedObligation, Obligation } from './layouts/obligation';
import { EnrichedReserve} from './layouts/reserve';
import { refreshReserveInstruction } from './instructions/refreshReserve';
import { refreshObligationInstruction } from './instructions/refreshObligation';
import { liquidateObligationInstruction } from './instructions/liquidateObligation';
import { AccountLayout, Token, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { redeemReserveCollateralInstruction } from './instructions/redeemReserveCollateral';

const SOL_MINT = "So11111111111111111111111111111111111111112";
const DISPLAY_FIRST = 1;

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
  const reserves:EnrichedReserve[] = [];
  parsedReserveMap.forEach(
    (reserve) => reserves.push(reserve)
  );

  await Promise.all(
    reserves.map(
      async (reserve) => {
        wallets.set(
          reserve.reserve.liquidity.mintPubkey.toBase58(),
          await findLargestTokenAccountForOwner(
            connection, payer, reserve.reserve.liquidity.mintPubkey));
        wallets.set(
          reserve.reserve.collateral.mintPubkey.toBase58(),
          await findLargestTokenAccountForOwner(
            connection, payer, reserve.reserve.collateral.mintPubkey));
      }
    )
  )

  while (true) {
    try {

      const unhealthyObligations = await getUnhealthyObligations(connection, programId);
      console.log(`Time: ${new Date()} - payer account ${payer.publicKey.toBase58()}, we have ${unhealthyObligations.length} accounts for liquidation`)
      for (const unhealthyObligation of unhealthyObligations) {
        notify(
          `Liquidating obligation account ${unhealthyObligation.obligation.publicKey.toBase58()} which is owned by ${unhealthyObligation.obligation.owner.toBase58()}
           which has borrowed ${unhealthyObligation.obligation.borrowedValue} with liquidation borrowed value at ${unhealthyObligation.obligation.unhealthyBorrowValue} ...`)
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

async function getUnhealthyObligations(connection: Connection, programId: PublicKey) {
  const obligations = await getAllObligations(connection, programId)
  let solPrice = await getAssetPrice("SOL");
  const sortedObligations =  obligations
    .map(obligation => generateEnrichedObligation(obligation, solPrice))
    .sort(
      (obligation1, obligation2) => {
        return obligation2.riskFactor - obligation1.riskFactor;
      }
    );
  console.log(
    `Total number of obligations are: ${obligations.length},
     The highest risk factors are: ${sortedObligations.slice(0, DISPLAY_FIRST).map(obligation => obligation.riskFactor.toFixed(2))},
     Borrow amount: ${sortedObligations.slice(0, DISPLAY_FIRST).map(obligation => obligation.loanValue.toFixed(2))}
     Deposit value: ${sortedObligations.slice(0, DISPLAY_FIRST).map(obligation => obligation.collateralValue.toFixed(2))}
     Current SOL price is ${solPrice}`);
  return sortedObligations.filter(obligation => obligation.riskFactor >= 1);
}

// TODO: refactor this bit.
const SOL_RESERVE_PUBKEY = "X9ByyhmtQH3Wjku9N5obPy54DbVjZV7Z99TPJZ2rwcs";
const SOL_LIQUIDATION_THRESHOLD = 0.85;
const USDC_RESERVE_PUBKEY = "DcENuKuYd6BWGhKfGr7eARxodqG12Bz1sN5WA8NwvLRx";
const USDC_LIQUIDATION_THRESHOLD = 0.90;
const USDT_RESERVE_PUBKEY = "4tqY9Hv7e8YhNQXuH75WKrZ7tTckbv2GfFVxmVcScW5s";
const USDT_LIQUIDATION_THRESHOLD = 0.90;


function generateEnrichedObligation(obligation: Obligation, solPrice: number): EnrichedObligation {
  let loanValue = 0.0;
  const usdcPrice = 1;
  const usdtPrice = 1;

  for (const borrow of obligation.borrows) {
    if (borrow.borrowReserve.toBase58() === SOL_RESERVE_PUBKEY) {
      // SOL 9 decimals
      loanValue += lamportToNumber(wadToLamport(borrow.borrowedAmountWads), 9) * solPrice;
    } else if (borrow.borrowReserve.toBase58() === USDC_RESERVE_PUBKEY) {
      // USDC 6 decimals
      loanValue += lamportToNumber(wadToLamport(borrow.borrowedAmountWads), 6) * usdcPrice;
    } else if (borrow.borrowReserve.toBase58() === USDT_RESERVE_PUBKEY) {
      loanValue += lamportToNumber(wadToLamport(borrow.borrowedAmountWads), 6) * usdtPrice;
    }
  }

  let collateralValue = 0.0;
  for (const deposit of obligation.deposits) {
    if (deposit.depositReserve.toBase58() === SOL_RESERVE_PUBKEY) {
      collateralValue += lamportToNumber(deposit.depositedAmount, 9) * solPrice * SOL_LIQUIDATION_THRESHOLD;
    } else if (deposit.depositReserve.toBase58() === USDC_RESERVE_PUBKEY) {
      collateralValue += lamportToNumber(deposit.depositedAmount, 6) * usdcPrice * USDC_LIQUIDATION_THRESHOLD;
    } else if (deposit.depositReserve.toBase58() === USDT_RESERVE_PUBKEY) {
      collateralValue += lamportToNumber(deposit.depositedAmount, 6) * usdtPrice * USDT_LIQUIDATION_THRESHOLD;
    }
  }

  const riskFactor = (collateralValue === 0 || loanValue === 0) ? 0 : loanValue / collateralValue;

  return {
    loanValue,
    collateralValue,
    riskFactor,
    obligation
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
  parsedReserveMap.forEach(
    (reserve: EnrichedReserve) => {
      transaction.add(
        refreshReserveInstruction(
          reserve,
        )
      );
    }
  );

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

  signers.push(payer);
  const transferAuthority = repayReserve.reserve.liquidity.mintPubkey.toBase58() !== SOL_MINT ?
    liquidateByPayingToken(
      transaction,
      signers,
      wallets.get(repayReserve.reserve.liquidity.mintPubkey.toBase58())!.publicKey,
      wallets.get(withdrawReserve.reserve.collateral.mintPubkey.toBase58())!.publicKey,
      repayReserve,
      withdrawReserve,
      obligation,
      lendingMarket,
      lendingMarketAuthority,
      payer
    ) :
    liquidateByPayingSOL(
      transaction,
      signers,
      payerAccount!.lamports,
      wallets.get(repayReserve.reserve.liquidity.mintPubkey.toBase58())!.publicKey,
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
  transaction: Transaction,
  signers: Account[],
  solBalance: number,
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
        lamports: solBalance - 1_000_000_000,
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
    transaction,
    signers,
    wrappedSOLTokenAccount.publicKey,
    withdrawWallet,
    repayReserve,
    withdrawReserve,
    obligation,
    lendingMarket,
    lendingMarketAuthority,
    payer
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

function liquidateByPayingToken(
  transaction: Transaction,
  signers: Account[],
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
        1000000000000,
      ),
      liquidateObligationInstruction(
        // u64 MAX for all borrowed amount
        new BN('18446744073709551615', 10),
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

