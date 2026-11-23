/**
 * External Call Timeout Manager & Classifiable Errors (#642)
 */

export class ExternalCallTimeoutError extends Error {
  public readonly operationName: string;
  public readonly timeoutMs: number;
  public readonly errorCategory: string = "TIMEOUT_ERROR";

  constructor(operationName: string, timeoutMs: number) {
    super(`External operation '${operationName}' timed out after ${timeoutMs}ms`);
    this.name = "ExternalCallTimeoutError";
    this.operationName = operationName;
    this.timeoutMs = timeoutMs;
  }
}

export interface TimeoutConfig {
  httpAdapterTimeoutMs: number;
  sorobanRpcTimeoutMs: number;
  webhookTimeoutMs: number;
  databaseQueryTimeoutMs: number;
}

export const DEFAULT_TIMEOUT_CONFIG: TimeoutConfig = {
  httpAdapterTimeoutMs: 5_000,
  sorobanRpcTimeoutMs: 10_000,
  webhookTimeoutMs: 4_000,
  databaseQueryTimeoutMs: 3_000,
};

export async function withExternalTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operationName: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new ExternalCallTimeoutError(operationName, timeoutMs));
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([promise, timeoutPromise]);
    return result;
  } finally {
    clearTimeout(timer!);
  }
}
