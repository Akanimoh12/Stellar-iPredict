export interface PaginationParams {
  limit: number;
  offset: number;
}

export interface PaginatedResponse<T> {
  data: T[];
  /**
   * Total number of rows matching the active filters (not just this page).
   *
   * Accuracy guarantee: callers should compute `total` in the SAME query
   * that fetches `data` — e.g. via a `COUNT(*) OVER ()` window function
   * added to the paginated SELECT — rather than with a second, separate
   * `COUNT(*)` query. Computed this way, `total` is an EXACT count of rows
   * matching the filters as of that single query's snapshot: it can't drift
   * from a concurrent write racing between two round trips, and it doesn't
   * double the query cost of the endpoint (still one query, one round trip).
   * It does not reflect writes that commit after the query ran; the next
   * request will pick those up.
   *
   * (For tables large enough that even one exact `COUNT(*) OVER ()` is too
   * costly, an approximate count from planner statistics — e.g.
   * `reltuples`/`pg_class` — is a reasonable alternative, but then this
   * guarantee must be downgraded to "approximate" in the endpoint's own
   * docs.)
   */
  total: number;
  limit: number;
  offset: number;
}

/**
 * Parses limit and offset from an unknown query object.
 * Falls back to default values if parameters are missing or invalid.
 */
export function parsePagination(
  query: Record<string, unknown>,
  defaultLimit = 20,
  maxLimit = 100
): PaginationParams {
  let limit = defaultLimit;
  let offset = 0;

  if (query && query.limit !== undefined && query.limit !== null) {
    const parsedLimit = parseInt(String(query.limit), 10);
    if (!Number.isNaN(parsedLimit) && parsedLimit > 0) {
      limit = Math.min(parsedLimit, maxLimit);
    }
  }

  if (query && query.offset !== undefined && query.offset !== null) {
    const parsedOffset = parseInt(String(query.offset), 10);
    if (!Number.isNaN(parsedOffset) && parsedOffset >= 0) {
      offset = parsedOffset;
    }
  }

  return { limit, offset };
}

/**
 * Constructs a standard paginated response envelope.
 */
export function paginatedResponse<T>(
  data: T[],
  total: number,
  params: PaginationParams
): PaginatedResponse<T> {
  return {
    data,
    total,
    limit: params.limit,
    offset: params.offset,
  };
}

// Backward-compatible aliases for existing imports.
export const parsePaginationParams = parsePagination;
export const createPaginatedResponse = paginatedResponse;
