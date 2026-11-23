import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";
import { SubmissionTracker, type SubmissionStore } from "../src/aggregator/tally.js";
import {
  formatDryRun,
  parseSubmitArgs,
  submitCouncilVote,
  type SubmitCliDryRunResult,
} from "../src/aggregator/submit-cli.js";

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

  it("parses --dry-run anywhere in argv and leaves it unset otherwise", () => {
    expect(parseSubmitArgs(["--dry-run", "--market", "42", "--outcome", "yes"])).toEqual({
      marketId: "42",
      outcome: true,
      dryRun: true,
    });
    expect(parseSubmitArgs(["--market", "42", "--outcome", "no", "--dry-run"]).dryRun).toBe(true);
    expect(parseSubmitArgs(["--market", "42", "--outcome", "no"]).dryRun).toBeUndefined();
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

  describe("dry run", () => {
    it("reports the projected tally and outcome without writing the vote", async () => {
      const member = Keypair.random();
      const others = [Keypair.random(), Keypair.random(), Keypair.random()].map((k) => k.publicKey());
      const store = inMemoryStore();
      const tracker = new SubmissionTracker(store);
      for (const other of others) await tracker.submit("42", other, true);
      const recordSpy = vi.spyOn(store, "recordSubmission");

      const result = await submitCouncilVote(
        { memberSecret: member.secret(), councilMembers: [member.publicKey(), ...others], tracker, threshold: 4 },
        { marketId: "42", outcome: true, dryRun: true },
      );

      expect(recordSpy).not.toHaveBeenCalled();
      expect(store.data.get("42")?.has(member.publicKey())).toBe(false);
      expect(result).toMatchObject({
        member: member.publicKey(),
        marketId: "42",
        outcome: true,
        dryRun: true,
        simulation: {
          previousOutcome: null,
          projectedTally: { yesVotes: 4, noVotes: 0, totalVoters: 4 },
          projectedOutcome: true,
        },
      });
    });

    it("shows a re-submission replacing the member's existing vote", async () => {
      const member = Keypair.random();
      const store = inMemoryStore();
      const tracker = new SubmissionTracker(store);
      await tracker.submit("42", member.publicKey(), true);

      const result = (await submitCouncilVote(
        { memberSecret: member.secret(), councilMembers: [member.publicKey()], tracker, threshold: 4 },
        { marketId: "42", outcome: false, dryRun: true },
      )) as SubmitCliDryRunResult;

      expect(result.simulation.previousOutcome).toBe(true);
      expect(result.simulation.projectedTally).toMatchObject({ yesVotes: 0, noVotes: 1, totalVoters: 1 });
      expect(result.simulation.projectedOutcome).toBeNull();
      expect(store.data.get("42")?.get(member.publicKey())).toBe(true);
    });

    it("still rejects a key that is not a registered council member", async () => {
      const tracker = new SubmissionTracker(inMemoryStore());

      await expect(
        submitCouncilVote(
          { memberSecret: Keypair.random().secret(), councilMembers: [Keypair.random().publicKey()], tracker },
          { marketId: "42", outcome: true, dryRun: true },
        ),
      ).rejects.toThrow("not a registered council member");
    });

    it("formats a report that states nothing was written", async () => {
      const member = Keypair.random();
      const tracker = new SubmissionTracker(inMemoryStore());

      const result = (await submitCouncilVote(
        { memberSecret: member.secret(), councilMembers: [member.publicKey()], tracker, threshold: 4 },
        { marketId: "42", outcome: true, dryRun: true },
      )) as SubmitCliDryRunResult;
      const report = formatDryRun(result, 4);

      expect(report).toContain(`Would record YES for market 42 as ${member.publicKey()}`);
      expect(report).toContain("Tally after vote: 1 YES / 0 NO (1 voters, threshold 4)");
      expect(report).toContain("Council outcome after vote: none");
      expect(report).toContain("No vote was written.");
    });
  });
});
