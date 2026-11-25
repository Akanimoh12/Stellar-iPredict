import { z } from "zod";

const positiveInteger = z.coerce.number().int().positive();
const positiveNumber = z.coerce.number().positive();
const unitFraction = z.coerce.number().min(0).max(1);

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

const schema = z.object({
  COUNCIL_SIZE: positiveInteger.default(7),
  COUNCIL_THRESHOLD: positiveInteger.default(4),
  DATABASE_URL: z.string().min(1),
  SOROBAN_RPC_URL: z.string().url().optional(),
  SOROBAN_RPC_URLS: z.string().optional(),
  POLL_INTERVAL_MS: positiveInteger.default(5_000),

  /** Fraction (0–1) of dissenting votes that triggers a conflict flag. */
  CONFLICT_THRESHOLD: unitFraction.default(0.3),

  /** Hours past market expiry before a market is flagged as stuck. */
  STUCK_MARKET_HOURS: positiveNumber.default(6),

  /** Initial resolver key for signing finalization transactions. */
  RESOLVER_KEY: z.string().min(1).optional(),
}).refine((value) => value.COUNCIL_THRESHOLD <= value.COUNCIL_SIZE, {
  message: "COUNCIL_THRESHOLD cannot exceed COUNCIL_SIZE",
}).refine(
  (data) => {
    // At least one of SOROBAN_RPC_URLS or SOROBAN_RPC_URL must be set
    return data.SOROBAN_RPC_URLS || data.SOROBAN_RPC_URL;
  },
  {
    message: "Either SOROBAN_RPC_URLS or SOROBAN_RPC_URL must be set",
  }
).transform((data) => {
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

export type AggregatorConfig = z.infer<typeof schema>;
export function loadAggregatorConfig(env: NodeJS.ProcessEnv = process.env): AggregatorConfig {
  return schema.parse(env);
}
