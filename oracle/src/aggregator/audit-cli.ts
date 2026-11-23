import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { loadAggregatorConfig } from "./config.js";
import {
  streamCouncilAudit,
  type AuditExportProgress,
  type AuditFormat,
  type CouncilAuditRecord,
} from "./council-audit.js";

export interface ReplayArgs {
  input: string;
  marketId: string;
}

export interface ReplayResult {
  marketId: string;
  yesVotes: number;
  noVotes: number;
  totalVoters: number;
  threshold: number;
  replayedDecision: boolean | null;
  recordedDecision: boolean | null;
  evidenceDecision: boolean | null;
  evidenceOutcomes: readonly boolean[];
  evidenceComplete: boolean;
}

export interface ParsedAuditArgs {
  format: AuditFormat;
}

/** Parses `--format <csv|json|raw-csv>` from CLI argv, defaulting to JSON. */
export function parseAuditArgs(argv: readonly string[]): ParsedAuditArgs {
  let format: AuditFormat = "json";

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--format") {
      const raw = argv[++i];
      const value = raw?.toLowerCase();
      if (value === "csv" || value === "json" || value === "raw-csv") format = value;
      else throw new Error(`--format must be "csv", "json" or "raw-csv", got "${raw ?? ""}"`);
    }
  }

  return { format };
}

/**
 * Whether the CLI should report export progress on stderr.
 *
 * On by default: a full audit export can run for minutes, and a silent process
 * is indistinguishable from a hung one. `--no-progress` is the escape hatch for
 * scripts that require an empty stderr. Progress never goes to stdout, so it
 * cannot contaminate `audit-export > audit.csv`.
 */
export function parseProgressArgs(argv: readonly string[]): boolean {
  let enabled = true;
  for (const flag of argv) {
    if (flag === "--progress") enabled = true;
    else if (flag === "--no-progress") enabled = false;
  }
  return enabled;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatDuration(ms: number): string {
  return ms < 1_000 ? `${Math.round(ms)}ms` : `${(ms / 1_000).toFixed(1)}s`;
}

export interface AuditProgressReporterOptions {
  format: AuditFormat;
  /** Destination for progress lines; stderr by default, never stdout. */
  stream?: Pick<NodeJS.WriteStream, "write">;
  /** Minimum time between in-flight progress lines. Defaults to one second. */
  intervalMs?: number;
}

/**
 * Builds a progress callback for {@link streamCouncilAudit}.
 *
 * In-flight updates are throttled by time so a fast export does not flood the
 * log; the final line is always written so the operator sees the record and
 * byte totals even when the export finished within one interval.
 */
export function createAuditProgressReporter(
  options: AuditProgressReporterOptions,
): (progress: AuditExportProgress) => void {
  const stream = options.stream ?? process.stderr;
  const intervalMs = options.intervalMs ?? 1_000;
  let lastReportedAt = Number.NEGATIVE_INFINITY;

  return (progress) => {
    if (!progress.done && progress.elapsedMs - lastReportedAt < intervalMs) return;
    lastReportedAt = progress.elapsedMs;

    const plural = progress.records === 1 ? "" : "s";
    const line = progress.done
      ? `[audit-export] complete: ${progress.records} record${plural}, ` +
        `${formatBytes(progress.bytes)} in ${formatDuration(progress.elapsedMs)}\n`
      : `[audit-export] ${options.format}: ${progress.records} record${plural}, ` +
        `${formatBytes(progress.bytes)} written\n`;
    stream.write(line);
  };
}

/** Parses `--replay <audit.json> --market <id>` for an offline audit replay. */
export function parseReplayArgs(argv: readonly string[]): ReplayArgs | null {
  const replayIndex = argv.indexOf("--replay");
  if (replayIndex < 0) return null;
  const input = argv[replayIndex + 1];
  const marketIndex = argv.indexOf("--market");
  const marketId = argv[marketIndex + 1];
  if (!input) throw new Error("--replay <audit.json> is required");
  if (!marketId) throw new Error("--market <id> is required with --replay");
  return { input, marketId };
}

function parseRecordedDecision(decision: string | null): boolean | null {
  if (decision === "yes" || decision === "true" || decision === "YES") return true;
  if (decision === "no" || decision === "false" || decision === "NO") return false;
  return null;
}

/** Recomputes a finalized decision from the votes and stored provider evidence. */
export function replayAuditRecord(
  record: CouncilAuditRecord,
  threshold: number,
): ReplayResult {
  const replayedDecision = record.yesVotes >= threshold && record.yesVotes > record.noVotes
    ? true
    : record.noVotes >= threshold && record.noVotes > record.yesVotes
      ? false
      : null;
  const evidenceOutcomes = record.rawPayloads
    .map((payload) => payload.outcome)
    .filter((outcome): outcome is boolean => outcome !== null);
  const distinctEvidence = [...new Set(evidenceOutcomes)];
  return {
    marketId: record.marketId,
    yesVotes: record.yesVotes,
    noVotes: record.noVotes,
    totalVoters: record.totalVoters,
    threshold,
    replayedDecision,
    recordedDecision: parseRecordedDecision(record.decision),
    evidenceDecision: distinctEvidence.length === 1 ? distinctEvidence[0] : null,
    evidenceOutcomes,
    evidenceComplete: record.rawPayloads.length > 0 &&
      record.rawPayloads.every((payload) => !payload.truncated && payload.outcome !== null),
  };
}

async function replayFromFile(args: ReplayArgs, threshold: number): Promise<ReplayResult> {
  const parsed: unknown = JSON.parse(await readFile(args.input, "utf8"));
  if (!Array.isArray(parsed)) throw new Error("replay input must be a JSON audit export array");
  const record = parsed.find((candidate): candidate is CouncilAuditRecord =>
    typeof candidate === "object" && candidate !== null &&
    (candidate as { marketId?: unknown }).marketId === args.marketId,
  );
  if (!record) throw new Error(`market ${args.marketId} was not found in ${args.input}`);
  return replayAuditRecord(record, threshold);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const replayArgs = parseReplayArgs(argv);

  if (replayArgs) {
    const threshold = Number(process.env.COUNCIL_THRESHOLD ?? 4);
    if (!Number.isInteger(threshold) || threshold <= 0) {
      throw new Error("COUNCIL_THRESHOLD must be a positive integer for replay");
    }
    process.stdout.write(JSON.stringify(
      await replayFromFile(replayArgs, threshold),
      null,
      2,
    ) + "\n");
    return;
  }

  const aggregatorConfig = loadAggregatorConfig(process.env);
  const args = parseAuditArgs(argv);
  const onProgress = parseProgressArgs(argv)
    ? createAuditProgressReporter({ format: args.format })
    : undefined;
  const pool = new Pool({ connectionString: aggregatorConfig.DATABASE_URL });

  try {
    // Write only the serialised audit to stdout so it can be redirected to a
    // file (`> audit.csv`) without capturing log noise. Chunks are written as
    // they are produced, waiting on `drain` when stdout is backed up, so a large
    // export is never held in memory whole. Progress goes to stderr for the
    // same reason: stdout must stay exactly the requested format.
    for await (const chunk of streamCouncilAudit(pool, args.format, { onProgress })) {
      if (!process.stdout.write(chunk)) await once(process.stdout, "drain");
    }
  } finally {
    await pool.end();
  }
}

const isDirectRun = process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], "file:").href;
if (isDirectRun) {
  main().catch((error: unknown) => {
    console.error("[ipredict-oracle] audit export failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
