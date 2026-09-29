import { beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { Keypair } from "@stellar/stellar-sdk";
import { registerOracleRoutes, signOracleMessage } from "./oracle.js";
import { registerErrorHandler } from "../lib/errors.js";
import { REQUEST_ID_HEADER, genReqId, isValidRequestId } from "../lib/log.js";

// The oracle aggregator runs in another process and only sees this request
// through the oracle_submissions row it writes. Storing the request id on that
// row is what lets the aggregator's correlation id join back to it (#467).

const TEST_API_KEY = "test-oracle-secret-key-123";

describe("POST /api/oracle/submit stores the request id", () => {
  let app: FastifyInstance;
  let inserted: unknown[][];
  const provider = Keypair.random();

  const mockDb = {
    async query<T>(text: string, values?: unknown[]): Promise<{ rows: T[] }> {
      const sql = text.replace(/\s+/g, " ").trim();
      if (sql.includes("INSERT INTO oracle_submissions")) {
        inserted.push(values ?? []);
        const row = {
          id: inserted.length,
          market_id: String(values?.[0]),
          submitter: values?.[1],
          outcome: values?.[2],
          bond_amount: values?.[3],
          submitted_at: new Date(),
          status: "submitted",
        };
        return { rows: [row as unknown as T] };
      }
      if (sql.includes("SELECT COUNT(*)::text AS count FROM oracle_submissions")) {
        return { rows: [{ count: String(inserted.length) } as unknown as T] };
      }
      return { rows: [] };
    },
  };

  function submit(headers: Record<string, string> = {}) {
    const body = { marketId: 7, outcome: "YES", provider: provider.publicKey(), bondAmount: 100_0000000 };
    return app.inject({
      method: "POST",
      url: "/api/oracle/submit",
      headers: { authorization: `Bearer ${TEST_API_KEY}`, ...headers },
      payload: { ...body, signature: signOracleMessage(body, provider) },
    });
  }

  /** request_id is the last column of the insert. */
  const storedRequestId = () => inserted[0]?.[inserted[0].length - 1];

  beforeEach(() => {
    process.env.ORACLE_API_KEY = TEST_API_KEY;
    inserted = [];
    // The production server's id generator, so inbound ids are honoured the same way.
    app = Fastify({ genReqId });
    registerErrorHandler(app);
    registerOracleRoutes(app, mockDb);
  });

  it("stores the caller's x-request-id so the oracle can correlate to it", async () => {
    const res = await submit({ [REQUEST_ID_HEADER]: "3f2b8c1e-0000-4000-8000-000000000001" });

    expect(res.statusCode).toBe(200);
    expect(inserted).toHaveLength(1);
    expect(storedRequestId()).toBe("3f2b8c1e-0000-4000-8000-000000000001");
  });

  it("stores the generated id when the caller sent none", async () => {
    const res = await submit();

    expect(res.statusCode).toBe(200);
    expect(isValidRequestId(storedRequestId())).toBe(true);
  });

  it("never stores an inbound id the request id rule rejects", async () => {
    const res = await submit({ [REQUEST_ID_HEADER]: "not a safe id; drop table" });

    expect(res.statusCode).toBe(200);
    expect(storedRequestId()).not.toBe("not a safe id; drop table");
    expect(isValidRequestId(storedRequestId())).toBe(true);
  });
});
