import { z } from "zod";

export type OracleEnvironment = Record<string, string | undefined>;

/** Normalizes process-style environment values before module validation. */
export function normalizeEnvironment(environment: OracleEnvironment = process.env): OracleEnvironment {
  return Object.fromEntries(
    Object.entries(environment).map(([name, value]) => [
      name,
      typeof value === "string" && value.trim() === "" ? undefined : value,
    ]),
  );
}

/**
 * Treats an empty environment variable as absent.
 *
 * `.env` files spell "not configured" as `FINALIZE_WEBHOOK_URL=` — the key is
 * present with an empty value. Zod sees a defined empty string, so a bare
 * `.url().optional()` rejects it and the service exits at startup. Every
 * optional variable in a checked-in `.env.example` would otherwise have to be
 * commented out to be usable, which is not how operators edit these files.
 *
 * Wrap the *inner* schema, not the `.optional()`:
 *
 *   RESOLVER_KEY: optionalEnv(z.string().min(1)),
 */
export function optionalEnv<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    schema.optional(),
  );
}

export class OracleConfigurationError extends Error {
  public readonly missingFields: string[];
  public readonly invalidFields: string[];

  constructor(message: string, missingFields: string[] = [], invalidFields: string[] = []) {
    super(message);
    this.name = "OracleConfigurationError";
    this.missingFields = missingFields;
    this.invalidFields = invalidFields;
  }
}

/**
 * Startup configuration validator that fails fast when required keys,
 * endpoints or thresholds are missing or inconsistent (#1010).
 */
export function validateOracleStartupConfig(
  rawEnv: OracleEnvironment = process.env,
  options: { requireSigningKeys?: boolean; requireContract?: boolean } = {}
): { valid: boolean; errors: string[] } {
  const env = normalizeEnvironment(rawEnv);
  const errors: string[] = [];
  const missing: string[] = [];
  const invalid: string[] = [];

  // Required endpoint
  if (!env.SOROBAN_RPC_URL) {
    missing.push("SOROBAN_RPC_URL");
    errors.push("Missing required RPC endpoint: SOROBAN_RPC_URL");
  } else {
    try {
      new URL(env.SOROBAN_RPC_URL);
    } catch {
      invalid.push("SOROBAN_RPC_URL");
      errors.push("Invalid SOROBAN_RPC_URL: must be a valid URL format");
    }
  }

  // Contract ID
  if (options.requireContract && !env.CONTRACT_ID) {
    missing.push("CONTRACT_ID");
    errors.push("Missing required contract ID: CONTRACT_ID");
  }

  // Signing keys if required
  if (options.requireSigningKeys && !env.RESOLVER_SECRET_KEY && !env.RESOLVER_KEY) {
    missing.push("RESOLVER_SECRET_KEY");
    errors.push("Missing required resolver signing key: RESOLVER_SECRET_KEY");
  }

  // Thresholds consistency if present
  if (env.COUNCIL_THRESHOLD !== undefined && env.COUNCIL_QUORUM !== undefined) {
    const threshold = Number(env.COUNCIL_THRESHOLD);
    const quorum = Number(env.COUNCIL_QUORUM);
    if (isNaN(threshold) || threshold <= 0) {
      invalid.push("COUNCIL_THRESHOLD");
      errors.push("COUNCIL_THRESHOLD must be a positive integer");
    }
    if (isNaN(quorum) || quorum <= 0) {
      invalid.push("COUNCIL_QUORUM");
      errors.push("COUNCIL_QUORUM must be a positive integer");
    }
    if (!isNaN(threshold) && !isNaN(quorum) && quorum < threshold) {
      invalid.push("COUNCIL_QUORUM");
      errors.push("Inconsistent threshold configuration: COUNCIL_QUORUM must be >= COUNCIL_THRESHOLD");
    }
  }

  if (errors.length > 0) {
    throw new OracleConfigurationError(
      `Oracle failed startup configuration validation:\n- ${errors.join("\n- ")}`,
      missing,
      invalid
    );
  }

  return { valid: true, errors: [] };
}
