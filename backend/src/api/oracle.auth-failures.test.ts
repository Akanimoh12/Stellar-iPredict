import crypto from "node:crypto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { Keypair } from "@stellar/stellar-sdk";
import { registerErrorHandler } from "../lib/errors.js";
import { signOracleMessage, oracleRoutes } from "./oracle.js";
import type { OracleSubmissionRow } from "../db/types.js";
import {
  getOracleAuthFailureSnapshot,
  resetOracleAuthFailures,
} from "../lib/oracleAuthFailures.js";

/**
 * Oracle authentication-failure telemetry, end to end (issue #576).
 *
 * These exercise the route rather than the helpers: the acceptance criterion is
 * that a rejected request is *observable*, and that only holds if the wiring
 * from the handler to the counter and the logger is real. The unit tests in
 * `lib/oracleAuthFailures.test.ts` cover the classifier; these cover the seam.
 *
 * `config` parses the environment lazily on first access and the route's first
 * property read happens inside this file, so the env assignments below (which
 * run before any request) are what the route sees. No `resetModules` dance is
 * needed, which matters because the telemetry collector is process-wide — a
 * module reset would leave these assertions looking at a different instance.
 */

const PROVIDER_A = Keypair.random();
const PROVIDER_B = Keypair.random();
const KEY_A = "key-for-provider-a";
const KEY_B = "key-for-provider-b";

const sha256Hex = (value: string) =>
  crypto.createHash("sha256").update(value, "utf8").digest("hex");

const entry = (kp: Keypair, key: string) =>
  `${kp.publicKey()}:sha256$${sha256Hex(key)}`;

// Per-provider credentials, so a key used for the wrong provider can be told
// from an unrecognised one.
process.env.ORACLE_API_KEYS = `${entry(PROVIDER_A, KEY_A)},${entry(PROVIDER_B, KEY_B)}`;
delete process.env.ORACLE_API_KEY;

// Small baseline so a couple of requests exercise the classifier.
process.env.ORACLE_AUTH_FAILURE_MIN_COUNT = "2";
process.env.ORACLE_AUTH_FAILURE_DISTINCT_SOURCES = "3";

/** A database stub complete enough to reach a 200 for a valid submission. */
function makeDb() {
  const submissions: OracleSubmissionRow[] = [];

  const db = {
    async query<T>(text: string, values?: unknown[]): Promise<{ rows: T[] }> {
      const sql = text.replace(/\s+/g, " ").trim();

      if (sql.includes("FROM oracle_providers")) {
        return {
          rows: [
            { address: PROVIDER_A.publicKey() },
            { address: PROVIDER_B.publicKey() },
          ] as unknown as T[],
        };
      }

      if (sql.includes("FROM markets")) {
        return {
          rows: [
            {
              id: 1,
              resolved: false,
              cancelled: false,
              end_time: String(Math.floor(Date.now() / 1000) - 3600),
            },
          ] as unknown as T[],
        };
      }

      if (sql.includes("INSERT INTO oracle_submissions")) {
        const [market_id, submitter, outcome, bond_amount] = (values ?? []) as [
          number,
          string,
          string,
          string,
        ];
        const row: OracleSubmissionRow = {
          id: submissions.length + 1,
          market_id: String(market_id),
          submitter,
          outcome,
          bond_amount,
          submitted_at: new Date(),
          status: "submitted",
        };
        submissions.push(row);
        return { rows: [row as unknown as T] };
      }

      if (sql.includes("SELECT COUNT(*)::text AS count FROM oracle_submissions")) {
        return { rows: [{ count: String(submissions.length) } as unknown as T] };
      }

      return { rows: [] };
    },
  };

  return { db, submissions };
}

interface Harness {
  app: FastifyInstance;
  lines: Record<string, unknown>[];
}

async function buildApp(): Promise<Harness> {
  const lines: Record<string, unknown>[] = [];
  const stream = {
    write(line: string) {
      try {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        /* pino always writes JSON; ignore anything else */
      }
    },
  };

  const app = Fastify({ logger: { level: "info", stream } });
  registerErrorHandler(app);

  const { db } = makeDb();
  await app.register(async (routes) => {
    routes.decorate("pool", db);
    await routes.register(oracleRoutes, { prefix: "/api/v1" });
  });
  await app.ready();

  return { app, lines };
}

/** The schema-valid submission shape the route validates before auth runs. */
function body(provider: string, overrides: Record<string, unknown> = {}) {
  return {
    marketId: 1,
    outcome: "YES",
    signature: "not-checked-before-auth",
    provider,
    ...overrides,
  };
}

