import {
  Keypair,
  Connection,
  PublicKey,
  SystemProgram,
  AccountInfo,
  TransactionInstruction,
} from '@solana/web3.js';
import { homedir } from 'os';
import * as fs from 'fs';
import {
  createAssociatedTokenAccount,
  defaultTokenAccount,
  fetchTokenAccount,
  getOwnedTokenAccounts,
  notify,
  sendTransaction,
  sleep,
  STAKING_PROGRAM_ID,
  ZERO,
} from './utils';
import { AccountLayout, Token, TOKEN_PROGRAM_ID, u64 } from '@solana/spl-token';
import { parsePriceData } from '@pythnetwork/client';
import Big from 'big.js';
import {SwitchboardAccountType} from '@switchboard-xyz/switchboard-api';
import { AccountInfo as TokenAccount } from '@solana/spl-token';
import { Provider, Wallet } from '@project-serum/anchor';
import {liquidateObligationInstruction, Port, Profile, redeemReserveCollateralInstruction, refreshObligationInstruction, refreshReserveInstruction, ReserveContext, ReserveId, ReserveInfo} from '@port.finance/port-sdk'
import { PortBalance } from '@port.finance/port-sdk/dist/cjs/models/PortBalance';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const DISPLAY_FIRST = 10;

const portProfile = Profile.forMainNet();

interface EnrichedObligation {
  riskFactor: number;
  // loan value in USD
  loanValue: Big;
  // collateral value in USD
  collateralValue: Big;
  obligation: PortBalance;
  borrowedAssetNames: string[];
  depositedAssetNames: string[];
}

async function runLiquidator() {
  const clusterUrl =
    process.env.CLUSTER_URL || 'https://api.mainnet-beta.solana.com';
  const checkInterval = parseFloat(process.env.CHECK_INTERVAL || '8000.0');
  const connection = new Connection(clusterUrl, 'singleGossip');

  // The address of the Port Finance on the blockchain
  const programId = new PublicKey(
    process.env.PROGRAM_ID || 'Port7uDYB3wk6GJAw4KT1WpTeMtSu9bTcChBHkX2LfR',
  );

  // liquidator's keypair
  const keyPairPath =
    process.env.KEYPAIR || `${homedir()}/.config/solana/id.json`;
  const payer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(keyPairPath, 'utf-8'))),
  );
  const provider = new Provider(connection, new Wallet(payer), {
    preflightCommitment: "recent",
    commitment: "recent",
  })

  console.log(`Port liquidator launched on cluster=${clusterUrl}`);

  const reserveContext = await Port.forMainNet({}).getReserveContext();

  const wallets = await prepareTokenAccounts(provider, reserveContext);

  // eslint-disable-next-line
  while (true) {
    try {
      const unhealthyObligations = await getUnhealthyObligations(connection);
      console.log(
        `Time: ${new Date()} - payer account ${payer.publicKey.toBase58()}, we have ${
          unhealthyObligations.length
        } accounts for liquidation`,
      );
      for (const unhealthyObligation of unhealthyObligations) {
        notify(
          `Liquidating obligation account ${unhealthyObligation.obligation
            .getPortId()
            .toString()} which is owned by ${unhealthyObligation.obligation.owner.toBase58()} with risk factor: ${
            unhealthyObligation.riskFactor
          }
which has borrowed ${unhealthyObligation.loanValue} ...
`,
        );
        await liquidateUnhealthyObligation(
          provider,
          programId,
          unhealthyObligation,
          reserveContext,
          wallets,
        );

        await redeemRemainingCollaterals(
          provider,
          programId,
          reserveContext,
          wallets
        );
      }
    } catch (e) {
      notify(`unknown error: ${e}`);
      console.error('error: ', e);
    } finally {
      await sleep(checkInterval);
    }
    // break;
  }
}

