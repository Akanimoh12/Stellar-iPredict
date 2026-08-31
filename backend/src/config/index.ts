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

