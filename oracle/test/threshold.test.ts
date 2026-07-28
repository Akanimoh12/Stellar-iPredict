import { describe, expect, it } from "vitest";
import { selectThresholdOutcome, type CouncilVote } from "../src/aggregator/threshold.js";

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
});
