import { Keypair } from "@stellar/stellar-sdk";
import { Pool } from "pg";
import { loadCouncilConfig } from "../config/council.js";
import { loadAggregatorConfig } from "./config.js";
import { createPostgresSubmissionStore, SubmissionTracker } from "./tally.js";

export interface ParsedSubmitArgs {
  marketId: string;
  outcome: boolean;
}

/** Parses `--market <id> --outcome <yes|no>` from CLI argv. */
export function parseSubmitArgs(argv: readonly string[]): ParsedSubmitArgs {
  let marketId: string | undefined;
  let outcome: boolean | undefined;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--market") {
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
  return { marketId: marketId.trim(), outcome };
}

export interface SubmitCliDependencies {
  /** The submitting member's own Stellar secret key — never transmitted, only used locally to derive their public key. */
  memberSecret: string;
  councilMembers: readonly string[];
  tracker: SubmissionTracker;
}

export interface SubmitCliResult {
  member: string;
  marketId: string;
  outcome: boolean;
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
 */
export async function submitCouncilVote(
  deps: SubmitCliDependencies,
  args: ParsedSubmitArgs,
): Promise<SubmitCliResult> {
  const keypair = Keypair.fromSecret(deps.memberSecret);
  const member = keypair.publicKey();

  if (!deps.councilMembers.includes(member)) {
    throw new Error("This key is not a registered council member");
  }

  await deps.tracker.submit(args.marketId, member, args.outcome);
  return { member, marketId: args.marketId, outcome: args.outcome };
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
      { memberSecret, councilMembers: councilConfig.members, tracker },
      args,
    );
    console.log(`Recorded ${result.outcome ? "YES" : "NO"} for market ${result.marketId} as ${result.member}`);
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
