import { Address } from "@stellar/stellar-sdk";
import { TOKEN_CONTRACT_ID } from "@/config/network";
import { simulateTransaction , getSimulationSource } from "@/services/soroban";
import * as cache from "@/services/cache";
import type { TokenInfo } from "@/types";

// ── Cache keys & TTLs ────────────────────────────────────────────────────────

const CACHE_BALANCE = (addr: string) => `token_bal_${addr}`;
const CACHE_TOKEN_INFO = "token_info";
const CACHE_TOTAL_SUPPLY = "token_supply";

const TOKEN_TTL = 30_000; // 30s
const INFO_TTL = 300_000; // 5 min — metadata rarely changes

/** Simulation source — any valid key works for reads */


/** Fetch IPREDICT token balance for an account (in human-readable units) */
export async function getBalance(account: string): Promise<number> {
  try {
    return await cache.getOrSet(
      CACHE_BALANCE(account),
      async () => {
        const raw = await simulateTransaction<number | bigint>(
          getSimulationSource(),
          TOKEN_CONTRACT_ID,
          "balance",
          [new Address(account).toScVal()]
        );
        // Token has 7 decimals — convert from smallest unit to human-readable
        return Number(raw) / 1e7;
      },
      TOKEN_TTL
    );
  } catch {
    return 0;
  }
}

/** Fetch token metadata (name, symbol, decimals, totalSupply) */
export async function getTokenInfo(): Promise<TokenInfo> {
  try {
    return await cache.getOrSet<TokenInfo>(
      CACHE_TOKEN_INFO,
      async () => {
        const src = getSimulationSource();
        const cid = TOKEN_CONTRACT_ID;

        const [name, symbol, decimals, totalSupply] = await Promise.all([
          simulateTransaction<string>(src, cid, "name", []),
          simulateTransaction<string>(src, cid, "symbol", []),
          simulateTransaction<number | bigint>(src, cid, "decimals", []),
          simulateTransaction<number | bigint>(src, cid, "total_supply", []),
        ]);

        return {
          name,
          symbol,
          decimals: Number(decimals),
          totalSupply: Number(totalSupply),
        };
      },
      INFO_TTL
    );
  } catch {
    // Return defaults if contract not yet deployed
    return { name: "IPREDICT", symbol: "IPRED", decimals: 7, totalSupply: 0 };
  }
}

/** Fetch total supply */
export async function getTotalSupply(): Promise<number> {
  try {
    return await cache.getOrSet(
      CACHE_TOTAL_SUPPLY,
      async () => {
        const raw = await simulateTransaction<number | bigint>(
          getSimulationSource(),
          TOKEN_CONTRACT_ID,
          "total_supply",
          []
        );
        return Number(raw);
      },
      TOKEN_TTL
    );
  } catch {
    return 0;
  }
}
