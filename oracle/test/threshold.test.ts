import { describe, expect, it, vi } from "vitest";

import {
  selectThresholdOutcome,
  type CouncilVote,
} from "../src/aggregator/threshold.js";
import { computeTally } from "../src/aggregator/tally.js";
import { CouncilVoteManager } from "../src/aggregator/council-votes.js";

const yes = (member: string): CouncilVote => ({ member, outcome: true });
const no = (member: string): CouncilVote => ({ member, outcome: false });

describe("selectThresholdOutcome", () => {
  it("returns true when YES reaches the threshold and NO does not", () => {
    const votes = [yes("a"), yes("b"), yes("c"), no("d")];
    expect(selectThresholdOutcome(votes, 3)).toBe(true);
  });

  it("returns false when NO reaches the threshold and YES does not", () => {
    const votes = [no("a"), no("b"), no("c"), yes("d")];
    expect(selectThresholdOutcome(votes, 3)).toBe(false);
  });

  it("returns null when neither outcome reaches the threshold", () => {
    expect(selectThresholdOutcome([yes("a"), no("b")], 3)).toBeNull();
  });

  it("returns null (ambiguous) when both outcomes reach the threshold", () => {
    const votes = [yes("a"), yes("b"), no("c"), no("d")];
    expect(selectThresholdOutcome(votes, 2)).toBeNull();
  });

  it("returns null for an empty ballot", () => {
    expect(selectThresholdOutcome([], 1)).toBeNull();
  });

  it("counts each member once, with the member's latest submission winning", () => {
    // 'a' flips YES -> NO; only the final NO counts, so NO = {a,b,c} = 3.
    expect(selectThresholdOutcome([yes("a"), no("a"), no("b"), no("c")], 3)).toBe(false);
    // Same members, 'a' flips NO -> YES the other way: YES = {a,b,c} = 3.
    expect(selectThresholdOutcome([no("a"), yes("a"), yes("b"), yes("c")], 3)).toBe(true);
  });

  it("trims member identifiers and ignores blank ones", () => {
    const votes = [yes("  a  "), yes("a"), yes("b"), no("   ")];
    // "  a  " and "a" are the same member -> YES has {a, b} = 2.
    expect(selectThresholdOutcome(votes, 2)).toBe(true);
    expect(selectThresholdOutcome(votes, 3)).toBeNull();
  });

  it("is deterministic regardless of vote ordering", () => {
    const base = [yes("a"), yes("b"), no("c"), no("d"), yes("e")];
    const shuffled = [base[3], base[0], base[4], base[2], base[1]];
    expect(selectThresholdOutcome(base, 3)).toBe(
      selectThresholdOutcome(shuffled as CouncilVote[], 3),
    );
    expect(selectThresholdOutcome(base, 3)).toBe(true);
  });

  it("rejects a non-positive or non-integer threshold", () => {
    expect(() => selectThresholdOutcome([yes("a")], 0)).toThrow(RangeError);
    expect(() => selectThresholdOutcome([yes("a")], -1)).toThrow(
      "threshold must be a positive integer",
    );
    expect(() => selectThresholdOutcome([yes("a")], 1.5)).toThrow(RangeError);
    expect(() => selectThresholdOutcome([yes("a")], Number.NaN)).toThrow(RangeError);
  });

  it("logs the de-duplicated tally with the resolved outcome", () => {
    const info = vi.fn();
    const logger = { info, warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    type LoggerArg = Parameters<typeof selectThresholdOutcome>[2];
    selectThresholdOutcome(
      [yes("a"), yes("a"), yes("b"), yes("c"), no("d")],
      3,
      logger as unknown as LoggerArg,
      "market-42",
    );
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      "vote tally",
      expect.objectContaining({
        marketId: "market-42",
        yes: 3,
        no: 1,
        threshold: 3,
        totalMembers: 4,
        ambiguous: false,
        outcome: true,
      }),
    );
  });
});

describe("computeTally", () => {
  it("agrees with selectThresholdOutcome on the de-duplicated counts", () => {
    const votes = [yes("a"), no("a"), yes("b"), yes("c"), yes("c")];
    const tally = computeTally("m1", votes);
    expect(tally).toMatchObject({
      marketId: "m1",
      yesVotes: 2, // b, c
      noVotes: 1, // a (latest)
      totalVoters: 3,
    });
    expect(tally.votes).toHaveLength(3);
    expect(selectThresholdOutcome(tally.votes, 2)).toBe(true);
  });

  it("returns an empty tally for no submissions", () => {
    expect(computeTally("m2", [])).toEqual({
      marketId: "m2",
      yesVotes: 0,
      noVotes: 0,
      totalVoters: 0,
      votes: [],
    });
  });
});

describe("CouncilVoteManager", () => {
  it("de-duplicates re-submissions and resolves against a threshold", () => {
    const mgr = new CouncilVoteManager();
    mgr.submitVote("alice", true);
    mgr.submitVote("alice", false); // re-vote
    mgr.submitVote("bob", false);
    mgr.submitVote("carol", false);

    expect(mgr.getVotes()).toHaveLength(3);
    expect(mgr.getAgreedOutcome(3)).toBe(false);
    expect(mgr.getAgreedOutcome(4)).toBeNull();
  });

  it("rejects a blank council member", () => {
    const mgr = new CouncilVoteManager();
    expect(() => mgr.submitVote("   ", true)).toThrow("Council member is required");
  });
});
