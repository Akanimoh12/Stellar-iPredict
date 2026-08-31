import { Pool } from "pg";
import type { FilterableMarketCategory } from "@ipredict/shared";
import type { MarketRow } from "./types.js";

export type MarketFilter = "active" | "resolved" | "ended" | "cancelled" | "all";
export type MarketSort = "newest" | "volume" | "ending_soon" | "bettors";
export type MarketCategory = FilterableMarketCategory;

export type GetMarketsInput = {
  filter?: MarketFilter;
  category?: MarketCategory;
  sort?: MarketSort;
  page?: number;
  limit?: number;
};

// Re-export for backwards compatibility
export type { MarketRow };

export type GetMarketsResult = {
  rows: MarketRow[];
  total: number;
  page: number;
  limit: number;
};

export type Queryable = {
  query<T>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
};

let pool: Pool | undefined;

function getDefaultDb(): Queryable {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }
  pool ??= new Pool({ connectionString });
  return pool;
}

const MARKET_COLUMNS = `
  id,
  question,
  image_url,
  category,
  end_time,
  total_yes,
  total_no,
  resolved,
  outcome,
  cancelled,
  creator,
  bet_count,
  created_at,
  updated_at
`;

const ORDER_BY: Record<MarketSort, string> = {
  newest: "created_at DESC",
  volume: "(total_yes + total_no) DESC, created_at DESC",
  ending_soon: "end_time ASC",
  bettors: "bet_count DESC, created_at DESC",
};

function buildFilterClause(filter: MarketFilter): string {
  switch (filter) {
    case "active":
      return "resolved = false AND cancelled = false AND end_time > EXTRACT(EPOCH FROM NOW())::BIGINT";
    case "resolved":
      return "resolved = true";
    case "ended":
      return "resolved = false AND cancelled = false AND end_time <= EXTRACT(EPOCH FROM NOW())::BIGINT";
    case "cancelled":
      return "cancelled = true";
    case "all":
    default:
      return "";
  }
}

export async function getMarkets(
  {
    filter = "all",
    category,
    sort = "newest",
    page = 1,
    limit = 20,
  }: GetMarketsInput,
  db: Queryable = getDefaultDb(),
): Promise<GetMarketsResult> {
  if (!Number.isInteger(page) || page < 1) {
    throw new Error("page must be a positive integer");
  }
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("limit must be a positive integer");
  }

  const baseValues: unknown[] = [];
  const whereConditions: string[] = [];

  if (category) {
    baseValues.push(category);
    whereConditions.push(`category = $${baseValues.length}`);
  }

  const filterClause = buildFilterClause(filter);
  if (filterClause) {
    whereConditions.push(filterClause);
  }

  if (sort === "ending_soon") {
    whereConditions.push(
      "resolved = false AND cancelled = false AND end_time > EXTRACT(EPOCH FROM NOW())::BIGINT",
    );
  }

  const whereSql =
    whereConditions.length > 0 ? `WHERE ${whereConditions.join(" AND ")}` : "";
  const offset = (page - 1) * limit;

  const rowsQuery = `
    SELECT
      ${MARKET_COLUMNS}
    FROM markets
    ${whereSql}
    ORDER BY ${ORDER_BY[sort]}
    LIMIT $${baseValues.length + 1}
    OFFSET $${baseValues.length + 2}
  `;

  const rowsValues = [...baseValues, limit, offset];
  const countQuery = `SELECT COUNT(*)::INT AS total FROM markets ${whereSql}`;

  const [{ rows }, { rows: totalRows }] = await Promise.all([
    db.query<MarketRow>(rowsQuery, rowsValues),
    db.query<{ total: number }>(countQuery, baseValues),
  ]);

  return {
    rows,
    total: totalRows[0]?.total ?? 0,
    page,
    limit,
  };
}

export async function getMarketById(
  id: number,
  db: Queryable = getDefaultDb(),
): Promise<MarketRow | null> {
  if (!Number.isInteger(id) || id < 1) {
    throw new Error("id must be a positive integer");
  }

  const query = `
    SELECT
      ${MARKET_COLUMNS}
    FROM markets
    WHERE id = $1
    LIMIT 1
  `;

  const { rows } = await db.query<MarketRow>(query, [id]);
  return rows[0] ?? null;
}

// ── Resolution-delay detection (issue #645) ──────────────────────────────────
//
// The backend cannot observe the oracle aggregator process directly, so it
// infers an outage the same way a user would notice one: markets whose
// `end_time` passed well beyond the normal resolution lag and that are still
// neither resolved nor cancelled. Sustained, growing backlog == aggregator
// unavailable.

/** Overdue past `end_time` by more than this (seconds) before it counts as delayed. */
const DEFAULT_RESOLUTION_GRACE_SECONDS = Number(
  process.env.RESOLUTION_GRACE_SECONDS ?? 2 * 60 * 60,
);
/** Oldest overdue market beyond this (seconds) escalates `delayed` → `stalled`. */
const DEFAULT_RESOLUTION_STALLED_SECONDS = Number(
  process.env.RESOLUTION_STALLED_SECONDS ?? 12 * 60 * 60,
);

export type ResolutionHealthStatus = "on_time" | "delayed" | "stalled";

export type ResolutionDelayStatus = {
  status: ResolutionHealthStatus;
  /** Markets past `end_time` + grace, still unresolved and not cancelled. */
  overdueMarkets: number;
  /** Age of the oldest overdue market, in seconds; `null` when none. */
  oldestOverdueSeconds: number | null;
  /** IDs of overdue markets (capped), so a client can flag them individually. */
  delayedMarketIds: number[];
  graceSeconds: number;
  checkedAt: string;
};

export async function getResolutionDelayStatus(
  db: Queryable = getDefaultDb(),
  opts: {
    graceSeconds?: number;
    stalledSeconds?: number;
    now?: number;
    limitIds?: number;
  } = {},
): Promise<ResolutionDelayStatus> {
  const graceSeconds = opts.graceSeconds ?? DEFAULT_RESOLUTION_GRACE_SECONDS;
  const stalledSeconds = opts.stalledSeconds ?? DEFAULT_RESOLUTION_STALLED_SECONDS;
  const nowSeconds = Math.floor((opts.now ?? Date.now()) / 1000);
  const limitIds = opts.limitIds ?? 50;
  const cutoff = nowSeconds - graceSeconds;

  const { rows } = await db.query<{ id: string | number; end_time: string | number }>(
    `SELECT id, end_time
       FROM markets
      WHERE resolved = false
        AND cancelled = false
        AND end_time::bigint < $1
      ORDER BY end_time ASC
      LIMIT $2`,
    [cutoff, limitIds],
  );

  const overdueMarkets = rows.length;
  const oldestOverdueSeconds =
    overdueMarkets > 0 ? nowSeconds - Number(rows[0].end_time) : null;

  let status: ResolutionHealthStatus = "on_time";
  if (overdueMarkets > 0) {
    status =
      oldestOverdueSeconds !== null && oldestOverdueSeconds >= stalledSeconds
        ? "stalled"
        : "delayed";
  }

  return {
    status,
    overdueMarkets,
    oldestOverdueSeconds,
    delayedMarketIds: rows.map((r) => Number(r.id)),
    graceSeconds,
    checkedAt: new Date(nowSeconds * 1000).toISOString(),
  };
}
