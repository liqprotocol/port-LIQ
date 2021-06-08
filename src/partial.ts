import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { homedir } from 'os';
import * as fs from 'fs';
import { notify, sleep } from './utils';
import BN = require('bn.js');
import { Obligation, ObligationParser } from './obligation';
import { EnrichedReserve, ReserveParser } from './reserve';

async function runPartialLiquidator() {
  const cluster = process.env.CLUSTER || 'mainnet-beta'
  const clusterUrl = process.env.CLUSTER_URL || "https://api.devnet.solana.com"
  const checkInterval = parseFloat(process.env.CHECK_INTERVAL || "1000.0")
  const connection = new Connection(clusterUrl, 'singleGossip')

  // The address of the Port Finance on the blockchain
  const programId = new PublicKey(process.env.PROGRAM_ID || "3dQ9quWN8gjqRhrtaQhxGpKU2fLjCz4bAVuzmjms7Rxg")

  // liquidator's keypair
  const keyPairPath = process.env.KEYPAIR || homedir() + '/.config/solana/id.json'
  const payer = new Keypair(JSON.parse(fs.readFileSync(keyPairPath, 'utf-8')))

  console.log(`partial liquidator launched cluster=${cluster}`);

  const parsedReserveMap = await getParsedReservesMap(connection, programId);
  console.log(parsedReserveMap);

  while (true) {
    try {

      const liquidatedAccounts = await getLiquidatedObligations(connection, programId);
      
      for (const liquidatedAccount of liquidatedAccounts) {
        console.log(
          "liquidated account: ", 
          liquidatedAccount.publicKey.toBase58(), 
          liquidatedAccount.borrowedValue
          .sub(
            liquidatedAccount.allowedBorrowValue)
          .div(
            new BN("1000000000000000000", 10)).toNumber() / 1000000);
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

async function getLiquidatedObligations(connection: Connection, programId: PublicKey) {
  const obligations = await connection.getProgramAccounts(
    programId,
    {
      filters: [
        {
          dataSize: 916,
        }
      ]
    }
  )
  
  console.log("length: ", obligations.length);
  const parsedObligations: Obligation[] = [];
  
  for (const obligation of obligations) {
    const parsedObligation = ObligationParser(
      obligation.pubkey,
      obligation.account,
    )
    if (parsedObligation === undefined) {
      continue;
    }
    parsedObligations.push(parsedObligation);
  }
  
  return parsedObligations
    .filter(
      obligation => obligation.allowedBorrowValue.lt(obligation.borrowedValue)
    )

}

async function getParsedReservesMap(connection: Connection, programId: PublicKey) {
    const allReserves = await connection.getProgramAccounts(
      programId,
      {
        filters: [
          {
            // TODO: change this part when upgrade to Pyth.
            dataSize: 567,
          }
        ]
      }
    )
    
    const parsedReserves: Map<string, EnrichedReserve> = new Map();
    for (const reserve of allReserves) {
      const parsedReserve = ReserveParser(
        reserve.pubkey,
        reserve.account
      )
      if (parsedReserve === undefined) {
        continue;
      }
      parsedReserves.set(
        parsedReserve.publicKey.toBase58(),
        parsedReserve
      )
    }
    return parsedReserves;
}

runPartialLiquidator()