async function prepareTokenAccounts(provider: Provider, reserveContext: ReserveContext): Promise<Map<string, TokenAccount>> {
  const wallets: Map<string, TokenAccount> = new Map<string, TokenAccount>();

  const tokenAccounts = await getOwnedTokenAccounts(provider);
  for (const tokenAccount of tokenAccounts) {
    wallets.set(
      tokenAccount.mint.toString(),
      tokenAccount
    )
  }

  const mintIds: PublicKey[] = reserveContext.getAllReserves().flatMap((reserve) => [reserve.getAssetId().key, reserve.getShareId().key]);

  for (const mintId of mintIds) {
    if (!wallets.has(mintId.toString())) {
      const aTokenAddress = await createAssociatedTokenAccount(
        provider,
        mintId
      );
      wallets.set(
        mintId.toString(),
        defaultTokenAccount(
          aTokenAddress, provider.wallet.publicKey, mintId));
    }
  }

  return wallets;
}

async function redeemRemainingCollaterals(
  provider: Provider,
  programId: PublicKey,
  reserveContext: ReserveContext,
  wallets: Map<string, TokenAccount>,
) {
  const lendingMarket: PublicKey = reserveContext
    .getAllReserves()[0]
    .getMarketId().key;
  reserveContext.getAllReserves().forEach(async (reserve) => {
    const [lendingMarketAuthority] = await PublicKey.findProgramAddress(
      [lendingMarket.toBuffer()],
      programId,
    );
    const collateralWalletPubkey = wallets.get(reserve.getShareId().key.toString());
    if (!collateralWalletPubkey) {
      throw new Error(`No collateral wallet for ${reserve.getShareId().key.toString()}`)
    }

    try {
      const collateralWallet = await fetchTokenAccount(
        provider,
        collateralWalletPubkey.address
      );
      wallets.set(reserve.getShareId().key.toString(), collateralWallet);
      if (!collateralWallet.amount.isZero()) {
        await redeemCollateral(
          provider,
          wallets,
          reserve,
          lendingMarketAuthority,
        );
      }
    } catch (e) {
      console.log(e)
    }

  });
}

async function readSymbolPrice(
  connection: Connection,
  reserve: ReserveInfo,
): Promise<Big> {
  const oracleId = reserve.getOracleId();
  if (oracleId) {
    const oracleData = await connection.getAccountInfo(oracleId.key);
    if (!oracleData) {
      throw new Error('cannot fetch account oracle data')
    }
    return parseOracleData(oracleData, reserve);
  }

  return reserve.getMarkPrice().getRaw();

}

const PYTH_PROGRAM = 'FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH';
const SWITCH_BOARD_PROGRAM = 'DtmE9D2CSB4L5D6A15mraeEjrGMm6auWVzgaD8hK2tZM';
function parseOracleData(accountInfo: AccountInfo<Buffer>, reserveInfo: ReserveInfo): Big {
  if (accountInfo.owner.toString() === PYTH_PROGRAM) {
    const parsedPythData = parsePriceData(accountInfo.data);
    return new Big(parsedPythData.price);
  }

  // TODO: this is not actually parsing switchboard key, it's a temporary work around since I don't
  // know how to do it properly.
  if (accountInfo.owner.toString() === SWITCH_BOARD_PROGRAM) {

    if (accountInfo.data[0] === SwitchboardAccountType.TYPE_AGGREGATOR_RESULT_PARSE_OPTIMIZED) {
      return reserveInfo.getMarkPrice().getRaw();
    }
  }

  throw Error('Unrecognized oracle account')
}

async function readTokenPrices(
  connection: Connection,
  reserveContext: ReserveContext,
): Promise<Map<string, Big>> {
  const tokenToCurrentPrice = new Map();

  for (const reserve of reserveContext.getAllReserves()) {
    tokenToCurrentPrice.set(
      reserve.getReserveId().toString(),
      await readSymbolPrice(connection, reserve),
    );
  }
  return tokenToCurrentPrice;
}

function willNeverLiquidate(obligation: PortBalance): boolean {
  const loans = obligation.getLoans();
  const collaterals = obligation.getCollaterals();
  return (
    loans.length === 1 &&
    collaterals.length === 1 &&
    loans[0].getReserveId().toString() ===
      collaterals[0].getReserveId().toString()
  );
}

