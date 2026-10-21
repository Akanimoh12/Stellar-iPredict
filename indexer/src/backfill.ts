import { rpc, scValToNative } from "@stellar/stellar-sdk";
import { config } from "./config/index.js";
import { pool, ensureCheckpointTable, getCheckpointLedger, saveCheckpointLedger } from "./db.js";
import { insertProcessedEvent } from "./handlers/idempotency.js";
import {
  isRetentionExceededError,
  extractOldestLedger,
  formatRetentionExceededMessage,
  RetentionExceededError,
  checkRetentionBoundary,
  DEFAULT_RETENTION_ALERT_THRESHOLD,
} from "./rpc/getEvents.js";
import { PermanentError } from "@ipredict/shared";
import { jitteredDelayMs, withRetry } from "./rpc/retry.js";
import { refreshDeadLetterQueueDepthFromDb } from "./metrics.js";
import type { Logger } from "./log.js";

/**
 * Backfill as a recovery path.
 *
 * Most database state (markets, bets, resolutions) derives from on-chain events
 * and can be rebuilt by replaying them with `runBackfill()`. This is the
 * **secondary** recovery path — the primary one is restoring a database backup
 * (see `docs/DEPLOYMENT-GUIDE.md` § "Backup verification" and § "Disaster
 * recovery").
 *
 * The hard limit is RPC event retention: `getEvents` only serves events for a
 * bounded window (see `START_LEDGER` / the provider's retention). State older
 * than that window is **not** reconstructible from chain — for that data the
 * backup is load-bearing. `getBackfillCoverage()` reports where that boundary
 * currently sits for a given database.
 */
export interface BackfillCoverage {
  earliestLedger: number | null;
  latestLedger: number | null;
  eventCount: number;
  /** Distinct markets seen in the events table. */
  marketCount: number;
}

export async function getBackfillCoverage(
  db: { query: (sql: string, params?: readonly unknown[]) => Promise<{ rows: any[] }> } = pool,
): Promise<BackfillCoverage> {
  const { rows } = await db.query(
    `SELECT
       MIN(ledger_seq)::bigint          AS earliest,
       MAX(ledger_seq)::bigint          AS latest,
       COUNT(*)::bigint                 AS events,
       COUNT(DISTINCT market_id)::bigint AS markets
     FROM events`,
  );
  const r = rows[0] ?? {};
  return {
    earliestLedger: r.earliest === null || r.earliest === undefined ? null : Number(r.earliest),
    latestLedger: r.latest === null || r.latest === undefined ? null : Number(r.latest),
    eventCount: Number(r.events ?? 0),
    marketCount: Number(r.markets ?? 0),
  };
}

// Helper to detect 429 Rate Limit error
export { isRateLimitError } from "./rpc/retry.js";

/**
 * Injected randomness for retry jitter (issue #503). Defaults to
 * `Math.random`; tests override it with a seeded source for deterministic
 * assertions. Exposed on the options object of {@link fetchWithRetry}.
 */
export type RandomSource = () => number;

const defaultRandom: RandomSource = () => Math.random();

/**
 * Sample the jittered delay for one retry attempt, using full jitter
 * (a uniform draw in `[0, ceiling)`).
 *
 * Re-exported from the shared RPC retry helper so the backfill fetcher and the
 * poll loop apply identical jitter semantics; kept exported (and pure) so tests
 * can assert the distribution without driving whole retries (issue #503).
 */
export const jitteredBackoffDelay = (ceilingMs: number, random: RandomSource): number =>
  jitteredDelayMs(ceilingMs, random);

/**
 * Retry wrapper for backfill fetches.
 *
 * The retry *mechanism* is the shared utility (issue #641): one backoff curve
 * (exponential with full jitter) and one type-based retryability rule for
 * every service. What the backfill states is its budget — five retries, a
 * one-second base and a 30 s ceiling.
 *
 * Full jitter means the delay before attempt `n` is drawn uniformly from
 * `[0, min(delay * 2^n, MAX_RETRY_DELAY_MS))` — computed fresh for every
 * attempt, never once per retry sequence. Deterministic doubling alone made
 * every client that hit a 429 retry in lockstep (a synchronised burst exactly
 * when the endpoint was least able to serve it); the random draw de-synchronises
 * concurrent indexers and the oracle aggregator sharing an RPC endpoint while
 * keeping the exponential growth and the hard ceiling intact (issue #503).
 *
 * The RNG is injectable so tests can seed it and assert exact delays.
 */
