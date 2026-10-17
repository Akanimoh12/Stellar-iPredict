import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { profileRoutes } from "./profile.js";
import { oracleRoutes } from "./oracle.js";

/**
 * Route index.
 *
 * Every feature router is listed here and mounted under a single versioned
 * prefix, so route files never spell out `/api/...` themselves — they declare
 * paths relative to the version (`/profile/:address`) and this module decides
 * where they hang. Shipping a breaking change then means adding a `v2` mount
 * beside `v1`, not editing every route file.
 */

/** Current API version. Bumped only for breaking changes. */
export const API_VERSION = "v1";

/** Prefix every feature route is served under. */
export const API_PREFIX = `/api/${API_VERSION}`;

/**
 * Feature routers, in registration order.
 *
 * Routers are plain Fastify plugins: each gets its own encapsulated context, so
 * a hook or decorator added by one cannot leak into another.
 */
export const routers: FastifyPluginAsync[] = [profileRoutes, oracleRoutes];

/** The versioned API as one plugin, with no prefix of its own. */
export const apiRoutes: FastifyPluginAsync = async (api) => {
  for (const router of routers) {
    await api.register(router);
  }
};

/**
 * Mounts the whole API under {@link API_PREFIX}.
 *
 * Call after the OpenAPI plugin so the spec generator's `onRoute` hook is
 * already listening when these routes are added.
 */
export function registerApiRoutes(app: FastifyInstance): void {
  app.register(apiRoutes, { prefix: API_PREFIX });
}

// ─────────────────────────────────────────────────────────────────────────────
// Route Authentication Registry (#548)
// ─────────────────────────────────────────────────────────────────────────────

export type RouteAuthType = "protected" | "public";

export interface ProtectedRouteDefinition {
  readonly method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  readonly url: string;
  readonly auth: "protected";
  readonly description: string;
}

export interface PublicRouteDefinition {
  readonly method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  readonly url: string;
  readonly auth: "public";
  /** Explicit reason documenting why this route is intentionally public without auth. */
  readonly reason: string;
}

export type RouteAuthDefinition = ProtectedRouteDefinition | PublicRouteDefinition;

/**
 * Explicit registry of protected routes that require authentication.
 *
 * Every route listed here MUST enforce authentication and reject unauthenticated requests.
 */
export const PROTECTED_ROUTES: readonly ProtectedRouteDefinition[] = Object.freeze([
  {
    method: "POST",
    url: "/api/v1/oracle/submit",
    auth: "protected",
    description: "Oracle provider submission intake (requires oracle API key via authorization Bearer or x-api-key)",
  },
  {
    method: "POST",
    url: "/api/oracle/submit",
    auth: "protected",
    description: "Legacy oracle provider submission intake (requires oracle API key via authorization Bearer or x-api-key)",
  },
]);

/**
 * Explicit registry of intentionally public routes.
 *
 * Each route must include a specific justification (`reason`) documenting why it
 * does not require authentication. A new route is never implicitly public — any route
 * omitted from both lists fails the verification suite (#548).
 */
export const PUBLIC_ROUTES: readonly PublicRouteDefinition[] = Object.freeze([
  {
    method: "GET",
    url: "/api/docs",
    auth: "public",
    reason: "Public OpenAPI documentation specification for developer exploration and schema consumption",
  },
  {
    method: "GET",
    url: "/healthz",
    auth: "public",
    reason: "Liveness probe for orchestrators and load balancers to determine process responsiveness",
  },
  {
    method: "GET",
    url: "/readyz",
    auth: "public",
    reason: "Readiness probe verifying DB and Redis dependencies before routing external traffic",
  },
  {
    method: "GET",
    url: "/resolution-status",
    auth: "public",
    reason: "Public operational health check and market resolution status feed",
  },
  {
    method: "GET",
    url: "/status",
    auth: "public",
    reason: "Public operational status feed consumed by independent status page monitoring",
  },
  {
    method: "GET",
    url: "/api/markets",
    auth: "public",
    reason: "Public read-only market listings with pagination and filtering for all clients",
  },
  {
    method: "GET",
    url: "/api/markets/resolution-status",
    auth: "public",
    reason: "Public read-only market resolution status feed",
  },
  {
    method: "GET",
    url: "/api/markets/unmappable",
    auth: "public",
    reason: "Public read-only list of markets flagged with unmappable or ambiguous resolution conditions",
  },
  {
    method: "GET",
    url: "/api/markets/:id",
    auth: "public",
    reason: "Public read-only market detail view by numeric market identifier",
  },
  {
    method: "GET",
    url: "/api/markets/:id/bets",
    auth: "public",
    reason: "Public read-only betting history for a specific prediction market",
  },
  {
    method: "GET",
    url: "/api/markets/:id/odds",
    auth: "public",
    reason: "Public read-only calculated odds and probability aggregates for a prediction market",
  },
  {
    method: "GET",
    url: "/api/leaderboard",
    auth: "public",
    reason: "Public global player ranking and points leaderboard",
  },
  {
    method: "GET",
    url: "/api/stats",
    auth: "public",
    reason: "Public platform-wide aggregate statistics (markets, volume, users, bets)",
  },
  {
    method: "GET",
    url: "/api/v1/profile/:address",
    auth: "public",
    reason: "Public player profile and bet history by Stellar public key address",
  },
]);

