import {
  Address,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";
import { MARKET_CONTRACT_ID, ADMIN_PUBLIC_KEY } from "@/config/network";
import { buildAndSendTx, simulateTransaction } from "@/services/soroban";
import * as cache from "@/services/cache";
import { getDisplayName } from "@/services/referral";
import type { Market, Bet, TransactionResult } from "@/types";

// ── Cache keys & TTLs ────────────────────────────────────────────────────────

const CACHE_MARKETS = "markets";
const CACHE_MARKET = (id: number) => `market_${id}`;
const CACHE_BET = (mId: number, addr: string) => `bet_${mId}_${addr}`;
const CACHE_ODDS = (id: number) => `odds_${id}`;
const CACHE_BETTORS = (id: number) => `bettors_${id}`;
const CACHE_FEES = "accumulated_fees";

const MARKET_TTL = 30_000; // 30s
const BET_TTL = 15_000; // 15s — refreshes faster for active bets

// ── Stroops conversion ────────────────────────────────────────────────────────
const STROOPS_PER_XLM = 10_000_000;

/** Convert stroops (raw contract value) to human-readable XLM */
function stroopsToXlm(stroops: number): number {
  return stroops / STROOPS_PER_XLM;
}

/** Convert human-readable XLM to stroops for contract calls */
function xlmToStroops(xlm: number): number {
  return Math.round(xlm * STROOPS_PER_XLM);
}

// ── Helpers: build ScVal args ─────────────────────────────────────────────────

function addressVal(addr: string): xdr.ScVal {
  return new Address(addr).toScVal();
}

function u64Val(n: number): xdr.ScVal {
  return nativeToScVal(n, { type: "u64" });
}

function i128Val(n: number): xdr.ScVal {
  return nativeToScVal(n, { type: "i128" });
}

function boolVal(b: boolean): xdr.ScVal {
  return nativeToScVal(b, { type: "bool" });
}

function stringVal(s: string): xdr.ScVal {
  return nativeToScVal(s, { type: "string" });
}

// ── Source key for read-only simulations ──────────────────────────────────────

/** Use admin key as simulation source — any valid key works for reads */
function simSource(): string {
  return ADMIN_PUBLIC_KEY;
}

// ── Parse raw contract data into TS types ─────────────────────────────────────

interface RawMarket {
  id: number | bigint;
  question: string;
  image_url: string;
  end_time: number | bigint;
  total_yes: number | bigint;
  total_no: number | bigint;
  resolved: boolean;
  outcome: boolean;
  cancelled: boolean;
  creator: string;
  bet_count: number | bigint;
}

function parseMarket(raw: RawMarket): Market {
  return {
    id: Number(raw.id),
    question: raw.question,
    imageUrl: raw.image_url,
    endTime: Number(raw.end_time),
    totalYes: stroopsToXlm(Number(raw.total_yes)),
    totalNo: stroopsToXlm(Number(raw.total_no)),
    resolved: raw.resolved,
    outcome: raw.outcome,
    cancelled: raw.cancelled,
    creator: typeof raw.creator === "string" ? raw.creator : String(raw.creator),
    betCount: Number(raw.bet_count),
  };
}

interface RawBet {
  amount: number | bigint;
  is_yes: boolean;
  claimed: boolean;
}

function parseBet(raw: RawBet): Bet {
  return {
    amount: stroopsToXlm(Number(raw.amount)),
    isYes: raw.is_yes,
    claimed: raw.claimed,
  };
}

// ── Concurrency limiter ───────────────────────────────────────────────────────

async function batchAll<T>(
  tasks: (() => Promise<T>)[],
  concurrency = 5
): Promise<T[]> {
  const results: T[] = [];
  for (let i = 0; i < tasks.length; i += concurrency) {
    const batch = tasks.slice(i, i + concurrency).map((fn) => fn());
    results.push(...(await Promise.all(batch)));
  }
  return results;
}

// ── Read functions ────────────────────────────────────────────────────────────

/** Fetch single market by ID */
export async function getMarket(marketId: number): Promise<Market | null> {
  const cached = cache.get<Market>(CACHE_MARKET(marketId));
  if (cached) return cached;

  try {
    const raw = await simulateTransaction<RawMarket>(
      simSource(),
      MARKET_CONTRACT_ID,
      "get_market",
      [u64Val(marketId)]
    );
    const market = parseMarket(raw);
    cache.set(CACHE_MARKET(marketId), market, MARKET_TTL);
    return market;
  } catch {
    return null;
  }
}

/** Fetch all markets — iterate 1..marketCount, batch-resolve display names */
export async function getMarkets(): Promise<Market[]> {
  const cached = cache.get<Market[]>(CACHE_MARKETS);
  if (cached) return cached;

  // Get total count
  const count = await simulateTransaction<number | bigint>(
    simSource(),
    MARKET_CONTRACT_ID,
    "get_market_count",
    []
  );
  const total = Number(count);
  if (total === 0) return [];

  // Fetch markets in batches of 5
  const tasks = Array.from({ length: total }, (_, i) => {
    const id = i + 1;
    return async () => {
      try {
        const raw = await simulateTransaction<RawMarket>(
          simSource(),
          MARKET_CONTRACT_ID,
          "get_market",
          [u64Val(id)]
        );
        return parseMarket(raw);
      } catch {
        return null;
      }
    };
  });

  const results = await batchAll(tasks, 5);
  const markets = results.filter((m): m is Market => m !== null);

  // Cache individual markets too
  for (const m of markets) {
    cache.set(CACHE_MARKET(m.id), m, MARKET_TTL);
  }
  cache.set(CACHE_MARKETS, markets, MARKET_TTL);
  return markets;
}

/** Fetch a user's bet on a specific market */
export async function getBet(
  marketId: number,
  userAddress: string
): Promise<Bet | null> {
  const cacheKey = CACHE_BET(marketId, userAddress);
  const cached = cache.get<Bet>(cacheKey);
  if (cached) return cached;

  try {
    const raw = await simulateTransaction<RawBet>(
      simSource(),
      MARKET_CONTRACT_ID,
      "get_bet",
      [u64Val(marketId), addressVal(userAddress)]
    );
    const bet = parseBet(raw);
    cache.set(cacheKey, bet, BET_TTL);
    return bet;
  } catch {
    return null;
  }
}

/** Get odds for a market (YES% / NO%) */
export async function getOdds(
  marketId: number
): Promise<{ yesPercent: number; noPercent: number }> {
  const cacheKey = CACHE_ODDS(marketId);
  const cached = cache.get<{ yesPercent: number; noPercent: number }>(cacheKey);
  if (cached) return cached;

  try {
    const raw = await simulateTransaction<[number | bigint, number | bigint]>(
      simSource(),
      MARKET_CONTRACT_ID,
      "get_odds",
      [u64Val(marketId)]
    );
    const odds = {
      yesPercent: Number(raw[0]),
      noPercent: Number(raw[1]),
    };
    cache.set(cacheKey, odds, MARKET_TTL);
    return odds;
  } catch {
    return { yesPercent: 50, noPercent: 50 };
  }
}

/** Get list of bettor addresses for a market */
export async function getMarketBettors(marketId: number): Promise<string[]> {
  const cacheKey = CACHE_BETTORS(marketId);
  const cached = cache.get<string[]>(cacheKey);
  if (cached) return cached;

  try {
    const raw = await simulateTransaction<string[]>(
      simSource(),
      MARKET_CONTRACT_ID,
      "get_market_bettors",
      [u64Val(marketId)]
    );
    cache.set(cacheKey, raw, MARKET_TTL);
    return raw;
  } catch {
    return [];
  }
}

/** Get accumulated platform fees */
export async function getAccumulatedFees(): Promise<number> {
  const cached = cache.get<number>(CACHE_FEES);
  if (cached !== null) return cached;

  try {
    const raw = await simulateTransaction<number | bigint>(
      simSource(),
      MARKET_CONTRACT_ID,
      "get_accumulated_fees",
      []
    );
    const fees = Number(raw);
    cache.set(CACHE_FEES, fees, MARKET_TTL);
    return fees;
  } catch {
    return 0;
  }
}

/**
 * Batch-resolve display names for an array of addresses.
 * Used on market detail pages to show bettor names.
 */
export async function resolveDisplayNames(
  addresses: string[]
): Promise<Map<string, string>> {
  const nameMap = new Map<string, string>();
  const tasks = addresses.map((addr) => async () => {
    try {
      const name = await getDisplayName(addr);
      nameMap.set(addr, name || addr);
    } catch {
      nameMap.set(addr, addr);
    }
  });
  await batchAll(tasks, 5);
  return nameMap;
}

// ── Write functions ───────────────────────────────────────────────────────────

/** Create a new market (admin only) */
export async function createMarket(
  publicKey: string,
  question: string,
  imageUrl: string,
  durationSecs: number,
  signTransaction: (txXdr: string) => Promise<string>
): Promise<TransactionResult> {
  const result = await buildAndSendTx(
    publicKey,
    MARKET_CONTRACT_ID,
    "create_market",
    [addressVal(publicKey), stringVal(question), stringVal(imageUrl), u64Val(durationSecs)],
    signTransaction
  );

  if (result.success) {
    cache.invalidate(CACHE_MARKETS);
  }
  return result;
}

/** Place a bet on a market */
export async function placeBet(
  publicKey: string,
  marketId: number,
  isYes: boolean,
  amount: number,
  signTransaction: (txXdr: string) => Promise<string>
): Promise<TransactionResult> {
  const result = await buildAndSendTx(
    publicKey,
    MARKET_CONTRACT_ID,
    "place_bet",
    [addressVal(publicKey), u64Val(marketId), boolVal(isYes), i128Val(xlmToStroops(amount))],
    signTransaction
  );

  if (result.success) {
    cache.invalidate(CACHE_MARKETS);
    cache.invalidate(CACHE_MARKET(marketId));
    cache.invalidate(CACHE_BET(marketId, publicKey));
    cache.invalidate(CACHE_ODDS(marketId));
    cache.invalidate(CACHE_BETTORS(marketId));
  }
  return result;
}

/** Resolve a market (admin only) */
export async function resolveMarket(
  publicKey: string,
  marketId: number,
  outcome: boolean,
  signTransaction: (txXdr: string) => Promise<string>
): Promise<TransactionResult> {
  const result = await buildAndSendTx(
    publicKey,
    MARKET_CONTRACT_ID,
    "resolve_market",
    [addressVal(publicKey), u64Val(marketId), boolVal(outcome)],
    signTransaction
  );

  if (result.success) {
    cache.invalidate(CACHE_MARKETS);
    cache.invalidate(CACHE_MARKET(marketId));
  }
  return result;
}

/** Cancel a market (admin only) */
export async function cancelMarket(
  publicKey: string,
  marketId: number,
  signTransaction: (txXdr: string) => Promise<string>
): Promise<TransactionResult> {
  const result = await buildAndSendTx(
    publicKey,
    MARKET_CONTRACT_ID,
    "cancel_market",
    [addressVal(publicKey), u64Val(marketId)],
    signTransaction
  );

  if (result.success) {
    cache.invalidate(CACHE_MARKETS);
    cache.invalidate(CACHE_MARKET(marketId));
    cache.invalidate(CACHE_BETTORS(marketId));
  }
  return result;
}

/** Claim rewards for a resolved market */
export async function claim(
  publicKey: string,
  marketId: number,
  signTransaction: (txXdr: string) => Promise<string>
): Promise<TransactionResult> {
  const result = await buildAndSendTx(
    publicKey,
    MARKET_CONTRACT_ID,
    "claim",
    [addressVal(publicKey), u64Val(marketId)],
    signTransaction
  );

  if (result.success) {
    cache.invalidate(CACHE_BET(marketId, publicKey));
    cache.invalidate(CACHE_MARKET(marketId));
    cache.invalidate(CACHE_FEES);
  }
  return result;
}

/** Withdraw accumulated platform fees (admin only) */
export async function withdrawFees(
  publicKey: string,
  signTransaction: (txXdr: string) => Promise<string>
): Promise<TransactionResult> {
  const result = await buildAndSendTx(
    publicKey,
    MARKET_CONTRACT_ID,
    "withdraw_fees",
    [addressVal(publicKey)],
    signTransaction
  );

  if (result.success) {
    cache.invalidate(CACHE_FEES);
  }
  return result;
}