const MAX_RETRY_DELAY_MS = 30_000;

export async function fetchWithRetry<T>(
  fn: () => Promise<T>,
  retries = 5,
  delay = 1000,
  random: RandomSource = defaultRandom,
): Promise<T> {
  return withRetry<T>(
    async () => {
      try {
        return await fn();
      } catch (error) {
        // A retention boundary is permanent: the data simply is not available
        // any more. The RPC SDK reports it as an untyped error, so it is turned
        // into a typed one here — the shared classifier decides by type, not by
        // grepping the message.
        if (isRetentionExceededError(error)) {
          throw new PermanentError(error instanceof Error ? error.message : String(error), {
            cause: error,
          });
        }
        throw error;
      }
    },
    {
      maxRetries: retries,
      baseDelayMs: delay,
      maxDelayMs: MAX_RETRY_DELAY_MS,
      random,
      onRetry: ({ attempt, delayMs }) => {
        console.warn(
          `[backfill] Transient RPC failure. Retrying in ${delayMs}ms ` +
          `(attempt ${attempt})...`,
        );
      },
    },
  );
}

// Ensure the dead-letter table exists
async function ensureDeadLetterTable(): Promise<void> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS dead_letter_events (\n      id BIGSERIAL PRIMARY KEY,\n      ledger_seq BIGINT NOT NULL,\n      tx_hash TEXT NOT NULL,\n      event_index INTEGER,\n      topic_b64 JSONB,\n      value_b64 TEXT,\n      error TEXT,\n      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()\n    )`
  );
}

// Insert a decoding failure into the dead-letter table
async function insertDeadLetterEvent(
  event: rpc.Api.EventResponse,
  eventIndex: number,
  err: any
): Promise<void> {
  try {
    const topic_b64 = event.topic.map((t: any) => t.toXDR("base64"));
    const value_b64 = event.value.toXDR("base64");
    await pool.query(
      `INSERT INTO dead_letter_events (ledger_seq, tx_hash, event_index, topic_b64, value_b64, error)\n       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        event.ledger,
        event.txHash,
        eventIndex,
        JSON.stringify(topic_b64),
        value_b64,
        (err as Error).message,
      ]
    );
    await refreshDeadLetterQueueDepthFromDb(pool, {
      warn: (message, meta) => console.warn(`[backfill] ${message}`, meta),
    });
  } catch (error) {
    console.error(`[backfill] Failed to insert dead-letter event: ${(error as Error).message}`);
  }
}

/**
 * Number of events processed per chunk within a single RPC page.
 *
 * Events are decoded and written one at a time, but processing them in
 * chunks lets us yield to the event loop between chunks so the GC can
 * reclaim already-processed events and the process stays responsive
 * (metrics, health checks, shutdown) even when a page is large.
 */
export const EVENTS_PROCESSING_CHUNK_SIZE = 50;

/**
 * Process a page of events in bounded chunks rather than materialising the
 * whole page's decoded representation at once.
 *
 * The raw RPC page is already in memory (the SDK parses the full JSON
 * response), so peak memory is primarily bounded by `EVENTS_PER_PAGE` (see
 * `MAX_EVENTS_PER_PAGE` in `config/index.ts`). This chunked loop ensures we
 * never hold more than `chunkSize` decoded events at a time and yields to
 * the event loop between chunks.
 */
