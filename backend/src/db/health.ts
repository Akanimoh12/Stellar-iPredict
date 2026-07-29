import { pool } from "./pool.js";

export interface HealthCheckResult {
  ok: boolean;
  latencyMs?: number;
  error?: string;
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
