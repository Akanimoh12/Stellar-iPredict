import { z } from "zod";
import { ProgrammingError, parseConfig } from "@ipredict/shared";

/**
 * Upper bound for `EVENTS_PER_PAGE`.
 *
 * The Soroban RPC `getEvents` endpoint accepts limits up to 10,000, but
 * allowing arbitrarily large pages lets a misconfigured indexer materialise
 * an unbounded batch of decoded events in memory during a backfill over a
 * busy ledger range. `1000` is 5x the default and keeps peak memory
 * proportional to the page size rather than to the size of the ledger range
 * being replayed. Values above this are rejected at startup.
 */
export const MAX_EVENTS_PER_PAGE = 1000;
export const DEFAULT_BACKFILL_WINDOW_LEDGERS = 10_000;

const configSchema = z.object({
  DATABASE_URL: z.string().url("DATABASE_URL must be a valid URL"),
  REDIS_URL: z.string().url("REDIS_URL must be a valid URL").default("redis://localhost:6379"),
  SOROBAN_RPC_URL: z.string().url("SOROBAN_RPC_URL must be a valid URL"),
  NETWORK_PASSPHRASE: z.string().min(1, "NETWORK_PASSPHRASE is required"),
  MARKET_CONTRACT_ID: z.string().min(1, "MARKET_CONTRACT_ID is required"),
  TOKEN_CONTRACT_ID: z.string().min(1, "TOKEN_CONTRACT_ID is required"),
  REFERRAL_CONTRACT_ID: z.string().min(1, "REFERRAL_CONTRACT_ID is required"),
  LEADERBOARD_CONTRACT_ID: z.string().min(1, "LEADERBOARD_CONTRACT_ID is required"),
  POLL_INTERVAL_MS: z.coerce
    .number()
    .int("POLL_INTERVAL_MS must be an integer")
    .positive("POLL_INTERVAL_MS must be positive")
    .default(5000),
  EVENTS_PER_PAGE: z.coerce
    .number()
    .int("EVENTS_PER_PAGE must be an integer")
    .positive("EVENTS_PER_PAGE must be positive")
    .max(MAX_EVENTS_PER_PAGE, `EVENTS_PER_PAGE must be at most ${MAX_EVENTS_PER_PAGE}`)
    .default(200),
  START_LEDGER: z.coerce
    .number()
    .int("START_LEDGER must be an integer")
    .nonnegative("START_LEDGER must be non-negative"),
  BACKFILL_WINDOW_LEDGERS: z.coerce
    .number()
    .int("BACKFILL_WINDOW_LEDGERS must be an integer")
    .positive("BACKFILL_WINDOW_LEDGERS must be positive")
    .default(DEFAULT_BACKFILL_WINDOW_LEDGERS),
});

export type Config = z.infer<typeof configSchema>;

/**
 * Validates an environment against the indexer schema (issue #631).
 *
 * Pure: it throws a `ConfigError` and never exits, so tests and tools can call
 * it freely. The entrypoint decides what a failure means.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return parseConfig("ipredict-indexer", configSchema, env);
}

let current: Config | null = null;

/**
 * Validates and stores the configuration for this process (issue #632).
 *
 * Called once, explicitly, at the start of each entrypoint. Importing this
 * module does nothing on its own.
 */
export function initConfig(env: NodeJS.ProcessEnv = process.env): Config {
  current = loadConfig(env);
  return current;
}

/**
 * The configuration stored by {@link initConfig}.
 *
 * @throws {ProgrammingError} when read before initialisation: that is a wiring
 * bug in the entrypoint, not a retryable condition.
 */
export function getConfig(): Config {
  if (current === null) {
    throw new ProgrammingError("indexer config read before initConfig() was called");
  }
  return current;
}

/**
 * Lazy view of the stored configuration, so existing `config.KEY` call sites
 * keep working. Reads still go through {@link getConfig}.
 */
export const config: Config = new Proxy({} as Config, {
  get(_target, prop) {
    return Reflect.get(getConfig(), prop);
  },
});
