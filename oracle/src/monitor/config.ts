import { z } from "zod";
import { optionalEnv } from "../config/env.js";

const positiveInteger = z.coerce.number().int().positive();
const positiveNumber = z.coerce.number().positive();

/** 1 XLM in stroops — bond amounts are stored on-chain (and in Postgres) as stroops. */
export const STROOPS_PER_XLM = 10_000_000n;

export function xlmToStroops(xlm: number): bigint {
  return BigInt(Math.round(xlm * Number(STROOPS_PER_XLM)));
}

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  LOG_LEVEL: z.string().min(1).default("info"),

  /** How often the monitor runs a full check cycle. */
  MONITOR_INTERVAL_MS: positiveInteger.default(60_000),

  /** Hours past market expiry before a market is flagged as stuck. */
  STUCK_MARKET_HOURS: positiveNumber.default(6),

  /** Hours an escalated market may sit without council votes before alerting. */
  COUNCIL_INACTIVITY_HOURS: positiveNumber.default(48),

  /** Minimum submitter bond, in XLM. Submissions below it are flagged. */
  SUBMITTER_BOND_XLM: positiveNumber.default(100),

  /** Webhook that receives every alert as JSON. When unset, alerts are only logged. */
  ALERT_WEBHOOK_URL: optionalEnv(z.string().url()),
});

export type MonitorConfig = z.infer<typeof schema>;

export function loadMonitorConfig(env: NodeJS.ProcessEnv = process.env): MonitorConfig {
  return schema.parse(env);
}
