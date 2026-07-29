import { selectThresholdOutcome, type CouncilVote } from "./threshold.js";

export class CouncilVoteManager {
  private readonly votes = new Map<string, boolean>();

  submitVote(member: string, outcome: boolean): CouncilVote {
    const normalized = member.trim();
    if (!normalized) throw new Error("Council member is required");
    this.votes.set(normalized, outcome);
    return { member: normalized, outcome };
  }

  getVotes(): CouncilVote[] {
    return [...this.votes.entries()].map(([member, outcome]) => ({ member, outcome }));
  }

  getAgreedOutcome(threshold: number): boolean | null {
    return selectThresholdOutcome(this.getVotes(), threshold);
  }
}
