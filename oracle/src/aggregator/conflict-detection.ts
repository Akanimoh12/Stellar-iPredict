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

export interface AdapterConflictSourceInfo {
  adapterId: string;
  outcome: boolean;
  confidence: number;
  provider?: string;
  error?: string;
}

export interface AdapterConflictReport {
  marketId: string;
  conflicting: boolean;
  yesCount: number;
  noCount: number;
  totalSuccessful: number;
  disagreementRatio: number;
  sources: AdapterConflictSourceInfo[];
}

/**
 * Detects when data adapters for the same market return conflicting outcomes.
 *
 * `conflictThreshold` is the fraction of dissenting weighted votes that triggers a conflict.
 * If two or more adapters disagree on the outcome, automatic resolution is refused.
 */
export function detectAdapterConflict(
  marketId: string,
  sources: readonly { adapterId: string; outcome: boolean; confidence: number; provider?: string; error?: string }[],
  conflictThreshold = 0.3,
): AdapterConflictReport {
  const successful = sources.filter((s) => s.error === undefined);
  const yesCount = successful.filter((s) => s.outcome).length;
  const noCount = successful.length - yesCount;
  const totalSuccessful = successful.length;

  const weightOf = (s: { confidence: number }) => Math.max(0, Math.min(1, s.confidence));
  const rawYesWeight = successful.filter((s) => s.outcome).reduce((sum, s) => sum + weightOf(s), 0);
  const rawNoWeight = successful.filter((s) => !s.outcome).reduce((sum, s) => sum + weightOf(s), 0);
  const totalWeight = rawYesWeight + rawNoWeight;

  const disagreementRatio = totalWeight > 0 ? Math.min(rawYesWeight, rawNoWeight) / totalWeight : 0;
  const conflicting = totalSuccessful >= 2 && yesCount > 0 && noCount > 0 && (disagreementRatio >= conflictThreshold || yesCount === noCount);

  return {
    marketId,
    conflicting,
    yesCount,
    noCount,
    totalSuccessful,
    disagreementRatio,
    sources: sources.map((s) => ({
      adapterId: s.adapterId,
      outcome: s.outcome,
      confidence: s.confidence,
      provider: s.provider,
      error: s.error,
    })),
  };
}