/** Complete route authentication registry combining protected and public classifications. */
export const ROUTE_AUTH_REGISTRY: readonly RouteAuthDefinition[] = Object.freeze([
  ...PROTECTED_ROUTES,
  ...PUBLIC_ROUTES,
]);

/**
 * Normalizes an HTTP method and URL path for robust comparison across route formats.
 * Normalizes parameter formats (`:id` and `{id}`) to canonical `:id`, trims whitespace,
 * converts method to uppercase, and strips trailing slashes.
 */
export function normalizeRouteKey(method: string, path: string): string {
  const normMethod = method.trim().toUpperCase();
  const normPath =
    path
      .trim()
      .replace(/\{([A-Za-z0-9_]+)\}/g, ":$1")
      .replace(/\/+$/, "") || "/";
  return `${normMethod} ${normPath}`;
}

export interface RouteClassificationResult {
  /** Routes that matched a definition in the registry. */
  classified: {
    method: string;
    url: string;
    canonicalKey: string;
    auth: RouteAuthType;
    definition: RouteAuthDefinition;
  }[];
  /** Routes present on the Fastify instance that are in neither the protected nor public list. */
  unclassified: {
    method: string;
    url: string;
    canonicalKey: string;
  }[];
  /** Routes defined in the registry that were not found on the Fastify instance. */
  unregistered: {
    canonicalKey: string;
    auth: RouteAuthType;
  }[];
  protectedRoutes: readonly ProtectedRouteDefinition[];
  publicRoutes: readonly PublicRouteDefinition[];
}

/**
 * Evaluates a list of registered routes against the route authentication registry.
 * Discovers any unclassified routes (fail-closed) and any stale registry definitions.
 */
export function classifyFastifyRoutes(
  registeredRoutes: { method: string; url: string }[],
  registry: readonly RouteAuthDefinition[] = ROUTE_AUTH_REGISTRY,
): RouteClassificationResult {
  const registryMap = new Map<string, RouteAuthDefinition>();
  for (const entry of registry) {
    registryMap.set(normalizeRouteKey(entry.method, entry.url), entry);
  }

  const classified: RouteClassificationResult["classified"] = [];
  const unclassified: RouteClassificationResult["unclassified"] = [];
  const seenKeys = new Set<string>();

  for (const route of registeredRoutes) {
    const canonicalKey = normalizeRouteKey(route.method, route.url);
    seenKeys.add(canonicalKey);
    const match = registryMap.get(canonicalKey);
    if (match) {
      classified.push({
        method: route.method,
        url: route.url,
        canonicalKey,
        auth: match.auth,
        definition: match,
      });
    } else {
      unclassified.push({
        method: route.method,
        url: route.url,
        canonicalKey,
      });
    }
  }

  const unregistered: RouteClassificationResult["unregistered"] = [];
  for (const [key, entry] of registryMap.entries()) {
    if (!seenKeys.has(key)) {
      unregistered.push({
        canonicalKey: key,
        auth: entry.auth,
      });
    }
  }

  return {
    classified,
    unclassified,
    unregistered,
    protectedRoutes: PROTECTED_ROUTES,
    publicRoutes: PUBLIC_ROUTES,
  };
}

/**
 * Asserts that every route on the Fastify instance is classified and that no stale
 * entries remain in the registry. Throws if any unclassified or orphaned route exists.
 */
export function assertAllRoutesClassified(
  registeredRoutes: { method: string; url: string }[],
  registry: readonly RouteAuthDefinition[] = ROUTE_AUTH_REGISTRY,
): void {
  const result = classifyFastifyRoutes(registeredRoutes, registry);
  if (result.unclassified.length > 0) {
    const unclassifiedList = result.unclassified.map((r) => r.canonicalKey).join(", ");
    throw new Error(
      `Unclassified route(s) detected on Fastify instance: [${unclassifiedList}]. ` +
      `Every route must be explicitly classified in ROUTE_AUTH_REGISTRY as either protected or public.`
    );
  }
  if (result.unregistered.length > 0) {
    const unregisteredList = result.unregistered.map((r) => r.canonicalKey).join(", ");
    throw new Error(
      `Stale registry route(s) not found on Fastify instance: [${unregisteredList}]. ` +
      `ROUTE_AUTH_REGISTRY must only contain routes actually registered on the server.`
    );
  }
}
