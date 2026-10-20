import { describe, expect, it, vi } from "vitest";
import {
  checkCouncilNoVotesBeforeDeadline,
  type EscalatedMarketRecord,
} from "../src/aggregator/council-inactivity-monitor.js";

const HOUR = 60 * 60 * 1_000;
const NOW = new Date("2026-01-10T12:00:00.000Z");

function record(overrides: Partial<EscalatedMarketRecord> = {}): EscalatedMarketRecord {
  return {
    marketId: "1",
    escalatedAt: new Date(NOW.getTime() - 68 * HOUR),
    councilDeadline: new Date(NOW.getTime() + 4 * HOUR),
    status: "escalated",
    hasCouncilVotes: false,
    ...overrides,
  };
}

describe("checkCouncilNoVotesBeforeDeadline (#917)", () => {
  it("pages SEV1 when an escalated dispute has no votes inside the page window", async () => {
    const onAlert = vi.fn();
    const alerts = await checkCouncilNoVotesBeforeDeadline([record()], NOW, {
      pageBeforeDeadlineHours: 6,
      onAlert,
    });

    expect(alerts).toEqual([
      {
        marketId: "1",
        severity: "SEV1",
        escalatedAt: new Date(NOW.getTime() - 68 * HOUR).toISOString(),
        councilDeadline: new Date(NOW.getTime() + 4 * HOUR).toISOString(),
        hoursRemaining: 4,
        windowElapsedPercent: 94,
        detectedAt: NOW.toISOString(),
      },
    ]);
    expect(onAlert).toHaveBeenCalledWith(alerts[0]);
  });

  it("does not page when a council member has voted", async () => {
    const alerts = await checkCouncilNoVotesBeforeDeadline([record({ hasCouncilVotes: true })], NOW);
    expect(alerts).toHaveLength(0);
  });

  it("does not page for disputes that are no longer escalated", async () => {
    const alerts = await checkCouncilNoVotesBeforeDeadline([record({ status: "resolved" })], NOW);
    expect(alerts).toHaveLength(0);
  });

  it("does not page before the page window opens", async () => {
    const alerts = await checkCouncilNoVotesBeforeDeadline(
      [record({ councilDeadline: new Date(NOW.getTime() + 10 * HOUR) })],
      NOW,
      { pageBeforeDeadlineHours: 6 },
    );
    expect(alerts).toHaveLength(0);
  });

  it("does not page once the window has already closed", async () => {
    const alerts = await checkCouncilNoVotesBeforeDeadline(
      [record({ councilDeadline: new Date(NOW.getTime() - HOUR) })],
      NOW,
    );
    expect(alerts).toHaveLength(0);
  });

  it("defaults the page window to 6 hours", async () => {
    const inside = record({ marketId: "in", councilDeadline: new Date(NOW.getTime() + 6 * HOUR) });
    const outside = record({ marketId: "out", councilDeadline: new Date(NOW.getTime() + 7 * HOUR) });
    const alerts = await checkCouncilNoVotesBeforeDeadline([inside, outside], NOW);
    expect(alerts.map((alert) => alert.marketId)).toEqual(["in"]);
  });

  it("pages each dispute once when given a paged set, and re-arms after it clears", async () => {
    const paged = new Set<string>();

    expect(await checkCouncilNoVotesBeforeDeadline([record()], NOW, { pagedMarketIds: paged })).toHaveLength(1);
    expect(paged.has("1")).toBe(true);

    const later = new Date(NOW.getTime() + HOUR);
    expect(await checkCouncilNoVotesBeforeDeadline([record()], later, { pagedMarketIds: paged })).toHaveLength(0);

    // A vote arrives: the market drops out of the paged set.
    await checkCouncilNoVotesBeforeDeadline([record({ hasCouncilVotes: true })], later, { pagedMarketIds: paged });
    expect(paged.size).toBe(0);

    // If it later shows up with zero votes again it pages afresh.
    expect(await checkCouncilNoVotesBeforeDeadline([record()], later, { pagedMarketIds: paged })).toHaveLength(1);
  });
});
