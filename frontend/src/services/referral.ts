import {
  Address,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";
import { REFERRAL_CONTRACT_ID, ADMIN_PUBLIC_KEY } from "@/config/network";
import { buildAndSendTx, simulateTransaction } from "@/services/soroban";
import * as cache from "@/services/cache";
import type { TransactionResult } from "@/types";

// ── Cache keys & TTLs ────────────────────────────────────────────────────────

const CACHE_REFERRER = (addr: string) => `ref_referrer_${addr}`;
const CACHE_DISPLAY_NAME = (addr: string) => `ref_name_${addr}`;
const CACHE_REF_COUNT = (addr: string) => `ref_count_${addr}`;
const CACHE_EARNINGS = (addr: string) => `ref_earnings_${addr}`;
const CACHE_HAS_REF = (addr: string) => `ref_has_${addr}`;
const CACHE_REGISTERED = (addr: string) => `ref_reg_${addr}`;

const REF_TTL = 60_000; // 60s — referral data changes infrequently

/** Simulation source */
function simSource(): string {
  return ADMIN_PUBLIC_KEY;
}

function addressVal(addr: string): xdr.ScVal {
  return new Address(addr).toScVal();
}

function stringVal(s: string): xdr.ScVal {
  return nativeToScVal(s, { type: "string" });
}

// ── Write functions ───────────────────────────────────────────────────────────

/** Register referral for a user */
export async function registerReferral(
  publicKey: string,
  displayName: string,
  referrer: string | null,
  signTransaction: (txXdr: string) => Promise<string>
): Promise<TransactionResult> {
  // Build args: user, display_name, referrer (Option<Address>)
  const args: xdr.ScVal[] = [
    addressVal(publicKey),
    stringVal(displayName),
  ];

  // Pass referrer as an Address or Void for None
  if (referrer) {
    args.push(addressVal(referrer));
  } else {
    args.push(xdr.ScVal.scvVoid());
  }

  const result = await buildAndSendTx(
    publicKey,
    REFERRAL_CONTRACT_ID,
    "register_referral",
    args,
    signTransaction
  );

  if (result.success) {
    // Invalidate all referral-related caches for this user
    cache.invalidate(CACHE_REGISTERED(publicKey));
    cache.invalidate(CACHE_DISPLAY_NAME(publicKey));
    cache.invalidate(CACHE_HAS_REF(publicKey));
    cache.invalidate(CACHE_REFERRER(publicKey));
    if (referrer) {
      cache.invalidate(CACHE_REF_COUNT(referrer));
    }
  }
  return result;
}

// ── Read functions ────────────────────────────────────────────────────────────

/** Get the referrer address for a user (or null if none) */
export async function getReferrer(
  userAddress: string
): Promise<string | null> {
  const cacheKey = CACHE_REFERRER(userAddress);
  const cached = cache.get<string | null>(cacheKey);
  if (cached !== undefined && cached !== null) return cached;

  try {
    const raw = await simulateTransaction<string>(
      simSource(),
      REFERRAL_CONTRACT_ID,
      "get_referrer",
      [addressVal(userAddress)]
    );
    const result = raw || null;
    cache.set(cacheKey, result, REF_TTL);
    return result;
  } catch {
    return null;
  }
}

/** Get display name for a user (empty string if not registered) */
export async function getDisplayName(
  userAddress: string
): Promise<string> {
  const cacheKey = CACHE_DISPLAY_NAME(userAddress);
  const cached = cache.get<string>(cacheKey);
  if (cached !== null) return cached;

  try {
    const raw = await simulateTransaction<string>(
      simSource(),
      REFERRAL_CONTRACT_ID,
      "get_display_name",
      [addressVal(userAddress)]
    );
    const name = raw || "";
    cache.set(cacheKey, name, REF_TTL);
    return name;
  } catch {
    return "";
  }
}

/** Get referral count for a user */
export async function getReferralCount(
  userAddress: string
): Promise<number> {
  const cacheKey = CACHE_REF_COUNT(userAddress);
  const cached = cache.get<number>(cacheKey);
  if (cached !== null) return cached;

  try {
    const raw = await simulateTransaction<number | bigint>(
      simSource(),
      REFERRAL_CONTRACT_ID,
      "get_referral_count",
      [addressVal(userAddress)]
    );
    const count = Number(raw);
    cache.set(cacheKey, count, REF_TTL);
    return count;
  } catch {
    return 0;
  }
}

/** Get total referral earnings for a user (in stroops) */
export async function getEarnings(userAddress: string): Promise<number> {
  const cacheKey = CACHE_EARNINGS(userAddress);
  const cached = cache.get<number>(cacheKey);
  if (cached !== null) return cached;

  try {
    const raw = await simulateTransaction<number | bigint>(
      simSource(),
      REFERRAL_CONTRACT_ID,
      "get_earnings",
      [addressVal(userAddress)]
    );
    const earnings = Number(raw);
    cache.set(cacheKey, earnings, REF_TTL);
    return earnings;
  } catch {
    return 0;
  }
}

/** Check if user has a custom referrer */
export async function hasReferrer(userAddress: string): Promise<boolean> {
  const cacheKey = CACHE_HAS_REF(userAddress);
  const cached = cache.get<boolean>(cacheKey);
  if (cached !== null) return cached;

  try {
    const raw = await simulateTransaction<boolean>(
      simSource(),
      REFERRAL_CONTRACT_ID,
      "has_referrer",
      [addressVal(userAddress)]
    );
    cache.set(cacheKey, raw, REF_TTL);
    return raw;
  } catch {
    return false;
  }
}

/** Check if user is registered */
export async function isRegistered(userAddress: string): Promise<boolean> {
  const cacheKey = CACHE_REGISTERED(userAddress);
  const cached = cache.get<boolean>(cacheKey);
  if (cached !== null) return cached;

  try {
    const raw = await simulateTransaction<boolean>(
      simSource(),
      REFERRAL_CONTRACT_ID,
      "is_registered",
      [addressVal(userAddress)]
    );
    cache.set(cacheKey, raw, REF_TTL);
    return raw;
  } catch {
    return false;
  }
}

// ── Name-to-Address resolution ────────────────────────────────────────────────

/**
 * Resolve a display name to a Stellar address by scanning all known bettors.
 * Returns the matching address or null if not found.
 * Case-insensitive, exact match.
 */
export async function resolveAddressByName(
  name: string
): Promise<string | null> {
  const cacheKey = `ref_name_resolve_${name.toLowerCase()}`;
  const cached = cache.get<string | null>(cacheKey);
  if (cached !== null) return cached;

  try {
    // Import dynamically to avoid circular dependency
    const { getMarkets, getMarketBettors } = await import("@/services/market");
    const markets = await getMarkets();
    if (markets.length === 0) return null;

    // Collect unique bettor addresses
    const addressSet = new Set<string>();
    const bettorResults = await Promise.allSettled(
      markets.map((m) => getMarketBettors(m.id))
    );
    for (const r of bettorResults) {
      if (r.status === "fulfilled") {
        for (const addr of r.value) addressSet.add(addr);
      }
    }

    // Check each bettor's display name
    const needle = name.toLowerCase().trim();
    for (const addr of addressSet) {
      try {
        const dName = await getDisplayName(addr);
        if (dName && dName.toLowerCase().trim() === needle) {
          cache.set(cacheKey, addr, REF_TTL);
          return addr;
        }
      } catch {
        // skip
      }
    }

    return null;
  } catch {
    return null;
  }
}
