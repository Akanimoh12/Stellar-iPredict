import { describe, expect, it, vi } from "vitest";
import { logOracleSubmissionAttempt } from "../lib/log.js";

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
