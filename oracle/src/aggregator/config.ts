import { z } from "zod";

const positiveInteger = z.coerce.number().int().positive();
const positiveNumber = z.coerce.number().positive();
const unitFraction = z.coerce.number().min(0).max(1);

const schema = z.object({
  COUNCIL_SIZE: positiveInteger.default(7),
  COUNCIL_THRESHOLD: positiveInteger.default(4),
  DATABASE_URL: z.string().min(1),
  SOROBAN_RPC_URL: z.string().url(),
  POLL_INTERVAL_MS: positiveInteger.default(5_000),

  /** Fraction (0–1) of dissenting votes that triggers a conflict flag. */
  CONFLICT_THRESHOLD: unitFraction.default(0.3),

  /** Hours past market expiry before a market is flagged as stuck. */
  STUCK_MARKET_HOURS: positiveNumber.default(6),

  /** Initial resolver key for signing finalization transactions. */
  RESOLVER_KEY: z.string().min(1).optional(),

  /** Optional webhook notified when a market is finalized. When unset, finalization is only logged. */
  FINALIZE_WEBHOOK_URL: z.string().url().optional(),
}).refine((value) => value.COUNCIL_THRESHOLD <= value.COUNCIL_SIZE, {
  message: "COUNCIL_THRESHOLD cannot exceed COUNCIL_SIZE",
  path: ["COUNCIL_THRESHOLD"],
}).refine((value) => isStrictMajority(value.COUNCIL_THRESHOLD, value.COUNCIL_SIZE), {
  message: "COUNCIL_THRESHOLD must be a strict majority (> half of COUNCIL_SIZE)",
  path: ["COUNCIL_THRESHOLD"],
}).refine((value) => value.SUBMIT_BASE_BACKOFF_MS <= value.SUBMIT_MAX_BACKOFF_MS, {
  message: "SUBMIT_BASE_BACKOFF_MS cannot exceed SUBMIT_MAX_BACKOFF_MS",
  path: ["SUBMIT_BASE_BACKOFF_MS"],
});

export type AggregatorConfig = z.infer<typeof schema>;
export function loadAggregatorConfig(env: NodeJS.ProcessEnv = process.env): AggregatorConfig {
  return schema.parse(env);
}

export { isStrictMajority };