function isInsolvent(obligation: PortBalance): boolean {
  return (
    obligation.getLoans().length > 0 && obligation.getCollaterals().length === 0
  );
}

function isNoBorrow(obligation: PortBalance): boolean {
  return obligation.getLoans().length === 0;
}

// eslint-disable-next-line
function getTotalShareTokenCollateralized(
  portBalances: PortBalance[],
): Map<string, Big> {
  const amounts = new Map();
  amounts.set('total_amount', new Big(0));

  portBalances.forEach((balance) => {
    amounts.set(
      'total_amount',
      amounts.get('total_amount').add(balance.getDepositedValue()),
    );
    balance.getCollaterals().forEach((collateral) => {
      const reserveId = collateral.getReserveId().toString();
      if (amounts.has(reserveId)) {
        amounts.set(
          reserveId,
          amounts.get(reserveId).add(collateral.getShare().getRaw()),
        );
      } else amounts.set(reserveId, new Big(0));
    });
  });
  return amounts;
}

async function getUnhealthyObligations(connection: Connection) {
  const mainnetPort = Port.forMainNet({});
  const portBalances = await mainnetPort.getAllPortBalances();
  const reserves = await mainnetPort.getReserveContext();
  const tokenToCurrentPrice = await readTokenPrices(connection, reserves);
  const sortedObligations = portBalances
    .filter((obligation) => !isNoBorrow(obligation))
    .filter((obligation) => !willNeverLiquidate(obligation))
    .filter((obligation) => !isInsolvent(obligation))
    .map((obligation) =>
      generateEnrichedObligation(obligation, tokenToCurrentPrice, reserves),
    )
    .sort((obligation1, obligation2) => {
      return obligation2.riskFactor * 100 - obligation1.riskFactor * 100;
    });

  console.log(
    `
Total number of loans are ${portBalances.length} and possible liquidation debts are ${sortedObligations.length}
`,
  );
  sortedObligations.slice(0, DISPLAY_FIRST).forEach((ob) =>
    console.log(
      `Risk factor: ${ob.riskFactor.toFixed(4)} borrowed amount: ${
        ob.loanValue
      } deposit amount: ${ob.collateralValue}
borrowed asset names: [${ob.borrowedAssetNames.toString()}] deposited asset names: [${ob.depositedAssetNames.toString()}]
obligation pubkey: ${ob.obligation.getPortId().toString()}
`,
    ),
  );

  tokenToCurrentPrice.forEach((price: Big, token: string) => {
    console.log(
      `name: ${portProfile.getAssetContext().findConfigByReserveId(ReserveId.fromBase58(token))?.getDisplayConfig().getName()} price: ${price.toString()}`,
    );
  });
  console.log('\n');
  return sortedObligations.filter((obligation) => obligation.riskFactor >= 1);
}

