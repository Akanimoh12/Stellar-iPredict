export interface CouncilVote {
  member: string;
  outcome: boolean;
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

  const yesReached = yes >= threshold;
  const noReached = no >= threshold;
  if (yesReached === noReached) return null;
  return yesReached;
}
