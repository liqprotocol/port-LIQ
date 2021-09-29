import { Account, Connection, PublicKey, Transaction } from "@solana/web3.js"
import { homedir } from 'os';
import * as fs from 'fs';
import { getAllObligations, notify, sleep } from "./utils";
import { Obligation } from "./layouts/obligation";
import { refreshReserveInstruction } from "./instructions/refreshReserve";
import { refreshObligationInstruction } from "./instructions/refreshObligation";
import BN from "bn.js";
import { ReserveContext } from "@port.finance/port-sdk/lib/models/ReserveContext";
import { ReserveInfo } from "@port.finance/port-sdk/lib/models/ReserveInfo";
import { Port } from "@port.finance/port-sdk";

async function refreshAllObligations() {
  const cluster = process.env.CLUSTER || 'devnet';
  const clusterUrl = process.env.CLUSTER_URL || "https://api.devnet.solana.com";
  const connection = new Connection(clusterUrl, 'singleGossip');
  const checkInterval = parseFloat(process.env.CHECK_INTERVAL || '300000.0');

  // The address of the Port Finance on the blockchain
  const programId = new PublicKey(process.env.PROGRAM_ID || "Port7uDYB3wk6GJAw4KT1WpTeMtSu9bTcChBHkX2LfR")

  // liquidator's keypair
  const keyPairPath = process.env.KEYPAIR || homedir() + '/.config/solana/id.json'
  const payer = new Account(JSON.parse(fs.readFileSync(keyPairPath, 'utf-8')))

  console.log(`refresh obligation bot launched for cluster=${cluster}`);

  const mainnetPort = Port.forMainNet()
  const reserveContext = await mainnetPort.getReserveContext()

  while(true) {
    try {
      const obligations = await getAllObligations(connection, programId);
      const nonEmptyBorrowedObligations = obligations.filter(obligation => obligation.borrowedValue.gt(new BN(0)));
      console.log("Total obligations that needs to be refreshed ", nonEmptyBorrowedObligations.length);
      let counter: number = 0;
      const totalObligationsCnt: number = nonEmptyBorrowedObligations.length;
      console.log("public key: ", payer.publicKey.toBase58())
      while(counter < totalObligationsCnt) {
        const batchRefreshCnt = 10;
        let nextCounter = Math.min(counter + batchRefreshCnt, totalObligationsCnt);
        await refreshObligations(connection, payer, nonEmptyBorrowedObligations.slice(counter, nextCounter), reserveContext);
        counter = nextCounter;
        if (counter % 300 === 0) {
          console.log("Completed refreshing %d obligations", counter);
        }
        sleep(2000);
      }
      console.log("Completed refreshing obligation.")
    } catch (e) {
      notify(`unknown error: ${e}`);
      console.error(e);
    } finally {
      await sleep(checkInterval);
    }
  }

}

async function refreshObligations(connection: Connection, payer: Account, obligations: Obligation[], allReserve: ReserveContext) {
  const transaction = new Transaction();
  allReserve.getAllReserves().forEach(
    (reserve: ReserveInfo) => {
      transaction.add(
        refreshReserveInstruction(
          reserve,
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
      ),
    );
  }
  try {
    await connection.sendTransaction(
      transaction,
      [payer]
    );
  } catch(e) {
    console.error("Error sending refresh transaction: ", e)
  }
}

refreshAllObligations()