export async function processEventsInChunks(
  events: rpc.Api.EventResponse[],
  chunkSize: number = EVENTS_PROCESSING_CHUNK_SIZE,
  processor: (event: rpc.Api.EventResponse, eventIndex: number) => Promise<void>,
): Promise<void> {
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new Error("chunkSize must be a positive integer");
  }
  for (let i = 0; i < events.length; i += chunkSize) {
    const chunk = events.slice(i, i + chunkSize);
    for (const [chunkIndex, event] of chunk.entries()) {
      await processor(event, i + chunkIndex);
    }
    // Yield to the event loop between chunks so processed events can be
    // GC'd and the process can service other work (metrics, shutdown).
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * Sample current process memory usage for logging/observability.
 */
export function sampleMemoryUsage(): { rss: number; heapUsed: number; heapTotal: number; external: number } {
  const m = process.memoryUsage();
  return {
    rss: m.rss,
    heapUsed: m.heapUsed,
    heapTotal: m.heapTotal,
    external: m.external,
  };
}

// Parse and write a single event to the database
export async function writeEventToDb(
  ledgerSeq: number,
  txHash: string,
  topics: any[],
  data: any,
  eventIndex = 0,
): Promise<void> {
  const eventName = String(topics[0]);

  // Write to audit events table first (if possible)
  try {
    const marketId = topics[1] ? Number(topics[1]) : (data?.market_id ? Number(data.market_id) : null);
    const actor = topics[2] ? String(topics[2]) : (data?.user ? String(data.user) : null);
    const inserted = await insertProcessedEvent(pool, {
      event: { ledger: ledgerSeq, txHash, eventIndex },
      eventType: eventName,
      marketId,
      actor,
      payload: JSON.stringify(data),
    });
    if (!inserted) return;
  } catch (err) {
    // Audit table might not exist in target database, fail silently but log
    console.debug("Optional events audit logging skipped:", (err as Error).message);
  }

  // Handle specific event actions
  if (eventName === "market_created" || (eventName === "mkt" && topics[1] === "created")) {
    const marketId = data.id ?? data[0] ?? (topics[1] ? Number(topics[1]) : 0);
    const question = data.question ?? data[1] ?? "";
    const category = data.category ?? data[2] ?? "Other";
    const endTime = data.end_time ?? data[3] ?? 0;
    const creator = data.creator ?? data[4] ?? "";
    await pool.query(
      `INSERT INTO markets (id, question, category, end_time, creator)\n       VALUES ($1, $2, $3, $4, $5)\n       ON CONFLICT (id) DO NOTHING`,
      [marketId, question, category, endTime, creator]
    );
  } else if (eventName === "market_resolved" || (eventName === "mkt" && topics[1] === "resolved")) {
    const marketId = topics[1] ?? data.market_id ?? data[0];
    const outcome = data.outcome ?? data[1] ?? false;
    await pool.query(
      `UPDATE markets SET resolved=true, outcome=$2, updated_at=NOW()\n       WHERE id=$1`,
      [marketId, outcome]
    );
  } else if (eventName === "market_cancelled") {
    const marketId = topics[1] ?? data.market_id;
    await pool.query(
      `UPDATE markets SET cancelled=true, updated_at=NOW()\n       WHERE id=$1`,
      [marketId]
    );
  } else if (eventName === "bet_placed" || eventName === "bet") {
    const marketId = topics[1] ?? data.market_id ?? data[0];
    const bettor = topics[2] ?? data.bettor ?? data.user ?? data[1];
    const netAmount = data.net_amount ?? data.amount ?? data.net ?? data[2] ?? 0;
    const grossAmount = data.gross_amount ?? data.gross ?? netAmount;
    const isYes = data.is_yes ?? data[3] ?? true;

    await pool.query(
      `INSERT INTO bets (market_id, bettor, net_amount, gross_amount, is_yes)\n       VALUES ($1, $2, $3, $4, $5)\n       ON CONFLICT (market_id, bettor) DO UPDATE\n       SET net_amount = bets.net_amount + EXCLUDED.net_amount,\n           gross_amount = bets.gross_amount + EXCLUDED.gross_amount`,
      [marketId, bettor, netAmount, grossAmount, isYes]
    );
  }
}

// Historical backfill main entry point
export async function runBackfill(signal?: AbortSignal): Promise<number> {
  const server = new rpc.Server(config.SOROBAN_RPC_URL);

  if (signal?.aborted) throw signal.reason ?? new Error("backfill aborted");
  console.log(`[backfill] Fetching current network head ledger...`);
  const latestLedgerResponse = await fetchWithRetry<rpc.Api.GetLatestLedgerResponse>(async () => {
    return await server.getLatestLedger();
  });
  const headLedger = latestLedgerResponse.sequence;

  console.log(`[backfill] Network head ledger is ${headLedger}. Starting backfill from ${config.START_LEDGER}...`);

  // Proactively check retention boundary if getHealth is supported
  if (typeof (server as any).getHealth === "function") {
    try {
      const health = await (server as any).getHealth();
      const oldestLedger = Number(health?.oldestLedger);
      if (!isNaN(oldestLedger)) {
        if (config.START_LEDGER < oldestLedger) {
          const { message, unavailableRange } = formatRetentionExceededMessage(config.START_LEDGER, oldestLedger);
          console.error(message);
          throw new RetentionExceededError(config.START_LEDGER, oldestLedger, message, unavailableRange);
        }
        await checkRetentionBoundary(server, config.START_LEDGER, DEFAULT_RETENTION_ALERT_THRESHOLD);
      }
    } catch (err) {
      if (err instanceof RetentionExceededError) throw err;
    }
  }

  await ensureDeadLetterTable();

  let currentLedger = config.START_LEDGER;
  let cursor: string | undefined = undefined;

  while (currentLedger <= headLedger) {
    if (signal?.aborted) throw signal.reason ?? new Error("backfill aborted");
    const backfillWindowLedgers = config.BACKFILL_WINDOW_LEDGERS ?? 10_000;
    const windowEndLedger = Math.min(
      currentLedger + backfillWindowLedgers - 1,
      headLedger,
    );
    const request: rpc.Api.GetEventsRequest = cursor
      ? {
          filters: [{ type: "contract" as const, contractIds: [config.MARKET_CONTRACT_ID] }],
          cursor,
          limit: config.EVENTS_PER_PAGE,
        }
      : {
          filters: [{ type: "contract" as const, contractIds: [config.MARKET_CONTRACT_ID] }],
          startLedger: currentLedger,
          endLedger: windowEndLedger,
          limit: config.EVENTS_PER_PAGE,
        };

    console.log(
      `[backfill] Fetching events page: ${cursor ? `cursor=${cursor}` : `startLedger=${currentLedger}`} (limit=${config.EVENTS_PER_PAGE})`
    );

    let response: rpc.Api.GetEventsResponse;
    try {
      response = await fetchWithRetry<rpc.Api.GetEventsResponse>(async (): Promise<rpc.Api.GetEventsResponse> => {
        return await server.getEvents(request);
      });
    } catch (err: any) {
      if (isRetentionExceededError(err)) {
        const msg = err instanceof Error ? err.message : String(err);
        let oldestLedger = extractOldestLedger(msg);
        if (oldestLedger === null && typeof (server as any).getHealth === "function") {
          try {
            const health = await (server as any).getHealth();
            oldestLedger = Number(health?.oldestLedger);
          } catch {}
        }
        const { message, unavailableRange } = formatRetentionExceededMessage(currentLedger, oldestLedger);
        console.error(message);
        throw new RetentionExceededError(currentLedger, oldestLedger, message, unavailableRange);
      }
      throw err;
    }
    if (signal?.aborted) throw signal.reason ?? new Error("backfill aborted");
    const events = response.events || [];

    if (events.length === 0) {
      console.log(`[backfill] Page returned 0 events. latestLedger=${response.latestLedger}`);
      if (response.latestLedger >= headLedger) {
        currentLedger = response.latestLedger;
        break;
      }
      const nextLedger = Math.min(response.latestLedger, windowEndLedger) + 1;
      currentLedger = Math.max(currentLedger + 1, nextLedger);
      cursor = undefined; // reset cursor as we are advancing startLedger
      continue;
    }

    console.log(`[backfill] Processing ${events.length} events...`);
    const pageStartMem = sampleMemoryUsage();
    await processEventsInChunks(events, EVENTS_PROCESSING_CHUNK_SIZE, async (event, eventIndex) => {
      if (signal?.aborted) throw signal.reason ?? new Error("backfill aborted");
      let topics: any[];
      let data: any;
      try {
        topics = event.topic.map((t: any) => scValToNative(t));
        data = scValToNative(event.value);
      } catch (err) {
        console.error(`[backfill] Failed to decode event: `, err);
        await insertDeadLetterEvent(event, Number((event as any).eventIndex ?? eventIndex), err);
        return;
      }
      await writeEventToDb(event.ledger, event.txHash, topics, data, Number((event as any).eventIndex ?? eventIndex));
    });
    const pageEndMem = sampleMemoryUsage();
    console.log(
      `[backfill] Page memory: heapUsed=${(pageEndMem.heapUsed / 1024 / 1024).toFixed(1)}MB ` +
      `rss=${(pageEndMem.rss / 1024 / 1024).toFixed(1)}MB ` +
      `heapDelta=${((pageEndMem.heapUsed - pageStartMem.heapUsed) / 1024 / 1024).toFixed(1)}MB`
    );

    const lastEventLedger = events[events.length - 1].ledger;
    if (response.cursor && response.cursor !== cursor) {
      cursor = response.cursor;
    } else {
      // A provider may omit a cursor on the final page. Advance past the
      // bounded window so a repeated final page cannot loop forever.
      currentLedger = Math.max(
        lastEventLedger + 1,
        Math.min(response.latestLedger, windowEndLedger) + 1,
      );
      cursor = undefined;
    }

    await checkRetentionBoundary(server, currentLedger, DEFAULT_RETENTION_ALERT_THRESHOLD);

    console.log(`[backfill] Processed events up to ledger ${lastEventLedger}`);

    if (lastEventLedger >= headLedger) {
      break;
    }
  }

  console.log(`[backfill] Completed backfill up to ledger ${currentLedger}`);
  return currentLedger;
}

export interface ReindexProgress {
  phase: "backfill" | "bet-counts" | "totals" | "leaderboard" | "completed";
  currentLedger: number;
  startLedger: number;
  targetLedger: number;
  processedLedgers: number;
  totalLedgers: number;
  percentComplete: number;
  eventsProcessed: number;
  rateLedgersPerSec: number;
  estimatedRemainingSec: number;
}

export interface ReindexOptions {
  startLedger?: number;
  endLedger?: number;
  resume?: boolean;
  rebuildLeaderboard?: boolean;
  recomputeTotals?: boolean;
  recomputeBetCounts?: boolean;
  onProgress?: (progress: ReindexProgress) => void;
  logger?: Logger;
  signal?: AbortSignal;
  db?: { query: (sql: string, params?: readonly unknown[]) => Promise<{ rows: any[] }> };
}

export interface ReindexResult {
  startLedger: number;
  latestLedger: number;
  totalEvents: number;
  durationMs: number;
  resumedFromCheckpoint: number | null;
  betCountsRecomputed: boolean;
  totalsRecomputed: boolean;
  leaderboardRebuilt: boolean;
}

/**
 * Unified, resumable reindex command with real-time progress logging.
 *
 * Coordinates:
 * 1. Event backfill from chain/RPC starting from last saved checkpoint (or START_LEDGER)
 * 2. Incremental checkpoint persistence so interrupted runs resume safely
 * 3. Derived state reconciliation:
 *    - Market bet counts (`recomputeMarketBetCountsFromBets`)
 *    - Market totals (`recomputeMarketTotalsFromBets`)
 *    - Leaderboard points table (`rebuildLeaderboardTable`)
 */
export async function runFullReindex(options: ReindexOptions = {}): Promise<ReindexResult> {
  const signal = options.signal;
  const db = options.db ?? pool;
  const server = new rpc.Server(config.SOROBAN_RPC_URL);

  if (signal?.aborted) throw new Error("reindex aborted");

  await ensureCheckpointTable(db);
  await ensureDeadLetterTable();

  const persistedCheckpoint = options.resume !== false ? await getCheckpointLedger(db) : null;
  const defaultStart = options.startLedger ?? config.START_LEDGER;
  let effectiveStartLedger = defaultStart;
  let resumedFromCheckpoint: number | null = null;

  if (persistedCheckpoint !== null && persistedCheckpoint >= defaultStart) {
    effectiveStartLedger = persistedCheckpoint + 1;
    resumedFromCheckpoint = persistedCheckpoint;
    console.log(
      `[reindex] Resuming reindex from persisted checkpoint at ledger ${persistedCheckpoint} (starting at ${effectiveStartLedger})...`,
    );
  } else {
    console.log(`[reindex] Starting full reindex from ledger ${effectiveStartLedger}...`);
  }

  console.log(`[reindex] Fetching current network head ledger...`);
  const latestLedgerResponse = await fetchWithRetry<rpc.Api.GetLatestLedgerResponse>(async () => {
    return await server.getLatestLedger();
  });
  const headLedger = options.endLedger ?? latestLedgerResponse.sequence;

  console.log(
    `[reindex] Target network head ledger is ${headLedger}. Range: [${effectiveStartLedger}..${headLedger}] (${Math.max(0, headLedger - effectiveStartLedger + 1)} ledgers)...`,
  );

  // Proactively check retention boundary if getHealth is supported
  if (typeof (server as any).getHealth === "function") {
    try {
      const health = await (server as any).getHealth();
      const oldestLedger = Number(health?.oldestLedger);
      if (!isNaN(oldestLedger)) {
        if (effectiveStartLedger < oldestLedger) {
          const { message, unavailableRange } = formatRetentionExceededMessage(effectiveStartLedger, oldestLedger);
          console.error(message);
          throw new RetentionExceededError(effectiveStartLedger, oldestLedger, message, unavailableRange);
        }
        await checkRetentionBoundary(server, effectiveStartLedger, DEFAULT_RETENTION_ALERT_THRESHOLD);
      }
    } catch (err) {
      if (err instanceof RetentionExceededError) throw err;
    }
  }

  let currentLedger = effectiveStartLedger;
  let cursor: string | undefined = undefined;
  let totalEvents = 0;
  const startTime = Date.now();
  const totalLedgersToProcess = Math.max(1, headLedger - effectiveStartLedger + 1);

  const reportProgress = (phase: ReindexProgress["phase"]) => {
    const processedLedgers = Math.max(0, currentLedger - effectiveStartLedger);
    const percentComplete = Math.min(100, Math.round((processedLedgers / totalLedgersToProcess) * 100));
    const elapsedSec = Math.max(0.1, (Date.now() - startTime) / 1000);
    const rateLedgersPerSec = Number((processedLedgers / elapsedSec).toFixed(1));
    const remainingLedgers = Math.max(0, headLedger - currentLedger);
    const estimatedRemainingSec = rateLedgersPerSec > 0 ? Math.round(remainingLedgers / rateLedgersPerSec) : 0;

    const progress: ReindexProgress = {
      phase,
      currentLedger,
      startLedger: effectiveStartLedger,
      targetLedger: headLedger,
      processedLedgers,
      totalLedgers: totalLedgersToProcess,
      percentComplete,
      eventsProcessed: totalEvents,
      rateLedgersPerSec,
      estimatedRemainingSec,
    };

    console.log(
      `[reindex] [${phase}] Progress: ${percentComplete}% | Ledger ${currentLedger}/${headLedger} (+${processedLedgers}/${totalLedgersToProcess}) | Events: ${totalEvents} | Rate: ${rateLedgersPerSec} ledgers/s | ETA: ${estimatedRemainingSec}s`,
    );

    options.onProgress?.(progress);
  };

  while (currentLedger <= headLedger) {
    if (signal?.aborted) throw signal.reason ?? new Error("reindex aborted");
    const backfillWindowLedgers = config.BACKFILL_WINDOW_LEDGERS ?? 10_000;
    const windowEndLedger = Math.min(
      currentLedger + backfillWindowLedgers - 1,
      headLedger,
    );
    const request: rpc.Api.GetEventsRequest = cursor
      ? {
          filters: [{ type: "contract" as const, contractIds: [config.MARKET_CONTRACT_ID] }],
          cursor,
          limit: config.EVENTS_PER_PAGE,
        }
      : {
          filters: [{ type: "contract" as const, contractIds: [config.MARKET_CONTRACT_ID] }],
          startLedger: currentLedger,
          endLedger: windowEndLedger,
          limit: config.EVENTS_PER_PAGE,
        };

    let response: rpc.Api.GetEventsResponse;
    try {
      response = await fetchWithRetry<rpc.Api.GetEventsResponse>(async (): Promise<rpc.Api.GetEventsResponse> => {
        return await server.getEvents(request);
      });
    } catch (err: any) {
      if (isRetentionExceededError(err)) {
        const msg = err instanceof Error ? err.message : String(err);
        let oldestLedger = extractOldestLedger(msg);
        if (oldestLedger === null && typeof (server as any).getHealth === "function") {
          try {
            const health = await (server as any).getHealth();
            oldestLedger = Number(health?.oldestLedger);
          } catch {}
        }
        const { message, unavailableRange } = formatRetentionExceededMessage(currentLedger, oldestLedger);
        console.error(message);
        throw new RetentionExceededError(currentLedger, oldestLedger, message, unavailableRange);
      }
      throw err;
    }
    if (signal?.aborted) throw new Error("reindex aborted");
    const events = response.events || [];

    if (events.length === 0) {
      if (response.latestLedger >= headLedger) {
        currentLedger = response.latestLedger;
        await saveCheckpointLedger(db, currentLedger);
        reportProgress("backfill");
        break;
      }
      const nextLedger = Math.min(response.latestLedger, windowEndLedger) + 1;
      currentLedger = Math.max(currentLedger + 1, nextLedger);
      await saveCheckpointLedger(db, currentLedger - 1);
      cursor = undefined;
      reportProgress("backfill");
      continue;
    }

    await processEventsInChunks(events, EVENTS_PROCESSING_CHUNK_SIZE, async (event, eventIndex) => {
      if (signal?.aborted) throw new Error("reindex aborted");
      let topics: any[];
      let data: any;
      try {
        topics = event.topic.map((t: any) => scValToNative(t));
        data = scValToNative(event.value);
      } catch (err) {
        console.error(`[reindex] Failed to decode event: `, err);
        await insertDeadLetterEvent(event, Number((event as any).eventIndex ?? eventIndex), err);
        return;
      }
      await writeEventToDb(event.ledger, event.txHash, topics, data, Number((event as any).eventIndex ?? eventIndex));
    });

    totalEvents += events.length;
    const lastEventLedger = events[events.length - 1].ledger;

    if (response.cursor && response.cursor !== cursor) {
      cursor = response.cursor;
    } else {
      currentLedger = Math.max(
        lastEventLedger + 1,
        Math.min(response.latestLedger, windowEndLedger) + 1,
      );
      cursor = undefined;
    }

    await saveCheckpointLedger(db, Math.min(headLedger, lastEventLedger));
    await checkRetentionBoundary(server, currentLedger, DEFAULT_RETENTION_ALERT_THRESHOLD);
    reportProgress("backfill");

    if (lastEventLedger >= headLedger) {
      currentLedger = headLedger;
      break;
    }
  }

  // Derived state reconciliation phases
  let betCountsDone = false;
  let totalsDone = false;
  let leaderboardDone = false;

  if (options.recomputeBetCounts !== false) {
    reportProgress("bet-counts");
    console.log("[reindex] Recomputing market bet counts from bets table...");
    const { recomputeMarketBetCountsFromBets } = await import("./recomputeBetCounts.js");
    await recomputeMarketBetCountsFromBets(db);
    betCountsDone = true;
  }

  if (options.recomputeTotals !== false) {
    reportProgress("totals");
    console.log("[reindex] Recomputing market totals from bets table...");
    const { recomputeMarketTotalsFromBets } = await import("./recomputeTotals.js");
    await recomputeMarketTotalsFromBets(db);
    totalsDone = true;
  }

  if (options.rebuildLeaderboard !== false) {
    reportProgress("leaderboard");
    console.log("[reindex] Rebuilding leaderboard points snapshot from events table...");
    const { rebuildLeaderboardTable } = await import("./leaderboard-rebuild.js");
    await rebuildLeaderboardTable(db, { sinceLedger: effectiveStartLedger });
    leaderboardDone = true;
  }

  reportProgress("completed");
  const durationMs = Date.now() - startTime;
  console.log(
    `[reindex] Reindex finished successfully in ${(durationMs / 1000).toFixed(1)}s! Checked ledgers up to ${currentLedger}, total events processed: ${totalEvents}.`,
  );

  return {
    startLedger: effectiveStartLedger,
    latestLedger: Math.min(headLedger, currentLedger),
    totalEvents,
    durationMs,
    resumedFromCheckpoint,
    betCountsRecomputed: betCountsDone,
    totalsRecomputed: totalsDone,
    leaderboardRebuilt: leaderboardDone,
  };
}

// Direct CLI entry point if executed directly
if (process.argv[1]?.endsWith("backfill.ts") || process.argv.includes("--reindex")) {
  runFullReindex()
    .then(() => pool.end())
    .catch((err) => {
      console.error("[reindex] Fatal error:", err);
      pool.end().finally(() => {
        process.exitCode = 1;
      });
    });
}

