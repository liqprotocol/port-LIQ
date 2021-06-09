import { Account, Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { homedir } from 'os';
import * as fs from 'fs';
import { getAllObligations, getParsedReservesMap, notify, sleep } from './utils';
import BN = require('bn.js');
import { Obligation, ObligationParser } from './layouts/obligation';
import { EnrichedReserve, Reserve, ReserveParser } from './layouts/reserve';
import { refreshReserveInstruction } from './instructions/refreshReserve';
import { refreshObligationInstruction } from './instructions/refreshObligation';
import { liquidateObligationInstruction } from './instructions/liquidateObligation';
import { AccountLayout, Token } from '@solana/spl-token';

async function runPartialLiquidator() {
  const cluster = process.env.CLUSTER || 'mainnet-beta'
  const clusterUrl = process.env.CLUSTER_URL || "https://api.devnet.solana.com"
  const checkInterval = parseFloat(process.env.CHECK_INTERVAL || "1000.0")
  const connection = new Connection(clusterUrl, 'singleGossip')

  // The address of the Port Finance on the blockchain
  const programId = new PublicKey(process.env.PROGRAM_ID || "3dQ9quWN8gjqRhrtaQhxGpKU2fLjCz4bAVuzmjms7Rxg")

  // liquidator's keypair
  const keyPairPath = process.env.KEYPAIR || homedir() + '/.config/solana/id.json'
  const payer = new Account(JSON.parse(fs.readFileSync(keyPairPath, 'utf-8')))

  console.log(`partial liquidator launched cluster=${cluster}`);

  const parsedReserveMap = await getParsedReservesMap(connection, programId);
  // console.log(parsedReserveMap);

  while (true) {
    try {

      const liquidatedAccounts = await getLiquidatedObligations(connection, programId);
      console.log(`payer account ${payer.publicKey.toBase58()}, we have ${liquidatedAccounts.length} accounts`)
      for (const liquidatedAccount of liquidatedAccounts) {
        console.log("liquidated...")
        await liquidateAccount(connection, programId, payer, liquidatedAccount, parsedReserveMap,);
      }

    } catch (e) {
      notify(`unknown error: ${e}`);
      console.error(e);
    } finally {
      await sleep(checkInterval)
    }
    break;
  }

}

async function liquidateAccount(connection: Connection, programId: PublicKey, payer: Account, obligation: Obligation, parsedReserveMap: Map<string, EnrichedReserve>) {
  // console.log(
  //   "liquidated account: ",
  //   obligation.publicKey.toBase58(),
  //   obligation.borrowedValue
  //     .sub(
  //       obligation.allowedBorrowValue)
  //     .div(
  //       new BN("1000000000000000000", 10)).toNumber() / 1000000);
  const accountRentExempt = await connection.getMinimumBalanceForRentExemption(
    AccountLayout.span,
  );
  const lendingMarket: PublicKey = parsedReserveMap.values().next().value.reserve.lendingMarket;
  const [lendingMarketAuthority] = await PublicKey.findProgramAddress(
    [lendingMarket.toBuffer()],
    programId,
  );
  const transaction = new Transaction();
  parsedReserveMap.forEach(
    (reserve: EnrichedReserve) => {
      transaction.add(
        refreshReserveInstruction(
          reserve.publicKey,
          programId,
          reserve.reserve.liquidity.oracleOption === 0 ?
            undefined : reserve.reserve.liquidity.oraclePubkey
        )
      );
    }
  );
  // TODO: choose a more sensible value
  const repayReserve:EnrichedReserve = parsedReserveMap[obligation.borrows[0].borrowReserve.toBase58()];
  const withdrawReserve:EnrichedReserve = parsedReserveMap[obligation.deposits[0].depositReserve.toBase58()];
  
  const transferAuthority = new Account();

  transaction.add(
    refreshObligationInstruction(
      obligation.publicKey,
      obligation.deposits.map(deposit => deposit.depositReserve),
      obligation.borrows.map(borrow => borrow.borrowReserve),
      programId
    ),
    // Token.createApproveInstruction(
    //   new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
    //   account,
    //   transferAuthority.publicKey,
    //   owner,
    //   [],
    //   1000000,
    // ),
    // liquidateObligationInstruction(
    //   new BN('18446744073709551615', 10),
    //   undefined,
    //   undefined,
    //   repayReserve.publicKey,
    //   repayReserve.reserve.liquidity.supplyPubkey,
    //   withdrawReserve.publicKey,
    //   withdrawReserve.reserve.collateral.supplyPubkey,
    //   liquidatedAccount.publicKey,
    //   lendingMarket,
    //   lendingMarketAuthority,
    //   undefined,
    //   programId,
    // )
  );
  connection.sendTransaction(
    transaction,
    [payer]
  );
}

async function getLiquidatedObligations(connection: Connection, programId: PublicKey) {
  const obligations = await getAllObligations(connection, programId)
  
  return obligations
    .filter(
      obligation => obligation.unhealthyBorrowValue.lt(obligation.borrowedValue)
    );
}

runPartialLiquidator()

