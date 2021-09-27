import { AccountInfo, PublicKey } from '@solana/web3.js';
import * as BufferLayout from 'buffer-layout';
import * as Layout from './layout';
import { LastUpdate } from './lastUpdate';
import Big from 'big.js';

export const ObligationLayout: typeof BufferLayout.Structure = BufferLayout.struct(
  [
    BufferLayout.u8('version'),

    BufferLayout.struct(
      [Layout.uint64('slot'), BufferLayout.u8('stale')],
      'lastUpdate',
    ),

    Layout.publicKey('lendingMarket'),
    Layout.publicKey('owner'),
    Layout.uint128('depositedValue'),
    Layout.uint128('borrowedValue'),
    Layout.uint128('allowedBorrowValue'),
    Layout.uint128('unhealthyBorrowValue'),

    BufferLayout.u8('depositsLen'),
    BufferLayout.u8('borrowsLen'),
    BufferLayout.blob(776, 'dataFlat'),
  ],
);

export const ObligationCollateralLayout: typeof BufferLayout.Structure = BufferLayout.struct(
  [
    Layout.publicKey('depositReserve'),
    Layout.uint64('depositedAmount'),
    Layout.uint128('marketValue'),
  ],
);

export const ObligationLiquidityLayout: typeof BufferLayout.Structure = BufferLayout.struct(
  [
    Layout.publicKey('borrowReserve'),
    Layout.uint128('cumulativeBorrowRateWads'),
    Layout.uint128('borrowedAmountWads'),
    Layout.uint128('marketValue'),
  ],
);

export const isObligation = (info: AccountInfo<Buffer>) => {
  return info.data.length === ObligationLayout.span;
};

export interface ProtoObligation {
  version: number;
  lastUpdate: LastUpdate;
  lendingMarket: PublicKey;
  owner: PublicKey;
  depositedValue: Big; // decimals
  borrowedValue: Big; // decimals
  allowedBorrowValue: Big; // decimals
  unhealthyBorrowValue: Big; // decimals
  depositsLen: number;
  borrowsLen: number;
  dataFlat: Buffer;
}

export interface EnrichedObligation {
  riskFactor: number;
  // loan value in USD
  loanValue: Big;
  // collateral value in USD
  collateralValue: Big;
  obligation: Obligation;
  borrowedAssetNames: string[];
  depositedAssetNames: string[];
}

export interface Obligation {
  publicKey: PublicKey;
  version: number;
  lastUpdate: LastUpdate;
  lendingMarket: PublicKey;
  owner: PublicKey;
  deposits: ObligationCollateral[];
  borrows: ObligationLiquidity[];
  depositedValue: Big; // decimals
  borrowedValue: Big; // decimals
  allowedBorrowValue: Big; // decimals
  unhealthyBorrowValue: Big; // decimals
}

export interface ObligationCollateral {
  depositReserve: PublicKey;
  depositedAmount: Big;
  marketValue: Big; // decimals
}

export interface ObligationLiquidity {
  borrowReserve: PublicKey;
  cumulativeBorrowRateWads: Big; // decimals
  borrowedAmountWads: Big; // decimals
  marketValue: Big; // decimals
}

export const ObligationParser = (
  pubkey: PublicKey,
  info: AccountInfo<Buffer>,
) => {
  const buffer = Buffer.from(info.data);
  const {
    version,
    lastUpdate,
    lendingMarket,
    owner,
    depositedValue,
    borrowedValue,
    allowedBorrowValue,
    unhealthyBorrowValue,
    depositsLen,
    borrowsLen,
    dataFlat,
  } = ObligationLayout.decode(buffer) as ProtoObligation;

  if (lastUpdate.slot.eq(new Big(0))) {
    return;
  }

  const depositsBuffer = dataFlat.slice(
    0,
    depositsLen * ObligationCollateralLayout.span,
  );
  const deposits = BufferLayout.seq(
    ObligationCollateralLayout,
    depositsLen,
  ).decode(depositsBuffer) as ObligationCollateral[];

  const borrowsBuffer = dataFlat.slice(
    depositsBuffer.length,
    depositsBuffer.length + borrowsLen * ObligationLiquidityLayout.span,
  );
  const borrows = BufferLayout.seq(
    ObligationLiquidityLayout,
    borrowsLen,
  ).decode(borrowsBuffer) as ObligationLiquidity[];

  return {
    publicKey: pubkey,
    version,
    lastUpdate,
    lendingMarket,
    owner,
    depositedValue,
    borrowedValue,
    allowedBorrowValue,
    unhealthyBorrowValue,
    deposits,
    borrows,
  } as Obligation;
};