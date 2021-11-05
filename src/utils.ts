import {
  Connection,
  PublicKey,
  SystemProgram,
  Keypair,
  Transaction,
} from '@solana/web3.js';
import axios from 'axios';
import { AccountInfo, AccountLayout, Token } from '@solana/spl-token';
import { TransactionInstruction } from '@solana/web3.js';
import { ATOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from './ids';
import Big from 'big.js';
import { AccountInfo as TokenAccount } from '@solana/spl-token';
import { getTokenAccount, parseTokenAccount } from '@project-serum/common';
import { BN, Provider } from '@project-serum/anchor';


export const STAKING_PROGRAM_ID = new PublicKey(
  'stkarvwmSzv2BygN5e2LeTwimTczLWHCKPKGC2zVLiq',
);
export const ZERO: Big = new Big(0);

export function notify(content: string) {
  if (process.env.WEBHOOK_URL) {
    axios.post(process.env.WEBHOOK_URL, { text: content });
  }
  console.log(content);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const getUnixTs = () => {
  return new Date().getTime() / 1000;
};

export async function findLargestTokenAccountForOwner(
  connection: Connection,
  owner: Keypair,
  mint: PublicKey,
): Promise<TokenAccount> {
  const response = await connection.getTokenAccountsByOwner(
    owner.publicKey,
    { mint },
    connection.commitment,
  );
  let max = new BN(0);
  let maxTokenAccount: TokenAccount | null = null;
  let maxPubkey: null | PublicKey = null;

  for (const { pubkey, account } of response.value) {
    const tokenAccount = parseTokenAccount(account.data);
    if (tokenAccount.amount.gt(max) ) {
      maxTokenAccount = tokenAccount;
      max = tokenAccount.amount;
      maxPubkey = pubkey;
    }
  }

  if (maxPubkey && maxTokenAccount) {
    return maxTokenAccount;
  } else {
    console.log('creating new token account');
    const transaction = new Transaction();
    const aTokenAccountPubkey = (
      await PublicKey.findProgramAddress(
        [
          owner.publicKey.toBuffer(),
          TOKEN_PROGRAM_ID.toBuffer(),
          mint.toBuffer(),
        ],
        ATOKEN_PROGRAM_ID,
      )
    )[0];

    transaction.add(
      Token.createAssociatedTokenAccountInstruction(
        ATOKEN_PROGRAM_ID,
        TOKEN_PROGRAM_ID,
        mint,
        aTokenAccountPubkey,
        owner.publicKey,
        owner.publicKey,
      ),
    );
    await connection.sendTransaction(transaction, [owner]);
    return {
      address: aTokenAccountPubkey,
      owner: owner.publicKey,
      mint
    } as TokenAccount;
  }
}

export function createTokenAccount(
  instructions: TransactionInstruction[],
  payer: PublicKey,
  accountRentExempt: number,
  mint: PublicKey,
  owner: PublicKey,
  signers: Keypair[],
) {
  const account = createUninitializedAccount(
    instructions,
    payer,
    accountRentExempt,
    signers,
  );

  instructions.push(
    Token.createInitAccountInstruction(
      new PublicKey(TOKEN_PROGRAM_ID),
      mint,
      account,
      owner,
    ),
  );

  return account;
}

export function createUninitializedAccount(
  instructions: TransactionInstruction[],
  payer: PublicKey,
  amount: number,
  signers: Keypair[],
) {
  const account = Keypair.generate();
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

export async function getOwnedTokenAccounts(
  connection: Connection,
  publicKey: PublicKey,
): Promise<TokenAccount[]> {
  const accounts = await connection.getProgramAccounts(
    TOKEN_PROGRAM_ID,
    {
      filters: [
        {
          memcmp: {
            offset: AccountLayout.offsetOf('owner'),
            bytes: publicKey.toBase58(),
          }
        }, 
        {
          dataSize: AccountLayout.span,
        }
      ]
    }
  );
  return (
    accounts
      .map(r => {
        const tokenAccount = parseTokenAccount(r.account.data);
        tokenAccount.address = r.pubkey;
        return tokenAccount;
      })
  );
}

export async function fetchTokenAccount(provider: Provider, address: PublicKey): Promise<AccountInfo> {
  const tokenAccount = await getTokenAccount(provider, address);
  tokenAccount.address = address;
  return tokenAccount;
}
