import { Account, Connection, PublicKey, Transaction } from '@solana/web3.js';
import { homedir } from 'os';
import * as fs from 'fs';
import { findLargestTokenAccountForOwner, getAllObligations, getParsedReservesMap, notify, sleep, Wallet } from './utils';
import BN = require('bn.js');
import { Obligation } from './layouts/obligation';
import { EnrichedReserve} from './layouts/reserve';
import { refreshReserveInstruction } from './instructions/refreshReserve';
import { refreshObligationInstruction } from './instructions/refreshObligation';
import { liquidateObligationInstruction } from './instructions/liquidateObligation';
import { Token, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { redeemReserveCollateralInstruction } from './instructions/redeemReserveCollateral';

async function runPartialLiquidator() {
  const cluster = process.env.CLUSTER || 'devnet'
  const clusterUrl = process.env.CLUSTER_URL || "https://api.devnet.solana.com"
  const checkInterval = parseFloat(process.env.CHECK_INTERVAL || "1000.0")
  const connection = new Connection(clusterUrl, 'singleGossip')

  // The address of the Port Finance on the blockchain
  const programId = new PublicKey(process.env.PROGRAM_ID || "Port7uDYB3wk6GJAw4KT1WpTeMtSu9bTcChBHkX2LfR")

  // liquidator's keypair
  const keyPairPath = process.env.KEYPAIR || homedir() + '/.config/solana/id.json'
  const payer = new Account(JSON.parse(fs.readFileSync(keyPairPath, 'utf-8')))

  console.log(`partial liquidator launched cluster=${cluster}`);

  const parsedReserveMap = await getParsedReservesMap(connection, programId);
  const wallets: Map<string, { publicKey: PublicKey; tokenAccount: Wallet }> = new Map();
  const reserves:EnrichedReserve[] = [];
  parsedReserveMap.forEach(
    (reserve) => reserves.push(reserve)
  );
  const liquidityWallets = await Promise.all(
    reserves.map(
      reserve => findLargestTokenAccountForOwner(connection, payer, reserve.reserve.liquidity.mintPubkey)
    )
  );
  const collateralWallets = await Promise.all(
    reserves.map(
      reserve => findLargestTokenAccountForOwner(connection, payer, reserve.reserve.collateral.mintPubkey)
    )
  );
  for (let i = 0; i < reserves.length; i++) {
    wallets.set(reserves[i].reserve.liquidity.mintPubkey.toBase58(), liquidityWallets[i]);
    wallets.set(reserves[i].reserve.collateral.mintPubkey.toBase58(), collateralWallets[i]);
  }

  while (true) {
    try {

      const liquidatedAccounts = await getLiquidatedObligations(connection, programId);
      console.log(`payer account ${payer.publicKey.toBase58()}, we have ${liquidatedAccounts.length} accounts for liquidation`)
      for (const liquidatedAccount of liquidatedAccounts) {
        notify(
          `Liquidating obligation account ${liquidatedAccount.publicKey.toBase58()} which is owned by ${liquidatedAccount.owner.toBase58()}
           which has borrowed ${liquidatedAccount.borrowedValue} with liquidation borrowed value at ${liquidatedAccount.unhealthyBorrowValue} ...`)
        await liquidateAccount(connection, programId, payer, liquidatedAccount, parsedReserveMap, wallets);
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

async function liquidateAccount(connection: Connection, programId: PublicKey, payer: Account, obligation: Obligation, parsedReserveMap: Map<string, EnrichedReserve>, wallets: Map<string, { publicKey: PublicKey; tokenAccount: Wallet }>) {
  const lendingMarket: PublicKey = parsedReserveMap.values().next().value.reserve.lendingMarket;
  const [lendingMarketAuthority] = await PublicKey.findProgramAddress(
    [lendingMarket.toBuffer()],
    programId,
  );
  let transaction = new Transaction();
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
  
  const transferAuthority = new Account();
  
  if (!repayReserve || !withdrawReserve) {
    return;
  }

  if (repayReserve.reserve.liquidity.mintPubkey.toBase58() != "So11111111111111111111111111111111111111112" && (
      !wallets.has(repayReserve.reserve.liquidity.mintPubkey.toBase58()) ||
            !wallets.has(withdrawReserve.reserve.collateral.mintPubkey.toBase58()))) {
    return;
  }
  
  transaction.add(
    refreshObligationInstruction(
      obligation.publicKey,
      obligation.deposits.map(deposit => deposit.depositReserve),
      obligation.borrows.map(borrow => borrow.borrowReserve),
    ),
    Token.createApproveInstruction(
      TOKEN_PROGRAM_ID,
      wallets.get(repayReserve.reserve.liquidity.mintPubkey.toBase58())!.publicKey,
      transferAuthority.publicKey,
      payer.publicKey,
      [],
      1000000000000,
    ),
    liquidateObligationInstruction(
      // u64 MAX for all borrowed amount
      new BN('18446744073709551615', 10),
      wallets.get(repayReserve.reserve.liquidity.mintPubkey.toBase58())!.publicKey,
      wallets.get(withdrawReserve.reserve.collateral.mintPubkey.toBase58())!.publicKey!,
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
  const sig = await connection.sendTransaction(
    transaction,
    [payer, transferAuthority],
  );
  console.log(`liqudiation transaction sent: ${sig}.`)

  const tokenwallet = await findLargestTokenAccountForOwner(connection, payer, withdrawReserve.reserve.collateral.mintPubkey);

  await redeemCollateral(wallets, withdrawReserve, transferAuthority, payer, tokenwallet, lendingMarketAuthority, connection);

}

async function redeemCollateral(wallets: Map<string, { publicKey: PublicKey; tokenAccount: Wallet; }>, withdrawReserve: EnrichedReserve, transferAuthority: Account, payer: Account, tokenwallet: { publicKey: PublicKey; tokenAccount: Wallet; }, lendingMarketAuthority: PublicKey, connection: Connection) {
  const transaction = new Transaction();
  transaction.add(
    Token.createApproveInstruction(
      TOKEN_PROGRAM_ID,
      wallets.get(withdrawReserve.reserve.collateral.mintPubkey.toBase58())!.publicKey,
      transferAuthority.publicKey,
      payer.publicKey,
      [],
      1000000000000
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
  // TODO: repay SOL
}

async function repaySOL() {
  // TODO
}

async function repayToken() {
  // TODO
}

async function getLiquidatedObligations(connection: Connection, programId: PublicKey) {
  const obligations = await getAllObligations(connection, programId)
  
  return obligations
    .filter(
      obligation => obligation.unhealthyBorrowValue.lt(obligation.borrowedValue)
    );
}

runPartialLiquidator()

