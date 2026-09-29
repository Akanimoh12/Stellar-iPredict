import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { SubmissionTracker, type SubmissionStore } from "../src/aggregator/tally.js";
import { parseSubmitArgs, submitCouncilVote } from "../src/aggregator/submit-cli.js";

describe("parseSubmitArgs", () => {
  it("parses --market and --outcome yes/no", () => {
    expect(parseSubmitArgs(["--market", "42", "--outcome", "yes"])).toEqual({ marketId: "42", outcome: true });
    expect(parseSubmitArgs(["--market", "42", "--outcome", "no"])).toEqual({ marketId: "42", outcome: false });
  });

  it("accepts true/false as outcome synonyms", () => {
    expect(parseSubmitArgs(["--market", "1", "--outcome", "true"]).outcome).toBe(true);
    expect(parseSubmitArgs(["--market", "1", "--outcome", "false"]).outcome).toBe(false);
  });

  it("is order-independent", () => {
    expect(parseSubmitArgs(["--outcome", "yes", "--market", "7"])).toEqual({ marketId: "7", outcome: true });
  });

  it("rejects a missing market id", () => {
    expect(() => parseSubmitArgs(["--outcome", "yes"])).toThrow("--market <id> is required");
  });

  it("rejects a missing outcome", () => {
    expect(() => parseSubmitArgs(["--market", "42"])).toThrow("--outcome <yes|no> is required");
  });

  it("rejects an invalid outcome value", () => {
    expect(() => parseSubmitArgs(["--market", "42", "--outcome", "maybe"])).toThrow('--outcome must be "yes" or "no"');
  });
});

describe("submitCouncilVote", () => {
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

  it("records the vote under the member's own derived public key", async () => {
    const member = Keypair.random();
    const store = inMemoryStore();
    const tracker = new SubmissionTracker(store);

    const result = await submitCouncilVote(
      { memberSecret: member.secret(), councilMembers: [member.publicKey()], tracker },
      { marketId: "42", outcome: true },
    );

    expect(result).toEqual({ member: member.publicKey(), marketId: "42", outcome: true });
    expect(store.data.get("42")?.get(member.publicKey())).toBe(true);
  });

  it("rejects a key that is not a registered council member", async () => {
    const outsider = Keypair.random();
    const tracker = new SubmissionTracker(inMemoryStore());

    await expect(
      submitCouncilVote(
        { memberSecret: outsider.secret(), councilMembers: [Keypair.random().publicKey()], tracker },
        { marketId: "42", outcome: true },
      ),
    ).rejects.toThrow("not a registered council member");
  });

  it("does not double-count a member re-submitting", async () => {
    const member = Keypair.random();
    const store = inMemoryStore();
    const tracker = new SubmissionTracker(store);
    const deps = { memberSecret: member.secret(), councilMembers: [member.publicKey()], tracker };

    await submitCouncilVote(deps, { marketId: "42", outcome: true });
    await submitCouncilVote(deps, { marketId: "42", outcome: false });

    const tally = await tracker.getTally("42");
    expect(tally.totalVoters).toBe(1);
    expect(tally.noVotes).toBe(1);
  });
});
