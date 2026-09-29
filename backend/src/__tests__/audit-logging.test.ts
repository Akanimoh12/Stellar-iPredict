import { describe, expect, it, vi } from "vitest";
import {
  logOracleAuthFailure,
  logOracleAuthFailureSpike,
  logOracleSubmissionAttempt,
} from "../lib/log.js";

describe("Oracle audit logging", () => {
  it("should log accepted submissions at info level", () => {
    const mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    logOracleSubmissionAttempt(
      {
        requestId: "test-request-123",
        provider: "GPROVIDER123",
        marketId: 42,
        outcome: "accepted",
      },
      mockLogger,
    );

    expect(mockLogger.info).toHaveBeenCalledWith(
      {
        requestId: "test-request-123",
        provider: "GPROVIDER123",
        marketId: 42,
        outcome: "accepted",
      },
      "oracle submission accepted",
    );
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it("should log rejected submissions at warn level with reason", () => {
    const mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    logOracleSubmissionAttempt(
      {
        requestId: "test-request-456",
        provider: "GPROVIDER456",
        marketId: 99,
        outcome: "bad_signature",
        message: "Invalid oracle submission signature",
      },
      mockLogger,
    );

    expect(mockLogger.warn).toHaveBeenCalledWith(
      {
        requestId: "test-request-456",
        provider: "GPROVIDER456",
        marketId: 99,
        outcome: "bad_signature",
        message: "Invalid oracle submission signature",
      },
      "oracle submission bad_signature",
    );
    expect(mockLogger.info).not.toHaveBeenCalled();
  });

  it("should never log secrets like API keys or signatures", () => {
    const mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
    };

    logOracleSubmissionAttempt(
      {
        requestId: "test-request-789",
        provider: "GPROVIDER789",
        marketId: 10,
        outcome: "bad_request",
        message: "Invalid request format",
      },
      mockLogger,
    );

    // Verify that the logged output doesn't contain any suspicious patterns
    const callArg = mockLogger.warn.mock.calls[0][0];
    expect(JSON.stringify(callArg)).not.toContain("secret");
    expect(JSON.stringify(callArg)).not.toContain("key");
    expect(JSON.stringify(callArg)).not.toContain("signature");
    expect(JSON.stringify(callArg)).not.toContain("token");
  });

  it("should log duplicate market submissions with specific outcome", () => {
    const mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
    };

    logOracleSubmissionAttempt(
      {
        requestId: "test-request-dup",
        provider: "GPROVIDER_DUP",
        marketId: 50,
        outcome: "duplicate_market",
        message: "Market 50 already has an oracle submission",
      },
      mockLogger,
    );

    expect(mockLogger.warn).toHaveBeenCalled();
    const callArg = mockLogger.warn.mock.calls[0][0];
    expect(callArg.outcome).toBe("duplicate_market");
    expect(callArg.message).toContain("already has");
  });

  it("should include correlation id in all log entries for tracing", () => {
    const mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
    };

    const correlationId = "correlation-id-xyz-123";

    logOracleSubmissionAttempt(
      {
        requestId: correlationId,
        provider: "GPROVIDER",
        marketId: 1,
        outcome: "bad_key",
        message: "Provider not registered",
      },
      mockLogger,
    );

    const callArg = mockLogger.warn.mock.calls[0][0];
    expect(callArg.requestId).toBe(correlationId);
  });
});

describe("Oracle authentication-failure logging (#576)", () => {
  it("logs the reason and source, never the attempted credential", () => {
    const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    logOracleAuthFailure(
      {
        requestId: "req-1",
        reason: "invalid_key",
        source: "203.0.113.7",
        scheme: "bearer",
        message: "Invalid API key",
      },
      mockLogger,
    );

    expect(mockLogger.warn).toHaveBeenCalledWith(
      {
        requestId: "req-1",
        reason: "invalid_key",
        source: "203.0.113.7",
        scheme: "bearer",
        message: "Invalid API key",
      },
      "oracle auth failure invalid_key",
    );

    const serialized = JSON.stringify(mockLogger.warn.mock.calls[0][0]);
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("key=");
    // No field exists to carry the attempted key at all — the shape is the
    // guarantee.
    expect(Object.keys(mockLogger.warn.mock.calls[0][0])).not.toContain("key");
    expect(Object.keys(mockLogger.warn.mock.calls[0][0])).not.toContain("token");
  });

  it("omits fields that are not known rather than logging nulls", () => {
    const mockLogger = { info: vi.fn(), warn: vi.fn() };

    logOracleAuthFailure(
      { requestId: "req-2", reason: "missing_header", source: "10.0.0.1" },
      mockLogger,
    );

    expect(mockLogger.warn.mock.calls[0][0]).toEqual({
      requestId: "req-2",
      reason: "missing_header",
      source: "10.0.0.1",
    });
  });

  it("logs a distributed-guessing spike at error level", () => {
    const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    logOracleAuthFailureSpike(
      {
        requestId: "req-3",
        level: "critical",
        pattern: "distributed_guessing",
        windowFailures: 42,
        distinctSources: 17,
        topSource: "198.51.100.1",
        byReason: {
          missing_header: 0,
          invalid_key: 42,
          provider_mismatch: 0,
          not_configured: 0,
        },
      },
      mockLogger,
    );

    expect(mockLogger.error).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).not.toHaveBeenCalled();
    const [fields, message] = mockLogger.error.mock.calls[0];
    expect(message).toBe("oracle auth failure spike: distributed_guessing");
    expect(fields.pattern).toBe("distributed_guessing");
    expect(fields.distinctSources).toBe(17);
  });

  it("logs a misconfiguration spike at warn level", () => {
    const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    logOracleAuthFailureSpike(
      {
        level: "warning",
        pattern: "misconfigured_provider",
        windowFailures: 12,
        distinctSources: 1,
        byReason: {
          missing_header: 0,
          invalid_key: 0,
          provider_mismatch: 12,
          not_configured: 0,
        },
      },
      mockLogger,
    );

    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it("calls the method on the logger so pino keeps its message prefix", () => {
    // Regression guard: pino reads `this` when formatting, so an extracted
    // `logger.warn` reference throws when handed a real request logger.
    const seen: { self: unknown } = { self: undefined };
    const logger = {
      warn(this: unknown, _fields: unknown, _message: string) {
        seen.self = this;
      },
    };

    logOracleAuthFailure({ requestId: "req-4", reason: "invalid_key" }, logger);
    expect(seen.self).toBe(logger);
  });
});
