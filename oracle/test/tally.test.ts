import { describe, expect, it } from "vitest";
import {
  computeTally,
  createPostgresSubmissionStore,
  SubmissionTracker,
  type SubmissionStore,
} from "../src/aggregator/tally.js";

describe("computeTally", () => {
  it("counts yes/no votes and de-duplicates by member", () => {
    const tally = computeTally("42", [
      { member: "alice", outcome: true },
      { member: "bob", outcome: false },
      { member: "alice", outcome: false }, // alice resubmits — latest wins
    ]);

    expect(tally.marketId).toBe("42");
    expect(tally.yesVotes).toBe(0);
    expect(tally.noVotes).toBe(2);
    expect(tally.totalVoters).toBe(2);
    expect(tally.votes).toEqual([
      { member: "alice", outcome: false },
      { member: "bob", outcome: false },
    ]);
  });

  it("ignores blank member identifiers", () => {
    const tally = computeTally("1", [{ member: "  ", outcome: true }]);
    expect(tally.totalVoters).toBe(0);
  });

  it("returns an empty tally with no votes", () => {
    const tally = computeTally("1", []);
    expect(tally).toEqual({ marketId: "1", yesVotes: 0, noVotes: 0, totalVoters: 0, votes: [] });
  });
});

describe("SubmissionTracker", () => {
  function inMemoryStore(): SubmissionStore & { data: Map<string, Map<string, boolean>> } {
    const data = new Map<string, Map<string, boolean>>();
    return {
      data,
      async recordSubmission(marketId, member, outcome) {
        const votes = data.get(marketId) ?? new Map();
        votes.set(member, outcome);
        data.set(marketId, votes);
      },
      async getSubmissions(marketId) {
        const votes = data.get(marketId) ?? new Map();
        return [...votes.entries()].map(([member, outcome]) => ({ member, outcome }));
      },
    };
  }

  it("persists a submission and reflects it in the tally", async () => {
    const store = inMemoryStore();
    const tracker = new SubmissionTracker(store);

    await tracker.submit("7", "alice", true);
    await tracker.submit("7", "bob", true);

    const tally = await tracker.getTally("7");
    expect(tally.yesVotes).toBe(2);
    expect(tally.noVotes).toBe(0);
  });

  it("does not double-count a member's repeat submission", async () => {
    const store = inMemoryStore();
    const tracker = new SubmissionTracker(store);

    await tracker.submit("7", "alice", true);
    await tracker.submit("7", "alice", true);
    await tracker.submit("7", "alice", false); // changes their mind

    const tally = await tracker.getTally("7");
    expect(tally.totalVoters).toBe(1);
    expect(tally.yesVotes).toBe(0);
    expect(tally.noVotes).toBe(1);
  });

  it("rejects a blank marketId or member", async () => {
    const tracker = new SubmissionTracker(inMemoryStore());
    await expect(tracker.submit(" ", "alice", true)).rejects.toThrow("marketId is required");
    await expect(tracker.submit("7", " ", true)).rejects.toThrow("member is required");
  });

  it("keeps each market's tally independent", async () => {
    const store = inMemoryStore();
    const tracker = new SubmissionTracker(store);

    await tracker.submit("1", "alice", true);
    await tracker.submit("2", "alice", false);

    expect((await tracker.getTally("1")).yesVotes).toBe(1);
    expect((await tracker.getTally("2")).noVotes).toBe(1);
  });
});

describe("createPostgresSubmissionStore", () => {
  it("upserts a submission with ON CONFLICT on (market_id, member)", async () => {
    const queries: { text: string; params: unknown[] }[] = [];
    const pool = {
      async query(text: string, params: unknown[] = []) {
        queries.push({ text, params });
        return { rows: [] };
      },
    };

    const store = createPostgresSubmissionStore(pool);
    await store.recordSubmission("42", "alice", true);

    expect(queries).toHaveLength(1);
    expect(queries[0].text).toContain("ON CONFLICT (market_id, member)");
    expect(queries[0].params).toEqual(["42", "alice", true]);
  });

  it("reads submissions back as council votes", async () => {
    const pool = {
      async query() {
        return { rows: [{ member: "alice", outcome: true }, { member: "bob", outcome: false }] };
      },
    };

    const store = createPostgresSubmissionStore(pool);
    const votes = await store.getSubmissions("42");
    expect(votes).toEqual([
      { member: "alice", outcome: true },
      { member: "bob", outcome: false },
    ]);
  });
});
