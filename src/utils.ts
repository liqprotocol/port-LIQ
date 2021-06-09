import { Connection, PublicKey } from '@solana/web3.js';
import axios from 'axios';
import { Obligation, ObligationParser } from './layouts/obligation';
import { EnrichedReserve, ReserveParser } from './layouts/reserve';


export function notify(content) {
  if (process.env.WEBHOOK_URL) {
    axios.post(process.env.WEBHOOK_URL, {content});
  }
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export const getUnixTs = () => {
  return new Date().getTime() / 1000;
}

export async function getAllObligations(connection: Connection, programId: PublicKey): Promise<Obligation[]> {
  const rawObligationAccounts = await connection.getProgramAccounts(
    programId,
    {
      filters: [
        {
          dataSize: 916,
        }
      ]
    }
  );

  const parsedObligations: Obligation[] = [];
  
  for (const rawObligationAccount of rawObligationAccounts) {
    const parsedObligation = ObligationParser(
      rawObligationAccount.pubkey,
      rawObligationAccount.account,
    )
    if (parsedObligation === undefined) {
      continue;
    }
    parsedObligations.push(parsedObligation);
  }
  return parsedObligations
}

export async function getParsedReservesMap(connection: Connection, programId: PublicKey) {
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