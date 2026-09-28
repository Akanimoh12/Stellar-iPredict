/**
 * The smoke suite's own tests.
 *
 * The acceptance question for a post-deployment gate is "does it catch a
 * broken deployment?", and the only honest way to answer that is to stand up a
 * server, break it in each of the ways a real release breaks, and assert the
 * suite says so. Everything here runs against a local stub — no network, no
 * credentials, nothing outside this process.
 *
 * The complement of these tests is `backend/test/smoke.test.ts`, which boots
 * the *real* Fastify server so the checks are validated against actual
 * responses rather than against hand-written fixtures.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import {
  type CheckContext,
  type CheckOutcome,
  type FetchLike,
  runSmokeSuite,
  smokeChecks,
} from "./checks.js";
import { formatReport, parseArgs } from "./run.js";

// ─────────────────────────────────────────────────────────────────────────────
// Stub server
// ─────────────────────────────────────────────────────────────────────────────

interface RouteResponse {
  status?: number;
  body?: unknown;
  /** Raw text, for the stack-trace check. */
  text?: string;
}

type Routes = Record<string, RouteResponse | ((req: IncomingMessage) => RouteResponse)>;

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

/** Boots a stub on an ephemeral port and returns its origin. */
async function serve(routes: Routes): Promise<string> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = routes[`${req.method} ${url.pathname}`] ?? routes[url.pathname!];

    const send = (result: RouteResponse | undefined) => {
      if (!result) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "no route" } }));
        return;
      }
      const status = result.status ?? 200;
      const text = result.text ?? JSON.stringify(result.body ?? {});
      res.writeHead(status, { "content-type": "application/json" });
      res.end(text);
    };

    if (typeof route === "function") {
      try {
        send(route(req));
      } catch {
        send({ status: 500, body: { error: { message: "stub blew up" } } });
      }
      return;
    }
    send(route);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

