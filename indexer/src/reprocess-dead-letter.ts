/**
 * Dead-letter reprocess job — entry point for `npm run reprocess:dead-letter`
 *
 * Replays unresolved dead-letter events through the normal handler path
 * (writeEventToDb), marks successfully replayed events as resolved, and
 * tracks attempt counts and last errors for triage.  Idempotency is
 * guaranteed by the ON CONFLICT (tx_hash, event_index) DO NOTHING constraint
 * added in migration 0007 — replaying an event whose effects already landed
 * is a safe no-op.
 *
 * Usage:
 *   npm run reprocess:dead-letter [--batch-size N] [--dry-run]
 *
 * Options:
 *   --batch-size N   Max rows to process in this run (default: 500).
 *   --dry-run        List unresolved events without replaying them.
 *
 * Environment:
 *   DATABASE_URL — PostgreSQL connection string (required)
 *   REDIS_URL    — Redis connection string (optional; cache invalidation only)
 *   LOG_LEVEL    — debug|info|warn|error (optional, default: info)
 */

import { Pool } from "pg";
import { Redis } from "ioredis";
import {
  reprocessDeadLetterBatch,
  listUnresolvedDeadLetterEvents,
  countUnresolvedDeadLetterEvents,
  DEAD_LETTER_ALERT_THRESHOLD,
} from "./deadLetter.js";
import { refreshDeadLetterQueueDepth } from "./metrics.js";
import { createLogger, parseLogLevel } from "./log.js";
import type { DbClient, RedisClient } from "./types.js";

// ── CLI argument helpers ──────────────────────────────────────────────────

function parseBatchSize(argv: string[]): number {
  const exact = argv.find((a) => a.startsWith("--batch-size="));
  if (exact) {
    const n = Number(exact.split("=", 2)[1]);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 500;
  }
  const idx = argv.indexOf("--batch-size");
  if (idx >= 0 && argv[idx + 1]) {
    const n = Number(argv[idx + 1]);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 500;
  }
  return 500;
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required to reprocess dead-letter events");
  }

  const dryRun = process.argv.includes("--dry-run");
  const batchSize = parseBatchSize(process.argv);

  const logger = createLogger({
    level: parseLogLevel(process.env.LOG_LEVEL),
    bindings: { component: "indexer", job: "dead-letter-reprocess" },
  });

  const pool = new Pool({ connectionString });

  // Minimal DbClient wrapper around the pool — each query gets a fresh
  // connection so individual event replay failures don't poison the session.
  const db: DbClient = {
    query: <T = unknown>(text: string, params?: readonly unknown[]) =>
      pool.query<T>(text, params as unknown[]) as ReturnType<DbClient["query"]>,
  };

  // Redis is optional: cache invalidation degrades gracefully without it.
  // A no-op stub avoids ifdefing every redis.del call in the handlers.
  let redis: RedisClient = { del: () => Promise.resolve(0) };
  let ioredisClient: Redis | undefined;

  if (process.env.REDIS_URL) {
    try {
      ioredisClient = new Redis(process.env.REDIS_URL, {
        lazyConnect: true,
        connectTimeout: 3000,
      });
      await ioredisClient.connect();
      // ioredis.del accepts variadic string keys — satisfies RedisClient.
      redis = { del: (...keys: string[]) => ioredisClient!.del(...keys) };
      logger.info?.("Redis connected for cache invalidation", {
        url: process.env.REDIS_URL.replace(/:[^@]*@/, ":***@"),
      });
    } catch (err) {
      logger.warn("Redis unavailable; cache will not be invalidated during reprocess", {
        error: err instanceof Error ? err.message : String(err),
      });
      ioredisClient = undefined;
    }
  }

  const startedAt = Date.now();

  try {
    // ── Dry-run: list without replaying ─────────────────────────────────
    if (dryRun) {
      const rows = await listUnresolvedDeadLetterEvents(db as unknown as Parameters<typeof listUnresolvedDeadLetterEvents>[0], batchSize);
      const total = await countUnresolvedDeadLetterEvents(db as unknown as Parameters<typeof countUnresolvedDeadLetterEvents>[0]);
      logger.info("dead-letter reprocess dry-run", {
        dryRun: true,
        total,
        showing: rows.length,
        events: rows.map((r) => ({
          id: r.id,
          ledger_seq: r.ledger_seq,
          tx_hash: r.tx_hash,
          attempt_count: r.attempt_count,
          last_error: r.last_error,
          created_at: r.created_at,
        })),
      });
      return;
    }

    // ── Refresh queue-depth gauge before processing ──────────────────────
    const depthBefore = await refreshDeadLetterQueueDepth(
      () => countUnresolvedDeadLetterEvents(db as unknown as Parameters<typeof countUnresolvedDeadLetterEvents>[0]),
      DEAD_LETTER_ALERT_THRESHOLD,
      logger,
    );

    logger.info("dead-letter reprocess started", { batchSize, depthBefore });

    const summary = await reprocessDeadLetterBatch(db, redis, { batchSize });

    const depthAfter = await refreshDeadLetterQueueDepth(
      () => countUnresolvedDeadLetterEvents(db as unknown as Parameters<typeof countUnresolvedDeadLetterEvents>[0]),
      DEAD_LETTER_ALERT_THRESHOLD,
      logger,
    );

    logger.info("dead-letter reprocess finished", {
      ...summary,
      depthBefore,
      depthAfter,
      durationMs: Date.now() - startedAt,
    });

    if (summary.failed > 0) {
      logger.warn("some dead-letter events could not be replayed", {
        failed: summary.failed,
        hint: "Inspect last_error in dead_letter_events for per-row details.",
      });
      // Exit with a non-zero code so CI/alerting surfaces persistent failures.
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
    if (ioredisClient) {
      ioredisClient.disconnect();
    }
  }
}

main().catch((error: unknown) => {
  const logger = createLogger({
    level: parseLogLevel(process.env.LOG_LEVEL),
    bindings: { component: "indexer", job: "dead-letter-reprocess" },
  });
  logger.error("dead-letter reprocess fatal", { error });
  process.exitCode = 1;
});
