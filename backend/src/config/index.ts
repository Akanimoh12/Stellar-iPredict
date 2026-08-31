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
  ORACLE_API_KEY: z
    .string({ message: "ORACLE_API_KEY is required" })
    .min(1, "ORACLE_API_KEY is required"),
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
  ORACLE_THRESHOLD: z
    .string()
    .optional()
    .transform((v) => (v !== undefined ? Number(v) : 3))
    .pipe(z.number().int().positive()),
  ORACLE_IDEMPOTENCY_RETENTION_SEC: z
    .string()
    .optional()
    .transform((v) => (v !== undefined ? Number(v) : 3600))
    .pipe(z.number().int().positive()),
  REGISTERED_ORACLE_PROVIDERS: z.string().optional(),
  /**
   * Per-provider oracle credentials (issue #429).
   *
   * Plural, matching `.env.example` and the docs — the code previously read a
   * singular `ORACLE_API_KEY` that no example ever mentioned. Parsed and
   * validated below rather than here so the failure message can explain the
   * format instead of printing a Zod issue path.
   */
  ORACLE_API_KEYS: z.string().optional(),
  /** Legacy singular name, accepted only to produce a clear migration error. */
  ORACLE_API_KEY: z.string().optional(),
});

type EnvConfig = z.infer<typeof envSchema>;

let cached: EnvConfig | null = null;
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
export function loadConfig(): EnvConfig {
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

  cached = result.data;
  return cached;
}

// Lazily-evaluated proxy so `import { config }` call sites keep working
// unchanged while validation is deferred to first property access.
export const config: EnvConfig = new Proxy({} as EnvConfig, {
  get(_target, prop) {
    return Reflect.get(loadConfig(), prop);
  },
});

/**
 * Oracle credentials, resolved once at startup.
 *
 * Parsed here rather than per-request so a malformed or unsafe configuration
 * is a boot failure an operator sees immediately, instead of a 401 that only
 * shows up when a provider next submits.
 */
let oracleApiKeys: OracleCredential[];

try {
  oracleApiKeys = parseOracleApiKeys({
    raw: result.data.ORACLE_API_KEYS,
    legacyRaw: result.data.ORACLE_API_KEY,
    nodeEnv: result.data.NODE_ENV,
    warn: (message) =>
      process.stderr.write(`[ipredict-backend] ${message}
`),
  });
} catch (error) {
  if (error instanceof OracleApiKeyConfigError) {
    process.stderr.write(
      `[ipredict-backend] invalid configuration:
  ${error.message}
`,
    );
    process.exit(1);
  }
  throw error;
}

export const config = { ...result.data, oracleApiKeys };
export type Config = typeof config;