function generateEnrichedObligation(
  obligation: PortBalance,
  tokenToCurrentPrice: Map<string, Big>,
  reserveContext: ReserveContext,
): EnrichedObligation {
  let loanValue = new Big(0);
  const borrowedAssetNames: string[] = [];
  const assetCtx = portProfile.getAssetContext()
  for (const borrow of obligation.getLoans()) {
    const reservePubKey = borrow.getReserveId().toString();
    const name = assetCtx.findConfigByReserveId(ReserveId.fromBase58(reservePubKey))?.getDisplayConfig().getSymbol();
    const reserve = reserveContext.getReserveByReserveId(borrow.getReserveId());
    const tokenPrice: Big | undefined = tokenToCurrentPrice.get(reservePubKey);
    if (!tokenPrice) {
      throw new Error("token price not found")
    }

    const totalPrice = borrow
      .getAsset()
      .getRaw()
      .mul(tokenPrice)
      .div(reserve.getQuantityContext().multiplier);
    loanValue = loanValue.add(totalPrice);
    borrowedAssetNames.push(name??'unknow');
  }
  let collateralValue: Big = new Big(0);
  const depositedAssetNames: string[] = [];

  for (const deposit of obligation.getCollaterals()) {
    const reservePubKey = deposit.getReserveId().toString();
    const name = assetCtx.findConfigByReserveId(ReserveId.fromBase58(reservePubKey))?.getDisplayConfig().getSymbol();
    const reserve = reserveContext.getReserveByReserveId(deposit.getReserveId());
    const exchangeRatio = reserve.getExchangeRatio().getPct();
    const liquidationThreshold = reserve.params.liquidationThreshold.getRaw();
    const tokenPrice = tokenToCurrentPrice.get(reservePubKey);
    if (!tokenPrice || !exchangeRatio) {
      throw new Error('error in token price or exchange ratio');
    }
    const totalPrice = deposit
      .getShare()
      .getRaw()
      .div(exchangeRatio.getRaw())
      .mul(tokenPrice)
      .mul(liquidationThreshold)
      .div(reserve.getQuantityContext().multiplier);
    collateralValue = collateralValue.add(totalPrice);
    depositedAssetNames.push(name ?? 'unknown');
  }

  const riskFactor: number =
    collateralValue.eq(ZERO) || loanValue.eq(ZERO)
      ? 0
      : loanValue.div(collateralValue).toNumber();

  return {
    loanValue,
    collateralValue,
    riskFactor,
    obligation,
    borrowedAssetNames,
    depositedAssetNames,
  };
}

async function liquidateUnhealthyObligation(
  provider: Provider,
  programId: PublicKey,
  obligation: EnrichedObligation,
  reserveContext: ReserveContext,
  wallets: Map<string, TokenAccount>,
) {
  const payerAccount = await provider.connection.getAccountInfo(provider.wallet.publicKey);
  if (!payerAccount) {
    throw new Error(`No lamport for ${provider.wallet.publicKey}`);
  }

  const lendingMarket: PublicKey = reserveContext
    .getAllReserves()[0]
    .getMarketId().key;
  const [lendingMarketAuthority] = await PublicKey.findProgramAddress(
    [lendingMarket.toBuffer()],
    programId,
  );
  const instructions: TransactionInstruction[] = [];
  const signers: Keypair[] = [];

  const toRefreshReserves: Set<ReserveId> = new Set();
  obligation.obligation.getLoans().forEach((borrow) => {
    toRefreshReserves.add(borrow.getReserveId());
  });
  obligation.obligation.getCollaterals().forEach((deposit) => {
    toRefreshReserves.add(deposit.getReserveId());
  });
  toRefreshReserves.forEach((reserve) => {
    const reserveInfo = reserveContext.getReserveByReserveId(reserve);
    instructions.push(
      refreshReserveInstruction(reserveInfo.getReserveId().key, reserveInfo.getOracleId()?.key ?? null),
    );
  });

  const loans = obligation.obligation.getLoans();
  const collaterals = obligation.obligation.getCollaterals();
  let repayReserveId: ReserveId | null = null;

  for (const loan of loans) {
    if (loan.getAssetId().key.toString() === SOL_MINT && payerAccount.lamports > 0) {
      repayReserveId = loan.getReserveId();
      break;
    }

    const tokenWallet = wallets.get(loan.getAssetId().key.toString());
    if (!tokenWallet?.amount.isZero()) {
      repayReserveId = loan.getReserveId();
      break;
    }
  }

  if (repayReserveId === null) {
    throw new Error('no liquidity to repay')
  }

  const repayReserve: ReserveInfo = reserveContext.getReserveByReserveId(
    repayReserveId,
  );
  // TODO: choose a smarter way to withdraw collateral
  const withdrawReserve: ReserveInfo = reserveContext.getReserveByReserveId(
    collaterals[0].getReserveId(),
  );

  if (!repayReserve || !withdrawReserve) {
    return;
  }

  if (
    repayReserve.getAssetId().toString() !== SOL_MINT &&
    (!wallets.has(repayReserve.getAssetId().toString()) ||
      !wallets.has(withdrawReserve.getShareId().toString()))
  ) {
    return;
  }

  const repayWallet = wallets.get(repayReserve.getAssetId().toString());
  const withdrawWallet = wallets.get(withdrawReserve.getShareId().toString());
  
  if (!repayWallet || !withdrawWallet) {
    throw new Error("no collateral wallet found")
  }
  const latestRepayWallet = await fetchTokenAccount(provider, repayWallet.address);

  const transferAuthority =
    repayReserve.getAssetId().toString() !== SOL_MINT
      ? await liquidateByPayingToken(
          provider,
          instructions,
          latestRepayWallet.amount,
          repayWallet.address,
          withdrawWallet.address,
          repayReserve,
          withdrawReserve,
          obligation.obligation,
          lendingMarket,
          lendingMarketAuthority,
        )
      : await liquidateByPayingSOL(
          provider,
          instructions,
          signers,
          new u64(payerAccount.lamports - 100_000_000),
          withdrawWallet.address,
          repayReserve,
          withdrawReserve,
          obligation.obligation,
          lendingMarket,
          lendingMarketAuthority,
        );

  signers.push(transferAuthority);

  const liquidationSig = await sendTransaction(provider, instructions, signers);
  const assetContext = portProfile.getAssetContext();
  const repayTokenName = assetContext.findConfigByReserveId(repayReserve.getReserveId())?.getDisplayConfig().name;
  const withdrawTokenName = assetContext.findConfigByReserveId(withdrawReserve.getReserveId())?.getDisplayConfig().name;
  console.log(`Liqudiation transaction sent: ${liquidationSig}, paying ${repayTokenName} for ${withdrawTokenName}.`);

  const latestCollateralWallet = await fetchTokenAccount(
    provider,
    withdrawWallet.address
  );
  wallets.set(withdrawReserve.getShareId().toString(), latestCollateralWallet);
  const redeemSig = await redeemCollateral(
    provider,
    wallets,
    withdrawReserve,
    lendingMarketAuthority,
  );

  console.log(`Redeemed ${latestCollateralWallet.amount.toString()} lamport of ${withdrawTokenName} collateral tokens: ${redeemSig}`);
}

