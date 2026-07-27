export interface PaginationParams {
  limit: number;
  offset: number;
}

export interface PaginatedResponse<T> {
  data: T[];
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
 * Defaults data to empty array and total to 0 when null/undefined.
 */
export function paginatedResponse<T>(
  data: T[] | null | undefined,
  total: number | null | undefined,
  params: PaginationParams
): PaginatedResponse<T> {
  return {
    data: data ?? [],
    total: total ?? 0,
    limit: params.limit,
    offset: params.offset,
  };
}

// Backward-compatible aliases for existing imports.
export const parsePaginationParams = parsePagination;
export const createPaginatedResponse = paginatedResponse;
