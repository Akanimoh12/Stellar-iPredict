import { describe, expect, it } from "vitest";
import { detectConflict } from "../src/aggregator/conflict-detection.js";
import type { CouncilVote } from "../src/aggregator/threshold.js";

const votes = (...outcomes: boolean[]): CouncilVote[] =>
  outcomes.map((outcome, index) => ({ member: `council-${index + 1}`, outcome }));

describe("detectConflict", () => {
  it("flags a market when disagreement exceeds the threshold", () => {
    // 3 yes, 2 no → 40% disagreement
    const report = detectConflict("42", votes(true, true, true, false, false), 0.3);
    expect(report.conflicting).toBe(true);
    expect(report.yesVotes).toBe(3);
    expect(report.noVotes).toBe(2);
    expect(report.disagreementRatio).toBeCloseTo(0.4);
  });

  it("does not flag a market when disagreement is below the threshold", () => {
    // 4 yes, 1 no → 20% disagreement
    const report = detectConflict("42", votes(true, true, true, true, false), 0.3);
    expect(report.conflicting).toBe(false);
    expect(report.disagreementRatio).toBeCloseTo(0.2);
  });

  it("handles unanimous agreement (0% disagreement)", () => {
    const report = detectConflict("42", votes(true, true, true), 0.3);
    expect(report.conflicting).toBe(false);
    expect(report.disagreementRatio).toBe(0);
  });

  it("handles an even split as maximum disagreement", () => {
    // 2 yes, 2 no → 50% disagreement
    const report = detectConflict("42", votes(true, true, false, false), 0.3);
    expect(report.conflicting).toBe(true);
    expect(report.disagreementRatio).toBe(0.5);
  });

  it("deduplicates votes by member (latest wins)", () => {
    const duped: CouncilVote[] = [
      { member: "alice", outcome: true },
      { member: "alice", outcome: false }, // override
      { member: "bob", outcome: true },
      { member: "carol", outcome: true },
    ];
    // alice=false, bob=true, carol=true → 1/3 ≈ 33% disagreement
    const report = detectConflict("42", duped, 0.3);
    expect(report.conflicting).toBe(true);
    expect(report.totalVoters).toBe(3);
  });

  it("returns zero disagreement for an empty vote set", () => {
    const report = detectConflict("42", [], 0.3);
    expect(report.conflicting).toBe(false);
    expect(report.disagreementRatio).toBe(0);
    expect(report.totalVoters).toBe(0);
  });

  it("rejects out-of-range threshold values", () => {
    expect(() => detectConflict("42", votes(true), -0.1)).toThrow("between 0 and 1");
    expect(() => detectConflict("42", votes(true), 1.1)).toThrow("between 0 and 1");
  });

  it("includes the market id in the report", () => {
    const report = detectConflict("abc-123", votes(true), 0.3);
    expect(report.marketId).toBe("abc-123");
  });
});
