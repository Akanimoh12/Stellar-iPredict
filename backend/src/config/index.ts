import { z } from "zod";
import { parseCorsOrigins } from "../lib/cors.js";
import {
  OracleApiKeyConfigError,
  parseOracleApiKeys,
  type OracleCredential,
} from "./oracleApiKeys.js";

export const envSchema = z.object({
  DATABASE_URL: z
    .string({ message: "DATABASE_URL is required" })
    .min(1, "DATABASE_URL is required"),
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
  // Request timeouts (issue #474)
  REQUEST_TIMEOUT_MS: z
    .string()
    .optional()
    .transform((v) => (v !== undefined ? Number(v) : 30000))
    .pipe(z.number().int().positive()),
  CONNECTION_TIMEOUT_MS: z
    .string()
    .optional()
    .transform((v) => (v !== undefined ? Number(v) : 10000))
    .pipe(z.number().int().positive()),
  // Request body size limit (issue #473)
  BODY_LIMIT_BYTES: z
    .string()
    .optional()
    .transform((v) => (v !== undefined ? Number(v) : 16384))
    .pipe(z.number().int().positive()),
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

type EnvConfig = z.infer<typeof envSchema>;

export interface Config extends EnvConfig {
  oracleApiKeys: OracleCredential[];
}

let cached: Config | null = null;
let cachedError: Error | null = null;

/**
 * Validates the environment and returns the parsed configuration.
 *
 * The config is validated lazily on first access so importing this module (or
 * anything that transitively imports it — e.g. `db/pool.ts`) does not throw or
 * exit the process when `DATABASE_URL` is unset. The error only surfaces when a
 * value is actually consumed, which keeps unit tests that never touch the
 * database from crashing on import.
 */
export function loadConfig(): Config {
  if (cached) return cached;
  if (cachedError) throw cachedError;

  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    cachedError = new Error(`[ipredict-backend] invalid configuration:\n${issues}`);
    throw cachedError;
  }

  let oracleApiKeys: OracleCredential[];
  try {
    oracleApiKeys = parseOracleApiKeys({
      raw: result.data.ORACLE_API_KEYS,
      legacyRaw: result.data.ORACLE_API_KEY,
      nodeEnv: result.data.NODE_ENV,
      warn: (message) =>
        process.stderr.write(`[ipredict-backend] ${message}\n`),
    });
  } catch (error) {
    if (error instanceof OracleApiKeyConfigError) {
      process.stderr.write(
        `[ipredict-backend] invalid configuration:\n  ${error.message}\n`,
      );
      process.exit(1);
    }
    throw error;
  }

  cached = { ...result.data, oracleApiKeys };
  return cached;
}

// Lazily-evaluated proxy so `import { config }` call sites keep working
// unchanged while validation is deferred to first property access.
export const config: Config = new Proxy({} as Config, {
  get(_target, prop) {
    return Reflect.get(loadConfig(), prop);
  },
});
