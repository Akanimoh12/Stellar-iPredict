import { describe, expect, it, vi } from "vitest";
import {
  createAlertRouter,
  createWebhookAlertChannel,
  alertBondDiscrepancy,
  alertBondReconciliationFailure,
  alertStuckMarket,
  alertCircuitBreakerOpen,
  createBetPatternAlertSender,
} from "../src/aggregator/alert.js";

describe("alertBondDiscrepancy (Issue #573)", () => {
  it("creates a critical alert with bond details", () => {
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    
    alertBondDiscrepancy(
      "market-123",
      "GABC123",
      1000000000n,
      null,
      ["GABC123"],
      undefined,
      logger as any,
    );
    
    expect(logger.error).toHaveBeenCalledWith(
      "bond refund discrepancy detected",
      expect.objectContaining({
        type: "oracle.aggregator.bond_discrepancy",
        severity: "SEV1",
        marketId: "market-123",
        submitter: "GABC123",
        expectedAmountStroops: "1000000000",
        actualAmountStroops: null,
        affectedParties: ["GABC123"],
      }),
    );
  });

  it("handles actual amount when settlement exists with wrong amount", () => {
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    
    alertBondDiscrepancy(
      "market-456",
      "GXYZ789",
      2000000000n,
      1500000000n,
      ["GXYZ789"],
      undefined,
      logger as any,
    );
    
    expect(logger.error).toHaveBeenCalledWith(
      "bond refund discrepancy detected",
      expect.objectContaining({
        actualAmountStroops: "1500000000",
      }),
    );
  });
});

describe("alertBondReconciliationFailure (Issue #573)", () => {
  it("creates a critical alert with failure details", () => {
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    const error = new Error("Database connection timeout");
    error.stack = "Error: Database connection timeout\n  at test.ts:123";
    
    alertBondReconciliationFailure(
      error,
      42,
      "2026-09-28T10:00:00Z",
      undefined,
      logger as any,
    );
    
    expect(logger.error).toHaveBeenCalledWith(
      "bond reconciliation job failed",
      expect.objectContaining({
        type: "oracle.aggregator.bond_reconciliation_failure",
        severity: "SEV1",
        error: "Database connection timeout",
        checkedCount: 42,
        lastSuccessfulRun: "2026-09-28T10:00:00Z",
      }),
    );
  });

  it("handles null lastSuccessfulRun", () => {
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    
    alertBondReconciliationFailure(
      new Error("First run failed"),
      0,
      null,
      undefined,
      logger as any,
    );
    
    expect(logger.error).toHaveBeenCalledWith(
      "bond reconciliation job failed",
      expect.objectContaining({
        lastSuccessfulRun: "never",
      }),
    );
  });
});

describe("alertStuckMarket", () => {
  it("creates a warning alert for markets below critical threshold", () => {
    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
    
    alertStuckMarket("market-789", 3.5, undefined, logger as any);
    
    expect(logger.warn).toHaveBeenCalledWith(
      "market stuck - warning lag",
      expect.objectContaining({
        type: "oracle.aggregator.stuck_market",
        severity: "SEV2",
        marketId: "market-789",
        lagHours: 3.5,
      }),
    );
  });

  it("creates a critical alert for markets exceeding critical threshold", () => {
    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
    
    alertStuckMarket("market-999", 7, undefined, logger as any);
    
    expect(logger.error).toHaveBeenCalledWith(
      "market stuck - critical lag",
      expect.objectContaining({
        severity: "SEV1",
        marketId: "market-999",
        lagHours: 7,
      }),
    );
  });
});

describe("alertCircuitBreakerOpen", () => {
  it("creates a warning alert when circuit breaker opens", () => {
    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
    
    alertCircuitBreakerOpen("polymarket", 0.75, undefined, logger as any);
    
    expect(logger.warn).toHaveBeenCalledWith(
      "circuit breaker opened",
      expect.objectContaining({
        type: "oracle.aggregator.circuit_breaker_open",
        severity: "SEV2",
        adapter: "polymarket",
        failureRate: 0.75,
      }),
    );
  });
});

describe("alert delivery retries and per-channel deduplication", () => {
  it("retries failed webhook requests and suppresses the successful delivery during cooldown", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValue({ ok: true, status: 204 });
    const sender = createAlertRouter({
      channels: [
        createWebhookAlertChannel({
          webhookUrl: "https://alerts.example.test",
          fetchImpl: fetchImpl as unknown as typeof fetch,
        }),
      ],
      cooldownMs: 60_000,
      maxRetries: 1,
      retryDelayMs: 0,
      sleep: vi.fn().mockResolvedValue(undefined),
    });
    const alert = { marketId: "market-1", attempts: 2, error: new Error("temporary failure") };

    await sender(alert);
    await sender(alert);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries only failed channels and retains successful channels in the cooldown", async () => {
    const successfulChannel = { name: "primary", minSeverity: "SEV3" as const, send: vi.fn() };
    const recoveringChannel = {
      name: "secondary",
      minSeverity: "SEV3" as const,
      send: vi.fn().mockRejectedValueOnce(new Error("unavailable")).mockResolvedValue(undefined),
    };
    const sender = createAlertRouter({
      channels: [successfulChannel, recoveringChannel],
      cooldownMs: 60_000,
      maxRetries: 0,
    });
    const alert = { marketId: "market-2", attempts: 2, error: new Error("temporary failure") };

    await sender(alert);
    await sender(alert);

    expect(successfulChannel.send).toHaveBeenCalledOnce();
    expect(recoveringChannel.send).toHaveBeenCalledTimes(2);
  });
});

describe("createBetPatternAlertSender", () => {
  it("posts a review-only alert and does not take action on the market", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const send = createBetPatternAlertSender(
      "https://alerts.example.com/review",
      undefined,
      fetchImpl,
    );

    await send({
      marketId: "42",
      windowStart: "2026-10-21T22:00:00Z",
      bettorCount: 3,
      recentNetAmount: "1500000000",
      sameSideShare: "0.95",
    });

    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toMatchObject({
      type: "indexer.bet_pattern.detected",
      action: "manual_review_only",
      marketId: "42",
      bettorCount: 3,
    });
  });

  it("logs a manual-review alert when no webhook is configured", async () => {
    const warn = vi.fn();
    const send = createBetPatternAlertSender(undefined, {
      level: "info",
      child: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn,
      error: vi.fn(),
      log: vi.fn(),
    });
    await send({
      marketId: "42",
      windowStart: "2026-10-21T22:00:00Z",
      bettorCount: 3,
      recentNetAmount: "1500000000",
      sameSideShare: "0.95",
    });
    expect(warn).toHaveBeenCalledWith(
      "betting pattern requires manual review",
      expect.objectContaining({ action: "manual_review_only" }),
    );
  });
});
