import { Keypair } from "@stellar/stellar-sdk";
import { Pool } from "pg";
import { loadCouncilConfig } from "../config/council.js";
import { loadAggregatorConfig } from "./config.js";
import { computeTally, createPostgresSubmissionStore, SubmissionTracker, type MarketTally } from "./tally.js";
import { selectThresholdOutcome } from "./threshold.js";

export interface ParsedSubmitArgs {
  marketId: string;
  outcome: boolean;
  /** Simulate the submission and report its effect without writing the vote. */
  dryRun?: boolean;
}

/** Parses `--market <id> --outcome <yes|no> [--dry-run]` from CLI argv. */
export function parseSubmitArgs(argv: readonly string[]): ParsedSubmitArgs {
  let marketId: string | undefined;
  let outcome: boolean | undefined;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--dry-run") {
      dryRun = true;
    } else if (flag === "--market") {
      marketId = argv[++i];
    } else if (flag === "--outcome") {
      const raw = argv[++i];
      const value = raw?.toLowerCase();
      if (value === "yes" || value === "true") outcome = true;
      else if (value === "no" || value === "false") outcome = false;
      else throw new Error(`--outcome must be "yes" or "no", got "${raw ?? ""}"`);
    }
  }

  if (!marketId?.trim()) throw new Error("--market <id> is required");
  if (outcome === undefined) throw new Error("--outcome <yes|no> is required");
  const parsed: ParsedSubmitArgs = { marketId: marketId.trim(), outcome };
  if (dryRun) parsed.dryRun = true;
  return parsed;
}

export interface SubmitCliDependencies {
  /** The submitting member's own Stellar secret key — never transmitted, only used locally to derive their public key. */
  memberSecret: string;
  councilMembers: readonly string[];
  tracker: SubmissionTracker;
  /** Votes needed to decide a market; used to report the projected outcome of a dry run. */
  threshold?: number;
}

export interface SubmitCliResult {
  member: string;
  marketId: string;
  outcome: boolean;
}

export interface DryRunSimulation {
  /** The member's currently recorded outcome, which this vote would replace. */
  previousOutcome: boolean | null;
  /** The market's tally as it would be after this vote. */
  projectedTally: MarketTally;
  /** The outcome the council would reach after this vote, or null if undecided. */
  projectedOutcome: boolean | null;
}

export interface SubmitCliDryRunResult extends SubmitCliResult {
  dryRun: true;
  simulation: DryRunSimulation;
}

/**
 * Records one council member's outcome for a market.
 *
 * The member's public key is derived locally from their own secret key and
 * checked against the registered council before the vote is recorded, so
 * only registered members can submit, and always as themselves — nobody can
 * submit on another member's behalf.
 *
 * This only ever records a vote; it has no path to finalize a market, so it
 * cannot itself cause a double finalization. Finalization (and its
 * once-only guarantee) is handled separately by `FinalizationGuard` /
 * `CancellationAwareFinalizer`.
 *
 * With `dryRun` the same checks run and the market's current tally is read,
 * but nothing is written: the result reports what the vote would change.
 */
export async function submitCouncilVote(
  deps: SubmitCliDependencies,
  args: ParsedSubmitArgs,
): Promise<SubmitCliResult | SubmitCliDryRunResult> {
  const keypair = Keypair.fromSecret(deps.memberSecret);
  const member = keypair.publicKey();

  if (!deps.councilMembers.includes(member)) {
    throw new Error("This key is not a registered council member");
  }

  if (args.dryRun) {
    const simulation = await simulateCouncilVote(deps, args.marketId, member, args.outcome);
    return { member, marketId: args.marketId, outcome: args.outcome, dryRun: true, simulation };
  }

  await deps.tracker.submit(args.marketId, member, args.outcome);
  return { member, marketId: args.marketId, outcome: args.outcome };
}

async function simulateCouncilVote(
  deps: SubmitCliDependencies,
  marketId: string,
  member: string,
  outcome: boolean,
): Promise<DryRunSimulation> {
  const current = await deps.tracker.getTally(marketId);
  const previousOutcome = current.votes.find((vote) => vote.member === member)?.outcome ?? null;
  const projectedTally = computeTally(marketId, [...current.votes, { member, outcome }]);
  const projectedOutcome =
    deps.threshold === undefined ? null : selectThresholdOutcome(projectedTally.votes, deps.threshold);
  return { previousOutcome, projectedTally, projectedOutcome };
}

function formatOutcome(outcome: boolean | null): string {
  if (outcome === null) return "none";
  return outcome ? "YES" : "NO";
}

/** Human-readable report of a dry run, printed by the CLI. */
export function formatDryRun(result: SubmitCliDryRunResult, threshold: number): string {
  const { simulation } = result;
  const { projectedTally } = simulation;
  return [
    `[dry-run] Would record ${formatOutcome(result.outcome)} for market ${result.marketId} as ${result.member}`,
    `[dry-run] Current vote from this member: ${formatOutcome(simulation.previousOutcome)}`,
    `[dry-run] Tally after vote: ${projectedTally.yesVotes} YES / ${projectedTally.noVotes} NO ` +
      `(${projectedTally.totalVoters} voters, threshold ${threshold})`,
    `[dry-run] Council outcome after vote: ${formatOutcome(simulation.projectedOutcome)}`,
    "[dry-run] No vote was written.",
  ].join("\n");
}

async function main(): Promise<void> {
  const args = parseSubmitArgs(process.argv.slice(2));

  const memberSecret = process.env.COUNCIL_MEMBER_SECRET;
  if (!memberSecret) throw new Error("COUNCIL_MEMBER_SECRET env var is required");

  const councilConfig = loadCouncilConfig(process.env);
  const aggregatorConfig = loadAggregatorConfig(process.env);
  const pool = new Pool({ connectionString: aggregatorConfig.DATABASE_URL });

  try {
    const tracker = new SubmissionTracker(createPostgresSubmissionStore(pool));
    const result = await submitCouncilVote(
      { memberSecret, councilMembers: councilConfig.members, tracker, threshold: councilConfig.threshold },
      args,
    );
    if ("dryRun" in result) {
      console.log(formatDryRun(result, councilConfig.threshold));
    } else {
      console.log(`Recorded ${result.outcome ? "YES" : "NO"} for market ${result.marketId} as ${result.member}`);
    }
  } finally {
    await pool.end();
  }
}

const isDirectRun = process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], "file:").href;
if (isDirectRun) {
  main().catch((error: unknown) => {
    console.error("[ipredict-oracle] submit failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
