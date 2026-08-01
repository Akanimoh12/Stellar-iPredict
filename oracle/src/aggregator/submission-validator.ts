import type { MarketTally } from "./tally.js";

export interface SubmissionValidationResult {
  /** Whether the market has sufficient data to finalize. */
  isValid: boolean;
  /** Human-readable reason for validation failure, if any. */
  reason?: string;
  /** Number of submissions received. */
  submissionCount: number;
  /** Minimum required submissions for finalization. */
  requiredSubmissions: number;
}

export interface SubmissionValidationConfig {
  /**
   * Minimum number of council member submissions required before finalization.
   * Defaults to 1 (at least one member must submit).
   * Set higher for more conservative safety (e.g., COUNCIL_THRESHOLD or COUNCIL_SIZE).
   */
  minRequiredSubmissions: number;

  /**
   * Whether to enforce that the threshold outcome is actually reached.
   * When true, validation fails if no outcome reaches the threshold,
   * even if the minimum submission count is met.
   */
  enforceThreshold: boolean;

  /**
   * The threshold value for determining agreement (e.g., 4 for 4-of-7).
   * Only used when enforceThreshold is true.
   */
  threshold: number;
}

/**
 * Validates that a market has sufficient member submissions before finalization.
 *
 * Safety criteria:
 * 1. At least `minRequiredSubmissions` council members must have submitted
 * 2. If `enforceThreshold` is true, an outcome must reach the threshold
 *
 * This prevents finalization based on incomplete data or accidental/premature
 * submissions from a single member.
 */
export function validateSubmissionData(
  tally: MarketTally,
  config: SubmissionValidationConfig,
): SubmissionValidationResult {
  const submissionCount = tally.totalVoters;
  const requiredSubmissions = config.minRequiredSubmissions;

  // Check 1: Minimum submission count
  if (submissionCount < requiredSubmissions) {
    return {
      isValid: false,
      reason: `Insufficient submissions: ${submissionCount}/${requiredSubmissions} required`,
      submissionCount,
      requiredSubmissions,
    };
  }

  // Check 2: Threshold enforcement (if enabled)
  if (config.enforceThreshold) {
    const yesReached = tally.yesVotes >= config.threshold;
    const noReached = tally.noVotes >= config.threshold;

    if (!yesReached && !noReached) {
      return {
        isValid: false,
        reason: `No outcome reached threshold: ${tally.yesVotes} yes, ${tally.noVotes} no (threshold: ${config.threshold})`,
        submissionCount,
        requiredSubmissions,
      };
    }

    // Ambiguous case: both outcomes reached threshold
    if (yesReached && noReached) {
      return {
        isValid: false,
        reason: `Ambiguous: both outcomes reached threshold (${tally.yesVotes} yes, ${tally.noVotes} no)`,
        submissionCount,
        requiredSubmissions,
      };
    }
  }

  return {
    isValid: true,
    submissionCount,
    requiredSubmissions,
  };
}

/**
 * Checks if a market can be safely finalized.
 * Throws an error with a descriptive message if validation fails.
 */
export function assertCanFinalize(
  marketId: string,
  tally: MarketTally,
  config: SubmissionValidationConfig,
): void {
  const validation = validateSubmissionData(tally, config);
  if (!validation.isValid) {
    throw new Error(
      `Market ${marketId} cannot be finalized: ${validation.reason}`,
    );
  }
}

/**
 * Creates a default validation config that requires at least one submission
 * and enforces threshold consensus.
 */
export function createDefaultValidationConfig(threshold: number): SubmissionValidationConfig {
  return {
    minRequiredSubmissions: 1,
    enforceThreshold: true,
    threshold,
  };
}

/**
 * Creates a strict validation config that requires submissions from all
 * council members before finalization.
 */
export function createStrictValidationConfig(
  councilSize: number,
  threshold: number,
): SubmissionValidationConfig {
  return {
    minRequiredSubmissions: councilSize,
    enforceThreshold: true,
    threshold,
  };
}

/**
 * Creates a balanced validation config that requires at least threshold
 * submissions (enough to reach consensus) before finalization.
 */
export function createBalancedValidationConfig(threshold: number): SubmissionValidationConfig {
  return {
    minRequiredSubmissions: threshold,
    enforceThreshold: true,
    threshold,
  };
}
