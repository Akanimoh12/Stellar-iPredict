import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  withTransaction,
  withTransactionRetry,
  isRetryableTransactionError,
  calculateRetryDelay,
  RETRYABLE_SQLSTATE_CODES,
} from "./tx.js";
import { getClient } from "./pool.js";
import { type PoolClient } from "pg";

vi.mock("./pool.js", () => ({
  getClient: vi.fn(),
}));

interface PostgresErrorLike extends Error {
  code?: string;
}

function makePgError(message: string, code: string): PostgresErrorLike {
  const err: PostgresErrorLike = new Error(message);
  err.code = code;
  return err;
}

describe("withTransaction", () => {
  let mockClient: any;

  beforeEach(() => {
    mockClient = {
      query: vi.fn().mockResolvedValue(undefined),
      release: vi.fn(),
    };
    vi.mocked(getClient).mockResolvedValue(mockClient as unknown as PoolClient);
  });

  it("should commit the transaction on success", async () => {
    const mockResult = { id: 1 };
    const fn = vi.fn().mockResolvedValue(mockResult);

    const result = await withTransaction(fn);

    expect(getClient).toHaveBeenCalled();
    expect(mockClient.query).toHaveBeenNthCalledWith(1, "BEGIN");
    expect(fn).toHaveBeenCalledWith(mockClient);
    expect(mockClient.query).toHaveBeenNthCalledWith(2, "COMMIT");
    expect(mockClient.release).toHaveBeenCalled();
    expect(result).toBe(mockResult);
  });

  it("should rollback the transaction on error", async () => {
    const error = new Error("Test error");
    const fn = vi.fn().mockRejectedValue(error);

    await expect(withTransaction(fn)).rejects.toThrow(error);

    expect(getClient).toHaveBeenCalled();
    expect(mockClient.query).toHaveBeenNthCalledWith(1, "BEGIN");
    expect(fn).toHaveBeenCalledWith(mockClient);
    expect(mockClient.query).toHaveBeenNthCalledWith(2, "ROLLBACK");
    expect(mockClient.release).toHaveBeenCalled();

    // Ensure COMMIT was not called
    expect(mockClient.query).not.toHaveBeenCalledWith("COMMIT");
  });
});

describe("isRetryableTransactionError", () => {
  it("identifies 40001 serialization_failure as retryable", () => {
    expect(isRetryableTransactionError(makePgError("serialization failure", "40001"))).toBe(true);
  });

  it("identifies 40P01 deadlock_detected as retryable", () => {
    expect(isRetryableTransactionError(makePgError("deadlock detected", "40P01"))).toBe(true);
  });

  it("identifies 23505 unique_violation as non-retryable", () => {
    expect(isRetryableTransactionError(makePgError("duplicate key", "23505"))).toBe(false);
  });

  it("identifies standard errors without SQLSTATE code as non-retryable", () => {
    expect(isRetryableTransactionError(new Error("generic error"))).toBe(false);
    expect(isRetryableTransactionError(null)).toBe(false);
    expect(isRetryableTransactionError(undefined)).toBe(false);
    expect(isRetryableTransactionError("string error")).toBe(false);
  });
});

describe("calculateRetryDelay", () => {
  it("calculates delay within exponential bounds and applies jitter", () => {
    for (let attempt = 1; attempt <= 5; attempt++) {
      const delay = calculateRetryDelay(attempt, 50, 1000, 2);
      const maxExpected = Math.min(50 * Math.pow(2, attempt - 1), 1000);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(maxExpected);
    }
  });
});

describe("withTransactionRetry", () => {
  let mockClient: any;
  let mockSleep: (ms: number) => Promise<void>;
  let sleepCalls: number[];

  beforeEach(() => {
    mockClient = {
      query: vi.fn().mockResolvedValue(undefined),
      release: vi.fn(),
    };
    vi.mocked(getClient).mockResolvedValue(mockClient as unknown as PoolClient);
    sleepCalls = [];
    mockSleep = vi.fn(async (ms: number) => {
      sleepCalls.push(ms);
    });
  });

  it("succeeds on the first attempt without retrying", async () => {
    const fn = vi.fn().mockResolvedValue("success");

    const result = await withTransactionRetry(fn, { sleep: mockSleep });

    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(mockSleep).not.toHaveBeenCalled();
    expect(mockClient.query).toHaveBeenCalledWith("BEGIN");
    expect(mockClient.query).toHaveBeenCalledWith("COMMIT");
  });

  it("retries on SQLSTATE 40001 (serialization failure) and succeeds on later attempt", async () => {
    const serializationError = makePgError("could not serialize access", "40001");
    const fn = vi
      .fn()
      .mockRejectedValueOnce(serializationError)
      .mockRejectedValueOnce(serializationError)
      .mockResolvedValueOnce("recovered_value");

    const result = await withTransactionRetry(fn, {
      maxAttempts: 4,
      initialDelayMs: 10,
      maxDelayMs: 100,
      sleep: mockSleep,
    });

    expect(result).toBe("recovered_value");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(mockSleep).toHaveBeenCalledTimes(2);
  });

  it("retries on SQLSTATE 40P01 (deadlock detected) and succeeds on later attempt", async () => {
    const deadlockError = makePgError("deadlock detected", "40P01");
    const fn = vi
      .fn()
      .mockRejectedValueOnce(deadlockError)
      .mockResolvedValueOnce("deadlock_recovered");

    const result = await withTransactionRetry(fn, {
      maxAttempts: 3,
      initialDelayMs: 10,
      sleep: mockSleep,
    });

    expect(result).toBe("deadlock_recovered");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(mockSleep).toHaveBeenCalledTimes(1);
  });

  it("does not retry on constraint violation (SQLSTATE 23505) and throws immediately", async () => {
    const constraintError = makePgError("unique constraint violation", "23505");
    const fn = vi.fn().mockRejectedValue(constraintError);

    await expect(
      withTransactionRetry(fn, {
        maxAttempts: 5,
        sleep: mockSleep,
      })
    ).rejects.toThrow(constraintError);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(mockSleep).not.toHaveBeenCalled();
  });

  it("does not retry on arbitrary non-SQLSTATE errors and throws immediately", async () => {
    const genericError = new Error("TypeError: something failed");
    const fn = vi.fn().mockRejectedValue(genericError);

    await expect(
      withTransactionRetry(fn, {
        maxAttempts: 5,
        sleep: mockSleep,
      })
    ).rejects.toThrow(genericError);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(mockSleep).not.toHaveBeenCalled();
  });

  it("respects maxAttempts attempt cap and propagates the original error when exhausted", async () => {
    const serializationError = makePgError("could not serialize access", "40001");
    const fn = vi.fn().mockRejectedValue(serializationError);

    await expect(
      withTransactionRetry(fn, {
        maxAttempts: 3,
        initialDelayMs: 10,
        sleep: mockSleep,
      })
    ).rejects.toThrow(serializationError);

    expect(fn).toHaveBeenCalledTimes(3);
    expect(mockSleep).toHaveBeenCalledTimes(2);
  });
});
