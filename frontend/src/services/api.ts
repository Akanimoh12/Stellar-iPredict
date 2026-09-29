export interface Market {
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
  created_at: string;
  updated_at: string;
}

export interface MarketsQuery {
  filter?: "active" | "resolved" | "ended" | "cancelled" | "all";
  category?: "Crypto" | "Sports" | "Politics" | "Entertainment" | "Science";
  sort?: "newest" | "volume" | "ending_soon" | "bettors";
  page?: number;
  limit?: number;
}

export interface MarketsResponse {
  markets: Market[];
  total: number;
  page: number;
  limit: number;
}

export interface LeaderboardPlayer {
  address: string;
  display_name: string | null;
  points: string;
  won_bets: number;
  lost_bets: number;
  updated_at?: string;
}

export interface LeaderboardQuery {
  offset?: number;
  limit?: number;
  sort?: "points" | "bets";
}

export interface LeaderboardResponse {
  players: LeaderboardPlayer[];
  total: number;
}

export interface PlatformStats {
  totalMarkets: number;
  totalVolume: string | number;
  totalUsers: number;
  totalBets: number;
}

export interface ProfileBet {
  market_id: number;
  bettor: string;
  net_amount: string;
  gross_amount: string;
  is_yes: boolean;
  claimed: boolean;
  created_at: string;
}

export interface ProfileResponse {
  bets: ProfileBet[];
  points: string;
  won_bets: number;
  lost_bets: number;
}

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

/**
 * The backend is opt-in so deployments can roll it out without changing the
 * existing frontend data source by default.
 *
 * These variables must be accessed directly because Next.js only exposes
 * NEXT_PUBLIC_* variables to client bundles when it can statically analyze
 * the property access.
 */
export const USE_BACKEND_API =
  process.env.NEXT_PUBLIC_USE_BACKEND_API === "true";

export const API_BASE_URL = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(
  /\/$/,
  ""
);

function queryString(values: Record<string, unknown>): string {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && value !== "") {
      params.set(key, String(value));
    }
  }

  const result = params.toString();
  return result ? `?${result}` : "";
}

function endpoint(path: string, useBackend: boolean): string {
  // Relative URLs preserve the existing frontend behaviour when the flag is
  // disabled. An absolute URL is used only for the backend data source.
  return `${useBackend ? API_BASE_URL : ""}${path}`;
}

async function request<T>(path: string, useBackend: boolean): Promise<T> {
  const response = await fetch(endpoint(path, useBackend), {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
  });

  const contentType = response.headers.get("content-type") ?? "";
  const body: unknown = contentType.includes("application/json")
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    const message =
      typeof body === "object" &&
      body !== null &&
      "message" in body &&
      typeof body.message === "string"
        ? body.message
        : `API request failed with status ${response.status}`;
    throw new ApiError(response.status, message, body);
  }

  return body as T;
}

export interface ApiDataSource {
  getMarkets(query?: MarketsQuery): Promise<MarketsResponse>;
  getMarket(id: number | string): Promise<Market>;
  getLeaderboard(query?: LeaderboardQuery): Promise<LeaderboardResponse>;
  getStats(): Promise<PlatformStats>;
  getProfile(address: string): Promise<ProfileResponse>;
}

function createDataSource(useBackend: boolean): ApiDataSource {
  return {
    getMarkets(query = {}) {
      return request<MarketsResponse>(
        `/api/markets${queryString(query)}`,
        useBackend
      );
    },

    getMarket(id) {
      return request<Market>(
        `/api/markets/${encodeURIComponent(String(id))}`,
        useBackend
      );
    },

    getLeaderboard(query = {}) {
      return request<LeaderboardResponse>(
        `/api/leaderboard${queryString(query)}`,
        useBackend
      );
    },

    getStats() {
      return request<PlatformStats>("/api/stats", useBackend);
    },

    getProfile(address) {
      return request<ProfileResponse>(
        `/api/v1/profile/${encodeURIComponent(address)}`,
        useBackend
      );
    },
  };
}

/** The indexed backend data source. */
export const backendApi = createDataSource(true);

/** The existing relative-path data source, retained for backwards compatibility. */
export const legacyApi = createDataSource(false);

/** Returns the data source selected by NEXT_PUBLIC_USE_BACKEND_API. */
export function getApiDataSource(): ApiDataSource {
  return USE_BACKEND_API ? backendApi : legacyApi;
}

/** Feature-flagged market client. */
export function getMarkets(query?: MarketsQuery): Promise<MarketsResponse> {
  return getApiDataSource().getMarkets(query);
}

/** Feature-flagged market detail client. */
export function getMarket(id: number | string): Promise<Market> {
  return getApiDataSource().getMarket(id);
}

/** Feature-flagged leaderboard client. */
export function getLeaderboard(
  query?: LeaderboardQuery
): Promise<LeaderboardResponse> {
  return getApiDataSource().getLeaderboard(query);
}

/** Feature-flagged platform statistics client. */
export function getStats(): Promise<PlatformStats> {
  return getApiDataSource().getStats();
}

/** Feature-flagged profile client. */
export function getProfile(address: string): Promise<ProfileResponse> {
  return getApiDataSource().getProfile(address);
}

// Descriptive aliases for callers that use fetch-style naming.
export const fetchMarkets = getMarkets;
export const fetchMarket = getMarket;
export const fetchLeaderboard = getLeaderboard;
export const fetchStats = getStats;
export const fetchProfile = getProfile;
