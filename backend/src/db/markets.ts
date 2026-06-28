import { Pool } from "pg";
import { config } from "../config/index.js";

export type MarketFilter = "active" | "resolved" | "ended" | "cancelled" | "all";
export type MarketSort = "newest" | "volume" | "ending_soon" | "bettors";
export type MarketCategory = "Crypto" | "Sports" | "Politics" | "Entertainment" | "Science";

export type GetMarketsInput = {
  filter?: MarketFilter;
  category?: MarketCategory;
  sort?: MarketSort;
  page?: number;
  limit?: number;
};

export type MarketRow = {
  id: number;
  question: string;
  image_url: string | null;
  category: string;
  end_time: string;
  total_yes: string;
  total_no: string;
  resolved: boolean;
  outcome: boolean | null;
  cancelled: boolean;
  creator: string;
  bet_count: number;
  created_at: Date;
  updated_at: Date;
};

export type GetMarketsResult = {
  rows: MarketRow[];
  total: number;
  page: number;
  limit: number;
};

export type Queryable = {
  query<T>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
};

const pool = new Pool({ connectionString: config.DATABASE_URL });

const ORDER_BY: Record<MarketSort, string> = {
  newest: "created_at DESC",
  volume: "(total_yes + total_no) DESC, created_at DESC",
  ending_soon: "end_time ASC",
  bettors: "bet_count DESC, created_at DESC"
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
    limit = 20
  }: GetMarketsInput,
  db: Queryable = pool
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

  const whereSql = whereConditions.length > 0 ? `WHERE ${whereConditions.join(" AND ")}` : "";
  const offset = (page - 1) * limit;

  const rowsQuery = `
    SELECT
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
    db.query<{ total: number }>(countQuery, baseValues)
  ]);

  return {
    rows,
    total: totalRows[0]?.total ?? 0,
    page,
    limit
  };
}