async function liquidateByPayingSOL(
  provider: Provider,
  instructions: TransactionInstruction[],
  signers: Keypair[],
  amount: u64,
  withdrawWallet: PublicKey,
  repayReserve: ReserveInfo,
  withdrawReserve: ReserveInfo,
  obligation: PortBalance,
  lendingMarket: PublicKey,
  lendingMarketAuthority: PublicKey,
) {
  const wrappedSOLTokenAccount = new Keypair();
  instructions.push(
    SystemProgram.createAccount({
      fromPubkey: provider.wallet.publicKey,
      newAccountPubkey: wrappedSOLTokenAccount.publicKey,
      lamports: amount.toNumber(),
      space: AccountLayout.span,
      programId: new PublicKey(TOKEN_PROGRAM_ID),
    }),
    Token.createInitAccountInstruction(
      new PublicKey(TOKEN_PROGRAM_ID),
      new PublicKey(SOL_MINT),
      wrappedSOLTokenAccount.publicKey,
      provider.wallet.publicKey,
    ),
  );

  const transferAuthority = await liquidateByPayingToken(
    provider,
    instructions,
    amount,
    wrappedSOLTokenAccount.publicKey,
    withdrawWallet,
    repayReserve,
    withdrawReserve,
    obligation,
    lendingMarket,
    lendingMarketAuthority,
  );

  instructions.push(
    Token.createCloseAccountInstruction(
      TOKEN_PROGRAM_ID,
      wrappedSOLTokenAccount.publicKey,
      provider.wallet.publicKey,
      provider.wallet.publicKey,
      [],
    ),
  );

  signers.push(wrappedSOLTokenAccount);

  return transferAuthority;
}

async function fetchStakingAccounts(
  connection: Connection,
  owner: PublicKey,
  stakingPool: PublicKey | null,
): Promise<
  Array<{
    pubkey: PublicKey;
    account: AccountInfo<Buffer>;
  }>
