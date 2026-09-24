import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";

// The readiness probes ping real infrastructure; stub them so sweeping every
// route never opens a Redis or Postgres connection.
vi.mock("@/db/health", () => ({ pingDb: vi.fn(async () => ({ ok: true, latencyMs: 1 })) }));
vi.mock("@/db/redis", () => ({ pingRedis: vi.fn(async () => ({ ok: true, latencyMs: 1 })) }));

import { buildServer } from "@/server";
import { createFakePool } from "@/test/fakePool";

// CORS must reach every route no matter where or how it was registered (#470).
// The first three groups below were once registered ahead of the CORS plugin,
// so each is exercised individually rather than assumed to behave like the
// rest; the route-table sweep then covers anything added in the future.

const ALLOWED = "https://ipredict.app";
const DENIED = "https://evil.example";

let server: FastifyInstance | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function makeServer(): Promise<FastifyInstance> {
  server = buildServer({ corsOrigins: [ALLOWED], pool: createFakePool(), logger: false });
  await server.ready();
  return server;
}

// The rate limiter's store is shared by every server in the process, keyed by
// client IP. A distinct forwarded address per request keeps these tests from
// tripping each other's limits.
let clientCounter = 0;
function freshClient(): Record<string, string> {
  clientCounter += 1;
  return { "x-forwarded-for": `198.51.100.${clientCounter % 250}, 10.0.${clientCounter}.1` };
}

/** Fills route params with a placeholder so the path matches the route. */
function concretePath(url: string): string {
  return url.replace(/:[A-Za-z0-9_]+/g, "placeholder").replace(/\*$/, "placeholder");
}

function request(
  app: FastifyInstance,
  method: string,
  url: string,
  headers: Record<string, string>
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: method as InjectOptions["method"],
    url,
    headers: { ...freshClient(), ...headers },
  });
}

function preflight(app: FastifyInstance, method: string, url: string, origin: string) {
  return request(app, "OPTIONS", url, {
    origin,
    "access-control-request-method": method,
    "access-control-request-headers": "content-type,authorization",
  });
}

function corsHeaders(headers: Record<string, unknown>): string[] {
  return Object.keys(headers).filter((name) => name.startsWith("access-control-"));
}

const ROUTE_GROUPS = [
  { group: "leaderboard", method: "GET", url: "/api/leaderboard" },
  { group: "stats", method: "GET", url: "/api/stats" },
  { group: "oracle", method: "POST", url: "/api/oracle/submit" },
  { group: "health (inline plugin)", method: "GET", url: "/healthz" },
  { group: "markets", method: "GET", url: "/api/markets" },
  { group: "readiness", method: "GET", url: "/readyz" },
  { group: "status", method: "GET", url: "/status" },
  { group: "versioned /api/v1", method: "POST", url: "/api/v1/oracle/submit" },
  { group: "metrics", method: "GET", url: "/metrics" },
] as const;

describe.each(ROUTE_GROUPS)("CORS on the $group route group", ({ method, url }) => {
  it(`grants an allowed origin on ${method} ${url}`, async () => {
    const app = await makeServer();

    const res = await request(app, method, url, { origin: ALLOWED });

    expect(res.headers["access-control-allow-origin"]).toBe(ALLOWED);
    expect(res.headers["access-control-expose-headers"]).toContain("Retry-After");
    // Caches must key on Origin, or one origin's grant is served to another.
    expect(String(res.headers["vary"])).toMatch(/origin/i);
  });

  it(`sends no CORS headers to a disallowed origin on ${method} ${url}`, async () => {
    const app = await makeServer();

    const res = await request(app, method, url, { origin: DENIED });

    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
  });

  it(`answers a preflight for ${method} ${url}`, async () => {
    const app = await makeServer();

    const res = await preflight(app, method, url, ALLOWED);

    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(ALLOWED);
    expect(res.headers["access-control-allow-methods"]).toContain(method);
    expect(String(res.headers["access-control-allow-headers"]).toLowerCase()).toContain("authorization");
  });

  it(`grants nothing to a disallowed origin's preflight for ${method} ${url}`, async () => {
    const app = await makeServer();

    const res = await preflight(app, method, url, DENIED);

    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("CORS across the whole route table", () => {
  // Guard for routes that do not exist yet: anything registered in a way that
  // escapes the CORS hook — inside an encapsulated scope, or behind a hook
  // that replies before CORS runs — shows up here by name.
  it("applies to every registered route", async () => {
    const app = await makeServer();
    const routes = app.registeredRoutes;

    // Not vacuous: the three formerly misordered groups are in the table.
    const urls = routes.map((r) => r.url);
    expect(urls).toEqual(
      expect.arrayContaining(["/api/leaderboard", "/api/stats", "/api/oracle/submit"])
    );

    const failures: string[] = [];
    for (const { method, url } of routes) {
      const path = concretePath(url);
      const route = `${method} ${url}`;

      const allowed = await request(app, method, path, { origin: ALLOWED });
      if (allowed.headers["access-control-allow-origin"] !== ALLOWED) {
        failures.push(`${route}: allowed origin not granted (status ${allowed.statusCode})`);
      }

      const denied = await request(app, method, path, { origin: DENIED });
      if (corsHeaders(denied.headers).length > 0) {
        failures.push(`${route}: disallowed origin got ${corsHeaders(denied.headers).join(", ")}`);
      }

      const pre = await preflight(app, method, path, ALLOWED);
      if (pre.statusCode !== 204 || pre.headers["access-control-allow-origin"] !== ALLOWED) {
        failures.push(`${route}: preflight failed (status ${pre.statusCode})`);
      }
    }

    expect(failures, failures.join("\n")).toEqual([]);
  });
});

describe("CORS on responses sent before the route handler", () => {
  it("keeps CORS headers on a 429 so the browser can read Retry-After", async () => {
    const app = await makeServer();
    // One client, so the limiter actually trips (oracle submit allows 10/min).
    const client = freshClient();

    let res = await app.inject({ method: "POST", url: "/api/oracle/submit", headers: { ...client, origin: ALLOWED } });
    for (let i = 0; i < 15 && res.statusCode !== 429; i++) {
      res = await app.inject({ method: "POST", url: "/api/oracle/submit", headers: { ...client, origin: ALLOWED } });
    }

    expect(res.statusCode).toBe(429);
    expect(res.headers["retry-after"]).toBeDefined();
    expect(res.headers["access-control-allow-origin"]).toBe(ALLOWED);
    expect(res.headers["access-control-expose-headers"]).toContain("Retry-After");
    // The limiter runs after helmet too, so a 429 is no less locked down.
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("keeps CORS headers on a 404 for an unknown path", async () => {
    const app = await makeServer();

    const res = await request(app, "GET", "/api/does-not-exist", { origin: ALLOWED });

    expect(res.statusCode).toBe(404);
    expect(res.headers["access-control-allow-origin"]).toBe(ALLOWED);
  });

  it("keeps CORS headers on a 405 for a known path with the wrong method", async () => {
    const app = await makeServer();

    const res = await request(app, "DELETE", "/api/stats", { origin: ALLOWED });

    expect(res.statusCode).toBe(405);
    expect(res.headers["access-control-allow-origin"]).toBe(ALLOWED);
  });

  it("still hides /metrics behind a plain 404 from an unauthorized caller", async () => {
    const app = await makeServer();

    const res = await request(app, "GET", "/metrics", { origin: ALLOWED });

    expect(res.statusCode).toBe(404);
  });
});
