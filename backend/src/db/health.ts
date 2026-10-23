import { getClient, pool } from "./pool.js";

export interface HealthCheckResult {
  ok: boolean;
  latencyMs?: number;
  error?: string;
  /** For write checks: distinguishes read-only from fully unavailable */
  readOnly?: boolean;
}

export interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
}

const DEFAULT_RETRY_OPTIONS: Required<RetryOptions> = {
  maxRetries: 10,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
};

/**
 * Pings the database to check connectivity and measure latency.
 *
 * @returns Health check result with ok status and latency in milliseconds
 */
export async function pingDb(): Promise<HealthCheckResult> {
  const start = Date.now();

  try {
    await pool.query("SELECT 1");
    const latencyMs = Date.now() - start;

    return {
      ok: true,
      latencyMs,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Checks database write capability by attempting a write and rolling back.
 *
 * A no-op update against a permanent table verifies the database accepts
 * writes without changing rows or leaving residue.
 *
 * @returns Health check result with ok status, latency, and readOnly flag
 */
export async function checkWriteCapability(): Promise<HealthCheckResult> {
  const start = Date.now();
  let client: Awaited<ReturnType<typeof getClient>> | undefined;

  try {
    client = await getClient();
    await client.query("BEGIN");

    // A no-op update still requires write access to a permanent table.
    await client.query("UPDATE markets SET updated_at = updated_at WHERE FALSE");
    await client.query("ROLLBACK");

    const latencyMs = Date.now() - start;

    return {
      ok: true,
      latencyMs,
      readOnly: false,
    };
  } catch (error) {
    // Ensure we roll back on error too
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("Failed to roll back the database write health check:", rollbackError);
      }
    }

    const latencyMs = Date.now() - start;
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Check for read-only error (SQLSTATE 25006 or similar)
    const isReadOnly = isReadOnlyError(error);

    return {
      ok: false,
      latencyMs,
      error: errorMessage,
      readOnly: isReadOnly,
    };
  } finally {
    if (client) {
      client.release();
    }
  }
}

/**
 * Check if an error indicates a read-only database.
 * SQLSTATE 25006 = read_only_sql_transaction
 * Read-only recovery and standby messages cover other PostgreSQL variants.
 */
function isReadOnlyError(error: unknown): boolean {
  if (typeof error === "object" && error !== null) {
    const err = error as { code?: unknown; message?: unknown };
    if (err.code === "25006") {
      return true;
    }
    if (typeof err.message === "string") {
      const msg = err.message.toLowerCase();
      if (
        msg.includes("read-only") ||
        msg.includes("read only") ||
        msg.includes("recovery mode") ||
        msg.includes("standby")
      ) {
        return true;
      }
    }
  }
  return false;
}

/** Upper bound on how long a single readiness check may take. */
export const HEALTH_CHECK_TIMEOUT_MS = 2000;

/**
 * Bounds a health check's runtime so a hung dependency can't hang the probe.
 *
 * A readiness check left to hang is worse than one that answers "unhealthy"
 * promptly: most orchestrators treat a probe timeout as a slower, noisier
 * failure signal than an explicit unhealthy response.
 */
export function withHealthTimeout(
  check: Promise<HealthCheckResult>,
  timeoutMs: number = HEALTH_CHECK_TIMEOUT_MS
): Promise<HealthCheckResult> {
  return Promise.race([
    check,
    new Promise<HealthCheckResult>((resolve) => {
      setTimeout(() => resolve({ ok: false, error: `timed out after ${timeoutMs}ms` }), timeoutMs);
    }),
  ]);
}

/**
 * Retries database connection with exponential backoff.
 * Useful for startup when the database might not be immediately available.
 * 
 * @param options - Retry configuration options
 * @throws Error if all retries are exhausted
 */
export async function retryConnection(options: RetryOptions = {}): Promise<void> {
  const opts = { ...DEFAULT_RETRY_OPTIONS, ...options };
  let currentDelay = opts.initialDelayMs;
  
  for (let attempt = 1; attempt <= opts.maxRetries; attempt++) {
    try {
      const result = await pingDb();
      
      if (result.ok) {
        console.log(`[db] Connected successfully (attempt ${attempt}/${opts.maxRetries})`);
        return;
      }
      
      const isConnectionRefused = result.error?.includes("ECONNREFUSED") ||
                                   result.error?.includes("connect") ||
                                   result.error?.includes("connection");
      
      if (!isConnectionRefused) {
        throw new Error(`Database ping failed: ${result.error}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isConnectionRefused = errorMessage.includes("ECONNREFUSED") ||
                                   errorMessage.includes("connect") ||
                                   errorMessage.includes("connection");
      
      if (!isConnectionRefused) {
        throw error;
      }
    }
    
    if (attempt < opts.maxRetries) {
      console.log(
        `[db] Connection attempt ${attempt}/${opts.maxRetries} failed. ` +
        `Retrying in ${currentDelay}ms...`
      );
      await sleep(currentDelay);
      currentDelay = Math.min(currentDelay * opts.backoffMultiplier, opts.maxDelayMs);
    }
  }
  
  throw new Error(
    `Failed to connect to database after ${opts.maxRetries} attempts. ` +
    `Last delay was ${currentDelay}ms.`
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