> {
  if (stakingPool === null) {
    return [];
  }
  return await connection.getProgramAccounts(STAKING_PROGRAM_ID, {
    filters: [
      {
        dataSize: 233,
      },
      {
        memcmp: {
          offset: 1 + 16,
          bytes: owner.toBase58(),
        },
      },
      {
        memcmp: {
          offset: 1 + 16 + 32,
          bytes: stakingPool.toBase58(),
        },
      },
    ],
  });
}

async function liquidateByPayingToken(
  provider: Provider,
  instructions: TransactionInstruction[],
  amount: u64,
  repayWallet: PublicKey,
  withdrawWallet: PublicKey,
  repayReserve: ReserveInfo,
  withdrawReserve: ReserveInfo,
  obligation: PortBalance,
  lendingMarket: PublicKey,
  lendingMarketAuthority: PublicKey,
): Promise<Keypair> {
  const transferAuthority = new Keypair();
  const stakeAccounts = await fetchStakingAccounts(
    provider.connection,
    obligation.owner,
    withdrawReserve.stakingPool,
  );

  const laons = obligation.getLoans();
  const collaterals = obligation.getCollaterals();

  instructions.push(
    refreshObligationInstruction(
      obligation.getPortId().key,
      collaterals.map((deposit) => deposit.getReserveId().key),
      laons.map((borrow) => borrow.getReserveId().key),
    ),
    Token.createApproveInstruction(
      TOKEN_PROGRAM_ID,
      repayWallet,
      transferAuthority.publicKey,
      provider.wallet.publicKey,
      [],
      amount,
    ),
    liquidateObligationInstruction(
      amount,
      repayWallet,
      withdrawWallet,
      repayReserve.getReserveId().key,
      repayReserve.getAssetBalanceId().key,
      withdrawReserve.getReserveId().key,
      withdrawReserve.getShareBalanceId().key,
      obligation.getPortId().key,
      lendingMarket,
      lendingMarketAuthority,
      transferAuthority.publicKey,
      withdrawReserve.stakingPool !== null
        ? withdrawReserve.stakingPool
        : undefined,
      withdrawReserve.stakingPool !== null
        ? stakeAccounts[0].pubkey
        : undefined,
    ),
  );

  return transferAuthority;
}

async function redeemCollateral(
  provider: Provider,
  wallets: Map<string, TokenAccount>,
  withdrawReserve: ReserveInfo,
  lendingMarketAuthority: PublicKey,
): Promise<string> {
  const instructions: TransactionInstruction[] = [];
  const transferAuthority = new Keypair();

  const collateralWallet = wallets.get(withdrawReserve.getShareId().toString());
  const liquidityWallet = wallets.get(withdrawReserve.getAssetId().toString());

  if (!collateralWallet || !liquidityWallet) {
    throw new Error("No collateral or liquidity wallet found.")
  }

  instructions.push(
    Token.createApproveInstruction(
      TOKEN_PROGRAM_ID,
      collateralWallet.address,
      transferAuthority.publicKey,
      provider.wallet.publicKey,
      [],
      collateralWallet.amount,
    ),
    refreshReserveInstruction(withdrawReserve.getReserveId().key, withdrawReserve.getOracleId()?.key ?? null),
    redeemReserveCollateralInstruction(
      collateralWallet.amount,
      collateralWallet.address,
      liquidityWallet.address,
      withdrawReserve.getReserveId().key,
      withdrawReserve.getShareId().key,
      withdrawReserve.getAssetBalanceId().key,
      withdrawReserve.getMarketId().key,
      lendingMarketAuthority,
      transferAuthority.publicKey,
    ),
  );
  
  const redeemSig = await sendTransaction(provider, instructions, [transferAuthority]);
  return redeemSig;
}

// eslint-disable-next-line
async function _sellToken(_tokenAccount: Wallet) {
  // TODO: sell token using Serum or Raydium
}

runLiquidator();
