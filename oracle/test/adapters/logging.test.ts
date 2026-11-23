import { describe, expect, it, vi } from "vitest";
import {
  buildResolutionProvenance,
  logResolutionProvenance,
  consoleAdapterLogger,
} from "../../src/adapters/logging.js";

describe("structured provenance logging", () => {
  it("builds structured provenance items with provider, request time, raw value and threshold", () => {
    const sources = [
      {
        provider: "binance",
        adapterId: "binance-adapter",
        respondedAt: "2026-11-21T12:00:00.000Z",
        raw: { price: "95000.50" },
      },
      {
        adapterId: "coingecko-adapter",
        raw: { bitcoin: { usd: 95100 } },
      },
    ];

    const provenance = buildResolutionProvenance(sources, 90000);
    expect(provenance).toHaveLength(2);
    expect(provenance[0]).toEqual({
      provider: "binance",
      requestTime: "2026-11-21T12:00:00.000Z",
      rawValue: { price: "95000.50" },
      threshold: 90000,
    });
    expect(provenance[1].provider).toBe("coingecko-adapter");
    expect(provenance[1].threshold).toBe(90000);
    expect(provenance[1].rawValue).toEqual({ bitcoin: { usd: 95100 } });
    expect(provenance[1].requestTime).toBeDefined();
  });

  it("logs structured provenance output to logger.info when available", () => {
    const logger = {
      info: vi.fn(),
      error: vi.fn(),
    };

    const sources = [
      {
        provider: "binance",
        respondedAt: "2026-11-21T12:00:00.000Z",
        raw: { price: "100000" },
      },
    ];

    logResolutionProvenance(
      {
        marketId: "market-123",
        status: "resolved",
        outcome: true,
        confidence: 0.95,
        threshold: 95000,
      },
      sources,
      logger,
    );

    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      "oracle.resolution.decision",
      expect.objectContaining({
        marketId: "market-123",
        decision: {
          status: "resolved",
          outcome: true,
          confidence: 0.95,
          threshold: 95000,
        },
        provenance: [
          {
            provider: "binance",
            requestTime: "2026-11-21T12:00:00.000Z",
            rawValue: { price: "100000" },
            threshold: 95000,
          },
        ],
      }),
    );
  });
});
