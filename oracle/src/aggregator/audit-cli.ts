import { Pool } from "pg";
import { loadAggregatorConfig } from "./config.js";
import { exportCouncilAudit, type AuditFormat } from "./council-audit.js";

export interface ParsedAuditArgs {
  format: AuditFormat;
}

/** Parses `--format <csv|json>` from CLI argv, defaulting to JSON. */
export function parseAuditArgs(argv: readonly string[]): ParsedAuditArgs {
  let format: AuditFormat = "json";

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--format") {
      const raw = argv[++i];
      const value = raw?.toLowerCase();
      if (value === "csv" || value === "json") format = value;
      else throw new Error(`--format must be "csv" or "json", got "${raw ?? ""}"`);
    }
  }

  return { format };
}

async function main(): Promise<void> {
  const args = parseAuditArgs(process.argv.slice(2));

  const aggregatorConfig = loadAggregatorConfig(process.env);
  const pool = new Pool({ connectionString: aggregatorConfig.DATABASE_URL });

  try {
    // Write only the serialised audit to stdout so it can be redirected to a
    // file (`> audit.csv`) without capturing log noise.
    process.stdout.write(await exportCouncilAudit(pool, args.format));
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
