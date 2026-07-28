import { z } from "zod";

const positiveInteger = z.coerce.number().int().positive();
const schema = z.object({
  COUNCIL_SIZE: positiveInteger.default(7),
  COUNCIL_THRESHOLD: positiveInteger.default(4),
  DATABASE_URL: z.string().min(1),
  SOROBAN_RPC_URL: z.string().url(),
  POLL_INTERVAL_MS: positiveInteger.default(5_000),
}).refine((value) => value.COUNCIL_THRESHOLD <= value.COUNCIL_SIZE, {
  message: "COUNCIL_THRESHOLD cannot exceed COUNCIL_SIZE",
});

export type AggregatorConfig = z.infer<typeof schema>;
export function loadAggregatorConfig(env: NodeJS.ProcessEnv = process.env): AggregatorConfig {
  return schema.parse(env);
}
