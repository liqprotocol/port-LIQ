import { Account, Connection, PublicKey, Transaction } from "@solana/web3.js"
import { homedir } from 'os';
import * as fs from 'fs';
import { getAllObligations, getParsedReservesMap, sleep } from "./utils";
import { Obligation } from "./layouts/obligation";
import { EnrichedReserve } from "./layouts/reserve";
import { refreshReserveInstruction } from "./instructions/refreshReserve";
import { refreshObligationInstruction } from "./instructions/refreshObligation";

async function refreshAllObligations() {
  const cluster = process.env.CLUSTER || 'mainnet-beta'
  const clusterUrl = process.env.CLUSTER_URL || "https://api.devnet.solana.com"
  const connection = new Connection(clusterUrl, 'singleGossip')

  // The address of the Port Finance on the blockchain
  const programId = new PublicKey(process.env.PROGRAM_ID || "3dQ9quWN8gjqRhrtaQhxGpKU2fLjCz4bAVuzmjms7Rxg")

  // liquidator's keypair
  const keyPairPath = process.env.KEYPAIR || homedir() + '/.config/solana/id.json'
  const payer = new Account(JSON.parse(fs.readFileSync(keyPairPath, 'utf-8')))

  console.log(`refresh obligation bot launched for cluster=${cluster}`);

  const parsedReserveMap = await getParsedReservesMap(connection, programId);
  const obligations = await getAllObligations(connection, programId);
  console.log("Total obligations that needs to be refreshed ", obligations.length);
  let counter: number = 0;
  const totalObligationsCnt: number = obligations.length;
  console.log("public key: ", payer.publicKey.toBase58())
  while(counter < totalObligationsCnt) {
    let nextCounter = Math.min(counter + 20, totalObligationsCnt);
    await refreshObligations(connection, programId, payer, obligations.slice(counter, nextCounter), parsedReserveMap);
    counter = nextCounter;
    if (counter % 500 === 0) {
      console.log("Completed refreshing %d obligations", counter);
    }
    sleep(2000);
  }

}

async function refreshObligations(connection: Connection, programId: PublicKey, payer: Account, obligations: Obligation[], allReserve: Map<string, EnrichedReserve>) {
  const transaction = new Transaction();
  allReserve.forEach(
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
  
  for (const obligation of obligations) {
    transaction.add(
      refreshObligationInstruction(
        obligation.publicKey,
        obligation.deposits.map(deposit => deposit.depositReserve),
        obligation.borrows.map(borrow => borrow.borrowReserve),
        programId
      ),
    );
  }
  try {
    await connection.sendTransaction(
      transaction,
      [payer]
    );
  } catch {
    console.error("Error sending refresh transaction")
  }
}

refreshAllObligations()