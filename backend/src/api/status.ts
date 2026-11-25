/**
 * Public status feed for an external status page (issue #259).
 *
 * One unauthenticated endpoint summarising whether the platform is working:
 * API dependencies, how far behind the indexer is, and the most recently
 * resolved market.
 *
 * ## What is deliberately *not* here
 *
 * This response is public, so it carries no error strings, hostnames,
 * connection details, versions, counts of internal resources, or user
 * addresses. A failing dependency reports `ok: false` and nothing more — the
 * detailed reason stays in `/readyz`, which is an internal probe. Anything
 * added here must pass the same test: would we publish it on a status page?
 *
 * ## Never fails
 *
 * A status endpoint that 500s during an incident is worthless, so every
 * section is computed defensively: a failing dependency degrades its own
 * section and the overall level, and the handler still answers `200`. Callers
 * read {@link StatusFeed.status}, not the HTTP code.
 */

import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import type { Pool } from "pg";
import { getOrSet } from "../cache/cacheAside.js";
import { CACHE_TTLS, statusKey } from "../cache/cacheKeys.js";
import { pingDb } from "../db/health.js";
import { pingRedis } from "../db/redis.js";

/** Seconds without a new indexed event before the indexer is considered behind. */
export const INDEXER_STALE_AFTER_SECONDS = 300;

/** How long a generated feed may be reused. */
export const STATUS_CACHE_TTL_SECONDS = CACHE_TTLS.statusFeed;

/**
 * Overall health.
 *
 * - `ok` — everything is working.
 * - `degraded` — serving traffic, but something is wrong (cache down, or the
 *   indexer is behind, so market data may be out of date).
 * - `down` — the database is unreachable; the API cannot serve real data.
 */
export type StatusLevel = "ok" | "degraded" | "down";

/** A dependency check, reduced to what is safe to publish. */
export interface DependencyStatus {
  ok: boolean;
  /** Round-trip time of the probe. Omitted when the probe failed. */
  latencyMs?: number;
}

export interface IndexerStatus {
  /** False when no events have been indexed within {@link INDEXER_STALE_AFTER_SECONDS}. */
  ok: boolean;
  /** Highest ledger the indexer has written, or `null` before the first event. */
  lastIndexedLedger: number | null;
  /** When the newest event was indexed (ISO 8601), or `null` if none. */
  lastEventAt: string | null;
  /** Seconds since that event, or `null` if none. */
  lagSeconds: number | null;
}

export interface ResolvedMarketSummary {
  id: number;
  question: string;
  /** The winning side. */
  outcome: "yes" | "no";
  /** When the market was resolved (ISO 8601). */
  resolvedAt: string | null;
}

export interface StatusFeed {
  status: StatusLevel;
  /**
   * When this snapshot was built (ISO 8601). Because the feed is cached, this
   * can trail the request by up to {@link STATUS_CACHE_TTL_SECONDS}; consumers
   * should treat it as the real observation time.
   */
  generatedAt: string;
  api: {
    ok: boolean;
    db: DependencyStatus;
    redis: DependencyStatus;
  };
  indexer: IndexerStatus;
  /** Most recently resolved market, or `null` if none has resolved yet. */
  lastResolvedMarket: ResolvedMarketSummary | null;
}

/** Strips everything but `ok` and latency, so probe errors never reach the public feed. */
function publicDependency(result: {
  ok: boolean;
  latencyMs?: number;
}): DependencyStatus {
  return result.ok && result.latencyMs !== undefined
    ? { ok: true, latencyMs: result.latencyMs }
    : { ok: result.ok };
}

function toIso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

const UNKNOWN_INDEXER: IndexerStatus = {
  // Unknown is not healthy: if we cannot read the indexer's progress we cannot
  // promise the data is current.
  ok: false,
  lastIndexedLedger: null,
  lastEventAt: null,
  lagSeconds: null,
};

/**
 * Reads how far the indexer has progressed.
 *
 * Lag is measured as the age of the newest indexed event rather than the gap to
 * the chain head: it needs no RPC call, so the status feed stays cheap and has
 * no external dependency of its own.
 */
async function readIndexerStatus(pool: Pool, now: number): Promise<IndexerStatus> {
  const result = await pool.query<{
    last_ledger: string | null;
    last_event_at: Date | null;
  }>(
    `SELECT MAX(ledger_seq)::text AS last_ledger,
            MAX(created_at)       AS last_event_at
       FROM events`
  );

  const row = result.rows[0];
  const lastIndexedLedger =
    row?.last_ledger != null ? Number(row.last_ledger) : null;
  const lastEventAt = toIso(row?.last_event_at ?? null);

  if (lastEventAt === null) {
    // Nothing indexed yet. Report it plainly instead of inventing a lag: a
    // fresh deployment is not the same failure as an indexer that has stalled.
    return { ok: false, lastIndexedLedger, lastEventAt: null, lagSeconds: null };
  }

  const lagSeconds = Math.max(
    0,
    Math.round((now - new Date(lastEventAt).getTime()) / 1000)
  );

  return {
    ok: lagSeconds <= INDEXER_STALE_AFTER_SECONDS,
    lastIndexedLedger,
    lastEventAt,
    lagSeconds,
  };
}

