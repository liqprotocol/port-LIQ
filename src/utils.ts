import { Connection, PublicKey } from '@solana/web3.js';
import axios from 'axios';
import { Obligation, ObligationParser } from './layouts/obligation';
import { bits, blob, struct, u8, u32, nu64 } from 'buffer-layout';
import { EnrichedReserve, ReserveParser } from './layouts/reserve';

export const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

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

export async function findLargestTokenAccountForOwner(
  connection: Connection,
  owner: PublicKey,
  mint: PublicKey
): Promise<{ publicKey: PublicKey; tokenAccount: { mint: PublicKey; owner: PublicKey; amount: number} }> {

  const response = await connection.getTokenAccountsByOwner(owner, {mint}, connection.commitment)
  let max = -1;
  let maxTokenAccount: null | { mint: PublicKey; owner: PublicKey; amount: number} = null
  let maxPubkey: null | PublicKey = null
  for (const { pubkey, account } of response.value) {

    const tokenAccount = parseTokenAccountData(account.data)
    if (tokenAccount.amount > max) {
      maxTokenAccount = tokenAccount
      max = tokenAccount.amount
      maxPubkey = pubkey
    }
  }

  if (maxPubkey && maxTokenAccount) {
    return {publicKey: maxPubkey, tokenAccount: maxTokenAccount}
  } else {
    throw new Error("No accounts for this token")
  }
}

export const ACCOUNT_LAYOUT = struct([
  blob(32, 'mint'),
  blob(32, 'owner'),
  nu64('amount'),
  blob(93)
]);

export function parseTokenAccountData(
  data: Buffer,
): { mint: PublicKey; owner: PublicKey; amount: number } {
  let { mint, owner, amount } = ACCOUNT_LAYOUT.decode(data);
  return {
    mint: new PublicKey(mint),
    owner: new PublicKey(owner),
    amount,
  };
}