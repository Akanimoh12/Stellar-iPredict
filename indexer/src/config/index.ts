import { z } from "zod";

/**
 * Parses comma-separated RPC URLs, trims whitespace, deduplicates, and validates.
 */
function parseRpcUrls(value: string | undefined): string[] {
  if (!value || value.trim() === "") {
    return [];
  }

  const urls = value
    .split(",")
    .map((url) => url.trim())
    .filter((url) => url.length > 0);

  // Deduplicate
  const unique = Array.from(new Set(urls));

  // Validate each URL
  for (const url of unique) {
    try {
      new URL(url);
    } catch {
      throw new Error(`Invalid URL in SOROBAN_RPC_URLS: ${url}`);
    }
  }

  return unique;
}

const configSchema = z
  .object({
    DATABASE_URL: z.string().url("DATABASE_URL must be a valid URL"),
    REDIS_URL: z.string().url("REDIS_URL must be a valid URL").default("redis://localhost:6379"),
    SOROBAN_RPC_URL: z.string().url("SOROBAN_RPC_URL must be a valid URL").optional(),
    SOROBAN_RPC_URLS: z.string().optional(),
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
      .default(200),
    START_LEDGER: z.coerce
      .number()
      .int("START_LEDGER must be an integer")
      .nonnegative("START_LEDGER must be non-negative"),
  })
  .refine(
    (data) => {
      // At least one of SOROBAN_RPC_URLS or SOROBAN_RPC_URL must be set
      return data.SOROBAN_RPC_URLS || data.SOROBAN_RPC_URL;
    },
    {
      message: "Either SOROBAN_RPC_URLS or SOROBAN_RPC_URL must be set",
    }
  )
  .transform((data) => {
    // Parse SOROBAN_RPC_URLS (takes precedence over single URL)
    let rpcEndpoints: string[] = [];
    
    if (data.SOROBAN_RPC_URLS) {
      rpcEndpoints = parseRpcUrls(data.SOROBAN_RPC_URLS);
    } else if (data.SOROBAN_RPC_URL) {
      rpcEndpoints = [data.SOROBAN_RPC_URL];
    }

    return {
      ...data,
      SOROBAN_RPC_ENDPOINTS: rpcEndpoints,
    };
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
export type Config = typeof parsed;
