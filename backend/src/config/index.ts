import { z } from "zod";
import { parseCorsOrigins } from "../lib/cors.js";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  PORT: z
    .string()
    .optional()
    .transform((v) => (v !== undefined ? Number(v) : 4000))
    .pipe(z.number().int().positive()),
  DB_POOL_SIZE: z
    .string()
    .optional()
    .transform((v) => (v !== undefined ? Number(v) : 10))
    .pipe(z.number().int().positive()),
  DB_IDLE_TIMEOUT_MS: z
    .string()
    .optional()
    .transform((v) => (v !== undefined ? Number(v) : 30000))
    .pipe(z.number().int().nonnegative()),
  DB_CONNECTION_TIMEOUT_MS: z
    .string()
    .optional()
    .transform((v) => (v !== undefined ? Number(v) : 5000))
    .pipe(z.number().int().nonnegative()),
  LOG_LEVEL: z
    .enum(["debug", "info", "warn", "error"])
    .optional()
    .default("info"),
  // Comma-separated browser origins allowed to call the API.
  CORS_ORIGINS: z
    .string()
    .optional()
    .transform((v) => parseCorsOrigins(v)),
  REDIS_URL: z.string().optional().default("redis://localhost:6379"),
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .optional()
    .default("development"),
  // Oracle replay protection configuration
  ORACLE_TIMESTAMP_WINDOW_SEC: z
    .string()
    .optional()
    .transform((v) => (v !== undefined ? Number(v) : 300))
    .pipe(z.number().int().positive()),
    ORACLE_NONCE_RETENTION_SEC: z
    .string()
    .optional()
    .transform((v) => (v !== undefined ? Number(v) : 600))
    .pipe(z.number().int().positive()),
  // Comma-separated list of API keys that qualify for the authenticated
  // rate-limit tier.  Used by the rate-limiter to verify that a Bearer or
  // X-API-Key credential is genuine before elevating the caller (#485).
  API_KEYS: z
    .string()
    .optional()
    .default("")
    .transform((v) =>
      v
        .split(",")
        .map((k) => k.trim())
        .filter((k) => k.length > 0),
    ),
  // Comma-separated CIDR ranges of trusted reverse proxies.  When set,
  // Fastify's `trustProxy` is configured with this list so that
  // X-Forwarded-For is only honoured when the immediate peer is a known
  // proxy — preventing clients from spoofing their address (#485).
  // When empty (and NODE_ENV !== "test"), defaults to loopback ranges.
  TRUSTED_PROXIES: z
    .string()
    .optional()
    .default("")
    .transform((v) =>
      v
        .split(",")
        .map((c) => c.trim())
        .filter((c) => c.length > 0),
    ),
});

const result = envSchema.safeParse(process.env);

if (!result.success) {
  const issues = result.error.issues
    .map((i) => `  ${i.path.join(".")}: ${i.message}`)
    .join("\n");
  process.stderr.write(
    `[ipredict-backend] invalid configuration:\n${issues}\n`,
  );
  process.exit(1);
}

export const config = result.data;
export type Config = typeof config;
