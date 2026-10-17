import { z } from "zod";

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
});

let parsed;
try {
  parsed = configSchema.parse(process.env);
} catch (error) {
  if (error instanceof z.ZodError) {
    console.error("❌ Invalid environment configuration:");
    error.issues.forEach((err) => {
      console.error(`  - ${err.path.join(".")}: ${err.message}`);
    });
  } else {
    console.error("❌ Configuration validation failed:", error);
  }
  process.exit(1);
}

export const config = parsed;
export type Config = z.infer<typeof configSchema>;
