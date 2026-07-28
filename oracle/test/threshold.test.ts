import { describe, expect, it } from "vitest";
import { selectThresholdOutcome, type CouncilVote } from "../src/aggregator/threshold.js";
import { createLogger } from "../src/log.js";

const votes = (...outcomes: boolean[]): CouncilVote[] =>
  outcomes.map((outcome, index) => ({ member: `council-${index + 1}`, outcome }));

describe("selectThresholdOutcome", () => {
  it("returns true when four members agree on yes", () => {
    expect(selectThresholdOutcome(votes(true, true, false, true, true), 4)).toBe(true);
  });

  it("returns false when four members agree on no", () => {
    expect(selectThresholdOutcome(votes(false, true, false, false, false), 4)).toBe(false);
  });

  it("returns null below threshold", () => {
    expect(selectThresholdOutcome(votes(true, true, true), 4)).toBeNull();
  });

  it("does not prematurely finalize a 3-3 split", () => {
    expect(selectThresholdOutcome(votes(true, false, true, false, true, false), 4)).toBeNull();
  });

  it("counts each council member once", () => {
    const replayed = [
      { member: "alice", outcome: true },
      { member: "alice", outcome: true },
      { member: "bob", outcome: true },
      { member: "carol", outcome: true },
    ];
    expect(selectThresholdOutcome(replayed, 4)).toBeNull();
  });

  it("returns null rather than choosing an ambiguous dual threshold", () => {
    expect(selectThresholdOutcome(votes(true, true, false, false), 2)).toBeNull();
  });

  it("logs a structured tally with the marketId and outcome", () => {
    const lines: string[] = [];
    const logger = createLogger({ sink: (line) => lines.push(line), timestamp: () => "2026-07-28T00:00:00.000Z" });

    selectThresholdOutcome(votes(true, true, false, true, true), 4, logger, "market-9");

    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(record).toMatchObject({
      message: "vote tally",
      marketId: "market-9",
      yes: 4,
      no: 1,
      threshold: 4,
      totalMembers: 5,
      ambiguous: false,
      outcome: true,
    });
  });

  it("logs ambiguous: true and a null outcome for an unresolved split", () => {
    const lines: string[] = [];
    const logger = createLogger({ sink: (line) => lines.push(line) });

    selectThresholdOutcome(votes(true, true, false, false), 2, logger);

    const record = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(record).toMatchObject({ ambiguous: true, outcome: null, marketId: null });
  });
});
