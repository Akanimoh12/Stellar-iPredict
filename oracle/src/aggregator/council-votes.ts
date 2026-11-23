import { selectThresholdOutcome, type CouncilVote } from "./threshold.js";
import { computeTally, type MarketTally, type SubmissionStore } from "./tally.js";

export class CouncilVoteManager {
  /**
   * Legacy local fallback used only by synchronous/unit-test callers. The
   * authoritative production path is the SubmissionStore methods below.
   */
  private readonly votes = new Map<string, boolean>();

  constructor(private readonly store?: SubmissionStore) {}

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

  /** Persist the latest vote for a market in `council_votes`. */
  async submitVoteToStore(marketId: string, member: string, outcome: boolean): Promise<void> {
    const normalizedMarket = marketId.trim();
    const normalizedMember = member.trim();
    if (!normalizedMarket) throw new Error("marketId is required");
    if (!normalizedMember) throw new Error("Council member is required");
    if (!this.store) throw new Error("A SubmissionStore is required for durable votes");
    await this.store.recordSubmission(normalizedMarket, normalizedMember, outcome);
  }

  /** Read the authoritative market votes and compute its current tally. */
  async getTallyFromStore(marketId: string): Promise<MarketTally> {
    const normalizedMarket = marketId.trim();
    if (!normalizedMarket) throw new Error("marketId is required");
    if (!this.store) throw new Error("A SubmissionStore is required for durable votes");
    return computeTally(normalizedMarket, await this.store.getSubmissions(normalizedMarket));
  }

  /** Select an outcome from the database-backed tally, not local process state. */
  async getAgreedOutcomeFromStore(marketId: string, threshold: number): Promise<boolean | null> {
    const tally = await this.getTallyFromStore(marketId);
    return selectThresholdOutcome(tally.votes, threshold);
  }
}
