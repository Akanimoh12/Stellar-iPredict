import type { Logger } from "../log.js";

export interface CouncilVote {
  member: string;
  outcome: boolean;
}

export interface VoteTally {
  yes: number;
  no: number;
  threshold: number;
  totalMembers: number;
}

/**
 * Returns the outcome supported by at least `threshold` unique council
 * members. Duplicate submissions from one member count only once (latest
 * submission wins). An ambiguous input where both outcomes reach threshold is
 * rejected rather than selecting an arbitrary winner.
 */
export function selectThresholdOutcome(
  votes: readonly CouncilVote[],
  threshold: number,
  logger?: Logger,
  marketId?: string,
): boolean | null {
  if (!Number.isInteger(threshold) || threshold <= 0) {
    throw new RangeError("threshold must be a positive integer");
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

  const tally: VoteTally = { yes, no, threshold, totalMembers: votesByMember.size };
  const yesReached = yes >= threshold;
  const noReached = no >= threshold;
  const ambiguous = yesReached === noReached;
  const result = ambiguous ? null : yesReached;

  logger?.info("vote tally", {
    marketId: marketId ?? null,
    ...tally,
    ambiguous,
    outcome: result,
  });

  return result;
}