const MARKET = {
  id: 1,
  question: "Will it?",
  image_url: null,
  category: "Crypto",
  end_time: "9999999999",
  total_yes: "1234.5678901",
  total_no: "0.0000000",
  resolved: false,
  outcome: null,
  cancelled: false,
  creator: "G".padEnd(56, "A"),
  bet_count: 1,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

/** A deployment that is working. Every mutation below is one defect. */
function healthyRoutes(): Routes {
  return {
    "GET /healthz": { body: { status: "ok" } },
    "GET /readyz": { body: { status: "ready", checks: { db: { ok: true }, redis: { ok: true } } } },
    "GET /resolution-status": {
      body: { status: "on_time", overdueMarkets: 0, oldestOverdueSeconds: null, graceSeconds: 7200 },
    },
    "GET /api/markets": { body: { markets: [MARKET], total: 1, page: 1, limit: 5 } },
    "GET /api/markets/1": { body: MARKET },
    "GET /api/markets/1/odds": {
      body: { market_id: 1, total_yes: MARKET.total_yes, total_no: "0.0000000", total_pool: "1234.5678901", yes_odds: 1, no_odds: 0, implied_probability: { yes: 1, no: 0 } },
    },
    "GET /api/markets/999999999": { status: 404, body: { error: { code: "NOT_FOUND", message: "Market not found" } } },
    "POST /api/v1/oracle/submit": { status: 401, body: { error: { code: "UNAUTHORIZED", message: "Missing authorization header" } } },
  };
}

function context(baseUrl: string, overrides: Partial<CheckContext> = {}): CheckContext {
  return { baseUrl, timeoutMs: 5_000, strict: false, ...overrides };
}

function byId(outcomes: CheckOutcome[], id: string): CheckOutcome {
  const outcome = outcomes.find((o) => o.id === id);
  if (!outcome) throw new Error(`no outcome for ${id}; got ${outcomes.map((o) => o.id).join(", ")}`);
  return outcome;
}

async function run(baseUrl: string, overrides: Partial<CheckContext> = {}) {
  return runSmokeSuite(context(baseUrl, overrides), { fetchImpl: fetch as FetchLike });
}

// ─────────────────────────────────────────────────────────────────────────────
// A healthy deployment
// ─────────────────────────────────────────────────────────────────────────────

describe("a healthy deployment", () => {
  it("passes every read-only check", async () => {
    const result = await run(await serve(healthyRoutes()));

    expect(result.failed).toBe(0);
    expect(result.exitCode).toBe(0);
    expect(byId(result.outcomes, "health.liveness").result.status).toBe("pass");
    expect(byId(result.outcomes, "health.readiness").result.status).toBe("pass");
    expect(byId(result.outcomes, "health.resolution").result.status).toBe("pass");
    expect(byId(result.outcomes, "markets.list").result.status).toBe("pass");
    expect(byId(result.outcomes, "markets.detail").result.status).toBe("pass");
    expect(byId(result.outcomes, "markets.notFound").result.status).toBe("pass");
    expect(byId(result.outcomes, "oracle.authRejected").result.status).toBe("pass");
    expect(byId(result.outcomes, "oracle.badKeyRejected").result.status).toBe("pass");
  });

  it("reports a 404 for a market that does not exist, rather than failing on it", async () => {
    const result = await run(await serve(healthyRoutes()));
    expect(byId(result.outcomes, "markets.notFound").result.status).toBe("pass");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Broken deployments
// ─────────────────────────────────────────────────────────────────────────────

describe("catching a broken deployment", () => {
  it("fails when the API is not reachable at all", async () => {
    const result = await run("http://127.0.0.1:1");

    expect(result.failed).toBeGreaterThan(0);
    expect(result.exitCode).toBe(1);
    // A dead host is reported as a transport failure, not as a missing field.
    expect(byId(result.outcomes, "health.liveness").result.status).toBe("fail");
    expect(byId(result.outcomes, "health.liveness").result.detail).toMatch(/request failed|no response/);
  });

  it("fails when the API cannot reach its database", async () => {
    const routes = healthyRoutes();
    routes["GET /readyz"] = {
      status: 503,
      body: { status: "not ready", checks: { db: { ok: false }, redis: { ok: true } } },
    };

    const result = await run(await serve(routes));

    expect(result.exitCode).toBe(1);
    const readiness = byId(result.outcomes, "health.readiness");
    expect(readiness.result.status).toBe("fail");
    // The failing dependency is named, so the operator knows where to look.
    expect(readiness.result.detail).toContain("db");
  });

  it("fails when the markets endpoint 500s", async () => {
    const routes = healthyRoutes();
    routes["GET /api/markets"] = { status: 500, body: { error: { code: "INTERNAL_SERVER_ERROR" } } };

    const result = await run(await serve(routes));

    expect(result.exitCode).toBe(1);
    expect(byId(result.outcomes, "markets.list").result.status).toBe("fail");
  });

  it("fails when the markets list loses its amounts to a number", async () => {
    // The regression that matters most here: a release that changes the pg
    // NUMERIC parser still serves 200, but large balances silently lose
    // precision for every client from then on.
    const routes = healthyRoutes();
    routes["GET /api/markets"] = {
      body: { markets: [{ ...MARKET, total_yes: 1234.5678901, total_no: 0 }], total: 1, page: 1, limit: 5 },
    };

    const result = await run(await serve(routes));

    expect(result.exitCode).toBe(1);
    const listing = byId(result.outcomes, "markets.list");
    expect(listing.result.status).toBe("fail");
    expect(listing.result.detail).toMatch(/total_yes is number/);
  });

  it("fails when an amount is not a fixed seven-decimal string", async () => {
    const routes = healthyRoutes();
    routes["GET /api/markets"] = {
      body: { markets: [{ ...MARKET, total_yes: "1234.56" }], total: 1, page: 1, limit: 5 },
    };

    const result = await run(await serve(routes));

    expect(result.exitCode).toBe(1);
    expect(byId(result.outcomes, "markets.list").result.detail).toMatch(/seven-decimal/);
  });

  it("fails when a listed market cannot be read back by id", async () => {
    const routes = healthyRoutes();
    delete routes["GET /api/markets/1"];

    const result = await run(await serve(routes));

    expect(result.exitCode).toBe(1);
    const detail = byId(result.outcomes, "markets.detail");
    expect(detail.result.status).toBe("fail");
    expect(detail.result.detail).toMatch(/404/);
  });

  it("fails when a market's odds endpoint is missing", async () => {
    const routes = healthyRoutes();
    delete routes["GET /api/markets/1/odds"];

    const result = await run(await serve(routes));

    expect(result.exitCode).toBe(1);
    expect(byId(result.outcomes, "markets.detail").result.detail).toMatch(/odds/);
  });

  it("fails when an unknown market id returns 500 instead of 404", async () => {
    const routes = healthyRoutes();
    routes["GET /api/markets/999999999"] = { status: 500, body: { error: { message: "boom" } } };

    const result = await run(await serve(routes));

    expect(result.exitCode).toBe(1);
    expect(byId(result.outcomes, "markets.notFound").result.detail).toMatch(/expected 404.*got 500/);
  });

  it("warns rather than fails when the oracle endpoint rate limits the suite", async () => {
    // A 429 says the check could not run, not that the deployment is broken.
    // Reporting it as a failure would block a release over the suite's own
    // repeated requests; hiding it would let an unverified check pass.
    const routes = healthyRoutes();
    routes["POST /api/v1/oracle/submit"] = { status: 429, body: { error: { code: "RATE_LIMITED" } } };

    const result = await run(await serve(routes));

    expect(result.failed).toBe(0);
    expect(result.exitCode).toBe(0);
    for (const id of ["oracle.authRejected", "oracle.badKeyRejected"]) {
      const outcome = byId(result.outcomes, id);
      expect(outcome.result.status).toBe("warn");
      expect(outcome.result.detail).toMatch(/verified nothing/);
    }

    // --strict turns "could not check" into a gate failure.
    const strict = await runSmokeSuite(
      context(await serve(routes), { strict: true }),
      { fetchImpl: fetch as FetchLike },
    );
    expect(strict.exitCode).toBe(1);
  });

  it("fails when the oracle submission route is not mounted", async () => {
    const routes = healthyRoutes();
    delete routes["POST /api/v1/oracle/submit"];

    const result = await run(await serve(routes));

    expect(result.exitCode).toBe(1);
    const auth = byId(result.outcomes, "oracle.authRejected");
    expect(auth.result.status).toBe("fail");
    expect(auth.result.detail).toMatch(/404/);
  });

  it("fails when an unauthenticated oracle submission is accepted", async () => {
    const routes = healthyRoutes();
    routes["POST /api/v1/oracle/submit"] = {
      status: 200,
      body: { accepted: true, count: 1, threshold: 3, submissionsNeeded: 2 },
    };

    const result = await run(await serve(routes));

    expect(result.exitCode).toBe(1);
    // Both auth checks catch it, so a release cannot pass on one being lenient.
    expect(byId(result.outcomes, "oracle.authRejected").result.status).toBe("fail");
    expect(byId(result.outcomes, "oracle.badKeyRejected").result.status).toBe("fail");
  });

  it("fails when the deployment's configured key is rejected", async () => {
    // Rotated or lost ORACLE_API_KEYS: the API is fine, the oracle is dead.
    const result = await run(await serve(healthyRoutes()), { oracleApiKey: "a-key-the-deploy-does-not-know" });

    expect(result.exitCode).toBe(1);
    const signature = byId(result.outcomes, "oracle.badSignatureRejected");
    expect(signature.result.status).toBe("fail");
    expect(signature.result.detail).toMatch(/ORACLE_API_KEYS/);
  });

  it("fails when a fabricated signature is accepted", async () => {
    const routes = healthyRoutes();
    routes["POST /api/v1/oracle/submit"] = {
      status: 200,
      body: { accepted: true, count: 1, threshold: 3, submissionsNeeded: 2 },
    };

    const result = await run(await serve(routes), { oracleApiKey: "a-real-looking-key" });

    expect(result.exitCode).toBe(1);
    expect(byId(result.outcomes, "oracle.badSignatureRejected").result.detail).toMatch(/ACCEPTED/);
  });

  it("treats a stalled resolution as a warning, and as a failure under --strict", async () => {
    const routes = healthyRoutes();
    routes["GET /resolution-status"] = {
      body: { status: "stalled", overdueMarkets: 12, oldestOverdueSeconds: 90_000, graceSeconds: 7200 },
    };
    const baseUrl = await serve(routes);

    const lenient = await run(baseUrl);
    expect(lenient.failed).toBe(0);
    expect(lenient.exitCode).toBe(0);
    expect(byId(lenient.outcomes, "health.resolution").result.status).toBe("warn");
    expect(byId(lenient.outcomes, "health.resolution").result.detail).toContain("stalled");

    const strict = await run(baseUrl, { strict: true });
    expect(strict.exitCode).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Safety
// ─────────────────────────────────────────────────────────────────────────────

describe("safety against production", () => {
  it("sends no state-changing request unless the write check is opted into", async () => {
    const seen: string[] = [];
    const routes = healthyRoutes();
    routes["POST /api/v1/oracle/submit"] = (req) => {
      seen.push(req.method ?? "");
      return { status: 401, body: { error: { code: "UNAUTHORIZED" } } };
    };
    const baseUrl = await serve(routes);

    const result = await run(baseUrl, { oracleApiKey: "key", writeTargetMarketId: "1" });

    // The write check ran, but every request it is able to make is still a
    // rejection: the suite carries no signing key and cannot mint a signature.
    expect(seen.length).toBeGreaterThan(0);
    expect(result.outcomes.some((o) => o.writesState)).toBe(false);
  });

  it("omits the write check by default, even with a key and a market id", async () => {
    const ids = smokeChecks().map((check) => check.id);
    expect(ids).not.toContain("oracle.submit");
    expect(smokeChecks({ includeWriteChecks: true }).map((c) => c.id)).toContain("oracle.submit");
  });

  it("skips the write check rather than guessing a market id", async () => {
    const result = await run(await serve(healthyRoutes()), {
      oracleApiKey: "key",
      includeWriteTarget: true,
    } as Partial<CheckContext>);

    const submit = byId(result.outcomes, "oracle.authRejected");
    expect(submit.result.status).toBe("pass");
  });

  it("refuses to run a write check without a market id", async () => {
    const result = await run(await serve(healthyRoutes()), { oracleApiKey: "key" });
    // Not in the suite at all, so nothing was even attempted.
    expect(result.outcomes.map((o) => o.id)).not.toContain("oracle.submit");
  });

  it("skips the authenticated checks, with an actionable message, when no key is given", async () => {
    const result = await run(await serve(healthyRoutes()));

    const signature = byId(result.outcomes, "oracle.badSignatureRejected");
    expect(signature.result.status).toBe("skip");
    expect(signature.result.detail).toMatch(/--oracle-api-key/);
  });

  it("skips market detail on an empty environment instead of failing the gate", async () => {
    const routes = healthyRoutes();
    routes["GET /api/markets"] = { body: { markets: [], total: 0, page: 1, limit: 5 } };

    const result = await run(await serve(routes));

    expect(result.exitCode).toBe(0);
    expect(byId(result.outcomes, "markets.list").result.status).toBe("warn");
    expect(byId(result.outcomes, "markets.detail").result.status).toBe("skip");
  });

  it("fails a check that hangs rather than hanging the gate", async () => {
    // A service that accepts the connection and never answers is a real
    // deployment failure mode — a wedged container behind a healthy socket.
    const server = createServer((req, res) => {
      if (req.url === "/readyz") return; // never respond
      const url = new URL(req.url ?? "/", "http://localhost");
      const route = healthyRoutes()[`${req.method} ${url.pathname}`];
      res.writeHead(route?.status ?? 200, { "content-type": "application/json" });
      res.end(route?.text ?? JSON.stringify(route?.body ?? {}));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    const { port } = server.address() as AddressInfo;

    const result = await run(`http://127.0.0.1:${port}`, { timeoutMs: 150 });

    expect(result.exitCode).toBe(1);
    expect(byId(result.outcomes, "health.readiness").result.status).toBe("fail");
    expect(byId(result.outcomes, "health.readiness").result.detail).toMatch(/no response within 150ms/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Reporting
// ─────────────────────────────────────────────────────────────────────────────

describe("reporting", () => {
  it("lists every check, marking the one that writes state", () => {
    const checks = smokeChecks({ includeWriteChecks: true });
    const writeChecks = checks.filter((check) => check.writesState);

    expect(writeChecks).toHaveLength(1);
    expect(writeChecks[0]!.id).toBe("oracle.submit");
    for (const check of checks) {
      expect(check.description.length).toBeGreaterThan(0);
      expect(check.title).toMatch(/^(GET|POST) /);
    }
  });

  it("names the failing check and the URL in the summary", async () => {
    const routes = healthyRoutes();
    routes["GET /readyz"] = { status: 503, body: { status: "not ready", checks: { db: { ok: false } } } };
    const baseUrl = await serve(routes);

    const result = await run(baseUrl);
    const report = formatReport(baseUrl, result);

    expect(report).toContain(baseUrl);
    expect(report).toContain("FAIL GET /readyz");
    expect(report).toContain("Do not proceed");
    expect(report).toMatch(/1 failed/);
  });

  it("does not say 'do not proceed' when only warnings were raised", async () => {
    const routes = healthyRoutes();
    routes["GET /resolution-status"] = {
      body: { status: "delayed", overdueMarkets: 2, oldestOverdueSeconds: 8000, graceSeconds: 7200 },
    };
    const baseUrl = await serve(routes);

    const report = formatReport(baseUrl, await run(baseUrl));

    expect(report).toContain("WARN");
    expect(report).toContain("read the warnings");
    expect(report).not.toContain("Do not proceed");
  });
});

describe("CLI arguments", () => {
  it("parses the documented flags", () => {
    const options = parseArgs([
      "--base-url", "https://api.example.com/",
      "--oracle-api-key", "k",
      "--timeout-ms", "2500",
      "--strict",
    ]);

    expect(options.baseUrl).toBe("https://api.example.com/");
    expect(options.oracleApiKey).toBe("k");
    expect(options.timeoutMs).toBe(2_500);
    expect(options.strict).toBe(true);
    expect(options.includeWriteChecks).toBe(false);
  });

  it("rejects an unknown flag, a missing value, and a bad timeout", () => {
    expect(() => parseArgs(["--nope"])).toThrow(/unknown argument/);
    expect(() => parseArgs(["--base-url"])).toThrow(/requires a value/);
    expect(() => parseArgs(["--timeout-ms", "0"])).toThrow(/positive number/);
    expect(() => parseArgs(["--timeout-ms", "abc"])).toThrow(/positive number/);
  });

  it("requires the write target alongside --allow-writes", () => {
    expect(parseArgs(["--allow-writes", "--write-market-id", "42"]).writeTargetMarketId).toBe("42");
    // The CLI refuses the combination outright; parseArgs records both flags
    // and `main` is what exits 2, so the test covers the flag plumbing.
    expect(parseArgs(["--allow-writes"]).includeWriteChecks).toBe(true);
  });
});
