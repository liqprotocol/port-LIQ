import { Connection, PublicKey, Account, SystemProgram, Transaction } from '@solana/web3.js';
import axios from 'axios';
import { Obligation, ObligationParser } from './layouts/obligation';
import { bits, blob, struct, u8, u32, nu64 } from 'buffer-layout';
import { EnrichedReserve, ReserveParser } from './layouts/reserve';
import { AccountLayout, Token } from '@solana/spl-token';
import { TransactionInstruction } from '@solana/web3.js';
import { ATOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from './ids';
import BN from 'bn.js';

export const STAKING_PROGRAM_ID = new PublicKey("stkarvwmSzv2BygN5e2LeTwimTczLWHCKPKGC2zVLiq");
export const ZERO = new BN(0);
export const TEN = new BN(10);
export const WAD = TEN.pow(new BN(18));

export function notify(content: string) {
  if (process.env.WEBHOOK_URL) {
    axios.post(
      process.env.WEBHOOK_URL,
      {"text": content}
    );
  }
  console.log(content)
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
        },
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
          dataSize: 575,
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
  owner: Account,
  mint: PublicKey
): Promise<{ publicKey: PublicKey; tokenAccount: Wallet }> {

  const response = await connection.getTokenAccountsByOwner(owner.publicKey, {mint}, connection.commitment)
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
    console.log("creating new token account")
    const transaction = new Transaction();
    const aTokenAccountPubkey = (await PublicKey.findProgramAddress(
      [
          owner.publicKey.toBuffer(),
          TOKEN_PROGRAM_ID.toBuffer(),
          mint.toBuffer(),
      ],
      ATOKEN_PROGRAM_ID
    ))[0];

    transaction.add(
      Token.createAssociatedTokenAccountInstruction(
        ATOKEN_PROGRAM_ID,
        TOKEN_PROGRAM_ID,
        mint,
        aTokenAccountPubkey,
        owner.publicKey,
        owner.publicKey
      )
    )
    await connection.sendTransaction(transaction, [owner])
    return {publicKey: aTokenAccountPubkey, tokenAccount: {mint, amount: 0, owner: owner.publicKey}}
  }
}

export const ACCOUNT_LAYOUT = struct([
  blob(32, 'mint'),
  blob(32, 'owner'),
  nu64('amount'),
  blob(93)
]);

export function createTokenAccount(
  instructions: TransactionInstruction[],
  payer: PublicKey,
  accountRentExempt: number,
  mint: PublicKey,
  owner: PublicKey,
  signers: Account[],
) {
  const account = createUninitializedAccount(
    instructions,
    payer,
    accountRentExempt,
    signers,
  );

  instructions.push(
    Token.createInitAccountInstruction(new PublicKey(TOKEN_PROGRAM_ID), mint, account, owner),
  );

  return account;
}

export function createUninitializedAccount(
  instructions: TransactionInstruction[],
  payer: PublicKey,
  amount: number,
  signers: Account[],
) {
  const account = new Account();
  instructions.push(
    SystemProgram.createAccount({
      fromPubkey: payer,
      newAccountPubkey: account.publicKey,
      lamports: amount,
      space: AccountLayout.span,
      programId: new PublicKey(TOKEN_PROGRAM_ID),
    }),
  );

  signers.push(account);

  return account.publicKey;
}

export function wadToNumber(wad: BN, precision: number = 4): number {
  return wad.div(WAD.div(TEN.pow(new BN(precision)))).toNumber() / Math.pow(10, precision)
}

export function wadToBN(wad: BN): BN {
  return wad.div(WAD);
}

export function scaleToNormalNumber(lamport: BN, scaleDecimal: number, precision = 4): number {
  if (scaleDecimal < precision) {
    throw new Error(`Scale decimal ${scaleDecimal} is smaller than ${precision}`);
  }
  return lamport.div(TEN.pow(new BN(scaleDecimal - precision))).toNumber() / Math.pow(10, precision);
}

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

export interface Wallet {
  mint: PublicKey,
  owner: PublicKey,
  amount: number,
}
