import type { CouncilVote } from "./threshold.js";

export interface ConflictReport {
  marketId: string;
  yesVotes: number;
  noVotes: number;
  totalVoters: number;
  conflicting: boolean;
  /** Fraction of the minority side (0–0.5). 0 = unanimous, 0.5 = even split. */
  disagreementRatio: number;
}

/**
 * Detects when council members disagree past a configurable threshold.
 *
 * `disagreementThreshold` is the minimum fraction of dissenting votes
 * (relative to unique voters) that triggers a conflict flag.
 * For example, 0.3 means ≥30 % of voters disagree with the majority.
 *
 * Deduplicates by member address (latest vote wins), consistent with
 * `selectThresholdOutcome`.
 */
export function detectConflict(
  marketId: string,
  votes: readonly CouncilVote[],
  disagreementThreshold: number,
): ConflictReport {
  if (disagreementThreshold < 0 || disagreementThreshold > 1) {
    throw new RangeError("disagreementThreshold must be between 0 and 1");
  }

  const votesByMember = new Map<string, boolean>();
  for (const vote of votes) {
    const member = vote.member.trim();
    if (member) votesByMember.set(member, vote.outcome);
  }

  let yes = 0;
  let no = 0;
  for (const outcome of votesByMember.values()) {
    if (outcome) yes += 1;
    else no += 1;
  }

  const totalVoters = yes + no;
  const minority = Math.min(yes, no);
  const disagreementRatio = totalVoters > 0 ? minority / totalVoters : 0;
  const conflicting = disagreementRatio >= disagreementThreshold;

  return { marketId, yesVotes: yes, noVotes: no, totalVoters, conflicting, disagreementRatio };
}
