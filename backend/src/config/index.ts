import { z } from "zod";

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
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .optional()
    .default("development"),
});

const result = envSchema.safeParse(process.env);

if (!result.success) {
  const issues = result.error.issues
    .map((i) => `  ${i.path.join(".")}: ${i.message}`)
    .join("\n");
  process.stderr.write(`[ipredict-backend] invalid configuration:\n${issues}\n`);
  process.exit(1);
}

export const config = result.data;
export type Config = typeof config;