let h: Harness;

beforeEach(async () => {
  resetOracleAuthFailures();
  h = await buildApp();
});

afterEach(async () => {
  await h.app.close();
  resetOracleAuthFailures();
});

describe("oracle auth failure telemetry at the route (#576)", () => {
  it("counts a missing header and logs the source without a credential", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/v1/oracle/submit",
      remoteAddress: "203.0.113.5",
      payload: body(PROVIDER_A.publicKey()),
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toBe("Missing authorization header");

    const snap = getOracleAuthFailureSnapshot();
    expect(snap.totalAttempts).toBe(1);
    expect(snap.totalByReason.missing_header).toBe(1);
    expect(snap.topSource).toBe("203.0.113.5");

    const line = h.lines.find((l) => l.msg === "oracle auth failure missing_header");
    expect(line).toBeDefined();
    expect(line!.source).toBe("203.0.113.5");
    expect(line!.scheme).toBe("none");
    expect(line!.requestId).toBeDefined();
  });

  it("counts an unrecognised key and never logs the attempted value", async () => {
    const attempted = "super-secret-guess-value";

    const res = await h.app.inject({
      method: "POST",
      url: "/api/v1/oracle/submit",
      headers: { authorization: `Bearer ${attempted}` },
      payload: body(PROVIDER_A.publicKey()),
    });

    expect(res.statusCode).toBe(401);
    expect(getOracleAuthFailureSnapshot().totalByReason.invalid_key).toBe(1);

    const line = h.lines.find((l) => l.msg === "oracle auth failure invalid_key");
    expect(line).toBeDefined();
    expect(line!.scheme).toBe("bearer");
    // The whole point of the issue: a near-miss key in the logs is a
    // credential in the logs.
    expect(JSON.stringify(h.lines)).not.toContain(attempted);
  });

  it("counts a valid key used for the wrong provider as provider_mismatch", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/v1/oracle/submit",
      headers: { authorization: `Bearer ${KEY_B}` },
      payload: body(PROVIDER_A.publicKey()),
    });

    expect(res.statusCode).toBe(403);
    const snap = getOracleAuthFailureSnapshot();
    expect(snap.totalByReason.provider_mismatch).toBe(1);
    expect(snap.totalByReason.invalid_key).toBe(0);

    const line = h.lines.find(
      (l) => l.msg === "oracle auth failure provider_mismatch",
    );
    expect(line).toBeDefined();
    expect(line!.provider).toBe(PROVIDER_A.publicKey());
  });

  it("counts a successful authentication as an attempt but not a failure", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/v1/oracle/submit",
      headers: { authorization: `Bearer ${KEY_A}` },
      payload: body(PROVIDER_A.publicKey(), {
        signature: signOracleMessage(
          { marketId: 1, outcome: "YES", provider: PROVIDER_A.publicKey() },
          PROVIDER_A,
        ),
      }),
    });

    expect(res.statusCode).toBe(200);

    const snap = getOracleAuthFailureSnapshot();
    expect(snap.totalAttempts).toBe(1);
    expect(snap.totalFailures).toBe(0);
    expect(
      h.lines.some((l) => String(l.msg).startsWith("oracle auth failure")),
    ).toBe(false);
  });

  it("raises a misconfiguration spike for repeated failures from one source", async () => {
    for (let i = 0; i < 2; i++) {
      await h.app.inject({
        method: "POST",
        url: "/api/v1/oracle/submit",
        remoteAddress: "198.51.100.9",
        headers: { authorization: "Bearer wrong-key" },
        payload: body(PROVIDER_A.publicKey()),
      });
    }

    const spike = h.lines.find(
      (l) => l.msg === "oracle auth failure spike: misconfigured_provider",
    );
    expect(spike).toBeDefined();
    expect(spike!.level).toBe("warning");
    expect(spike!.distinctSources).toBe(1);
  });

  it("raises a distributed-guessing spike when keys fail from many sources", async () => {
    for (const ip of ["198.51.100.1", "198.51.100.2", "198.51.100.3"]) {
      await h.app.inject({
        method: "POST",
        url: "/api/v1/oracle/submit",
        remoteAddress: ip,
        headers: { authorization: "Bearer wrong-key" },
        payload: body(PROVIDER_A.publicKey()),
      });
    }

    const spike = h.lines.find(
      (l) => l.msg === "oracle auth failure spike: distributed_guessing",
    );
    expect(spike).toBeDefined();
    expect(spike!.level).toBe("critical");
    expect(spike!.distinctSources).toBe(3);
  });
});
