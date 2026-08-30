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