/** Reads the most recently resolved market. */
async function readLastResolvedMarket(
  pool: Pool
): Promise<ResolvedMarketSummary | null> {
  // `updated_at` is stamped by the market_resolved handler, and a resolved
  // market takes no further bets, so it is effectively the resolution time.
  const result = await pool.query<{
    id: string;
    question: string;
    outcome: boolean | null;
    updated_at: Date | null;
  }>(
    `SELECT id::text, question, outcome, updated_at
       FROM markets
      WHERE resolved = TRUE AND cancelled = FALSE
      ORDER BY updated_at DESC NULLS LAST
      LIMIT 1`
  );

  const row = result.rows[0];
  if (row === undefined) return null;

  return {
    id: Number(row.id),
    question: row.question,
    outcome: row.outcome === true ? "yes" : "no",
    resolvedAt: toIso(row.updated_at),
  };
}

/**
 * Builds a fresh snapshot.
 *
 * Every section is independently guarded: one broken dependency degrades its
 * own section rather than failing the whole feed.
 */
export async function buildStatusFeed(pool: Pool | undefined): Promise<StatusFeed> {
  const now = Date.now();

  const [dbPing, redisPing] = await Promise.all([
    pingDb().catch(() => ({ ok: false })),
    pingRedis().catch(() => ({ ok: false })),
  ]);

  const db = publicDependency(dbPing);
  const redis = publicDependency(redisPing);

  const [indexer, lastResolvedMarket] = pool
    ? await Promise.all([
        readIndexerStatus(pool, now).catch(() => UNKNOWN_INDEXER),
        readLastResolvedMarket(pool).catch(() => null),
      ])
    : [UNKNOWN_INDEXER, null];

  // The database is the only hard dependency: without it nothing can be served.
  // A cold cache or a lagging indexer degrades quality, not availability.
  const status: StatusLevel = !db.ok
    ? "down"
    : redis.ok && indexer.ok
      ? "ok"
      : "degraded";

  return {
    status,
    generatedAt: new Date(now).toISOString(),
    api: { ok: db.ok, db, redis },
    indexer,
    lastResolvedMarket,
  };
}

const dependencySchema = {
  type: "object",
  properties: { ok: { type: "boolean" }, latencyMs: { type: "number" } },
  required: ["ok"],
} as const;

/**
 * Mounts `GET /status`.
 *
 * Unversioned like the other probes: a status page consumes operational
 * signals, not the client API contract.
 *
 * The route is added inside a plugin rather than straight onto the instance so
 * it loads after the OpenAPI plugin and is picked up by its `onRoute` hook —
 * a route registered directly would load first and be missing from the spec.
 */
export function registerStatusRoutes(
  server: FastifyInstance,
  pool?: Pool,
  redis?: Redis
): void {
  server.register(async (scope) => {
    scope.get(
      "/status",
      {
        schema: {
          summary: "Public status feed for a status page",
          description:
            "Health of the API, indexer progress, and the last resolved market. " +
            "Always returns 200 — read the `status` field, not the HTTP code.",
          tags: ["system"],
          response: {
            200: {
              type: "object",
              properties: {
                status: { type: "string", enum: ["ok", "degraded", "down"] },
                generatedAt: { type: "string" },
                api: {
                  type: "object",
                  properties: {
                    ok: { type: "boolean" },
                    db: dependencySchema,
                    redis: dependencySchema,
                  },
                  required: ["ok", "db", "redis"],
                },
                indexer: {
                  type: "object",
                  properties: {
                    ok: { type: "boolean" },
                    lastIndexedLedger: { type: ["number", "null"] },
                    lastEventAt: { type: ["string", "null"] },
                    lagSeconds: { type: ["number", "null"] },
                  },
                  required: ["ok", "lastIndexedLedger", "lastEventAt", "lagSeconds"],
                },
                lastResolvedMarket: {
                  type: ["object", "null"],
                  properties: {
                    id: { type: "number" },
                    question: { type: "string" },
                    outcome: { type: "string", enum: ["yes", "no"] },
                    resolvedAt: { type: ["string", "null"] },
                  },
                  required: ["id", "question", "outcome", "resolvedAt"],
                },
              },
              required: ["status", "generatedAt", "api", "indexer", "lastResolvedMarket"],
            },
          },
        },
      },
      async (_request, reply) => {
        const load = () => buildStatusFeed(pool);

        let feed: StatusFeed;
        if (redis) {
          try {
            feed = await getOrSet(
              redis,
              statusKey(),
              STATUS_CACHE_TTL_SECONDS,
              load
            );
          } catch {
            // Redis is exactly what the feed should still work without — an
            // unreachable cache must not take the status page down with it.
            feed = await load();
          }
        } else {
          feed = await load();
        }

        // Public and shareable: a status page is often fronted by a CDN, and
        // shedding poll traffic is the point. `stale-while-revalidate` keeps the
        // page readable during the refresh.
        return reply
          .header(
            "Cache-Control",
            `public, max-age=${STATUS_CACHE_TTL_SECONDS}, stale-while-revalidate=${STATUS_CACHE_TTL_SECONDS * 2}`
          )
          .status(200)
          .send(feed);
      }
    );
  });
}
