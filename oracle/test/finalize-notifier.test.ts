import { describe, expect, it, vi } from "vitest";
import { notifyFinalized, type FinalizeNotification } from "../src/aggregator/finalize-notifier.js";

function createNotification(overrides: Partial<FinalizeNotification> = {}): FinalizeNotification {
  return {
    marketId: "42",
    decision: true,
    txHash: "abc123",
    councilVotes: [
      { member: "GAAA", outcome: true },
      { member: "GBBB", outcome: true },
    ],
    finalizedAt: "2026-07-29T00:00:00.000Z",
    ...overrides,
  } as FinalizeNotification;
}

function createLogger() {
  return { info: vi.fn(), warn: vi.fn() };
}

describe("notifyFinalized", () => {
  it("always logs the finalization even when no webhook is configured", async () => {
    const logger = createLogger();

    const delivered = await notifyFinalized(createNotification(), { logger });

    expect(delivered).toBe(true);
    expect(logger.info).toHaveBeenCalledOnce();
    const [message, meta] = logger.info.mock.calls[0];
    expect(message).toContain("42");
    expect(meta).toMatchObject({ marketId: "42", decision: "yes", txHash: "abc123", voters: 2 });
  });

  it("posts a JSON payload to the webhook when configured", async () => {
    const logger = createLogger();
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    const delivered = await notifyFinalized(createNotification(), {
      webhookUrl: "https://hook.example/finalized",
      fetchFn: fetchFn as unknown as typeof fetch,
      logger,
    });

    expect(delivered).toBe(true);
    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("https://hook.example/finalized");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ event: "market_finalized", marketId: "42", decision: "yes", voters: 2 });
  });

  it("swallows a webhook failure so finalization is never rolled back", async () => {
    const logger = createLogger();
    const fetchFn = vi.fn().mockRejectedValue(new Error("network down"));

    const delivered = await notifyFinalized(createNotification(), {
      webhookUrl: "https://hook.example/finalized",
      fetchFn: fetchFn as unknown as typeof fetch,
      logger,
    });

    expect(delivered).toBe(false);
    expect(logger.warn).toHaveBeenCalledOnce();
    // Logging still happened, so the event is auditable despite the failed webhook.
    expect(logger.info).toHaveBeenCalledOnce();
  });

  it("reports a non-2xx webhook response as a non-delivery", async () => {
    const logger = createLogger();
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 503 });

    const delivered = await notifyFinalized(createNotification(), {
      webhookUrl: "https://hook.example/finalized",
      fetchFn: fetchFn as unknown as typeof fetch,
      logger,
    });

    expect(delivered).toBe(false);
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it("normalises a false decision to 'no'", async () => {
    const logger = createLogger();

    await notifyFinalized(createNotification({ decision: false }), { logger });

    const [, meta] = logger.info.mock.calls[0];
    expect(meta).toMatchObject({ decision: "no" });
  });
});
