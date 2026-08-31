import { describe, expect, it, vi, beforeEach } from "vitest";
import type { DecodedEvent, HandlerContext } from "../types.js";
import {
  decodeTokenMint,
  decodeTokenTransfer,
  handleTokenMint,
  handleTokenTransfer,
  TOKEN_MINT_TOPIC,
  TOKEN_TRANSFER_TOPIC,
} from "../token.js";

describe("decodeTokenMint", () => {
  it("decodes valid token mint payload", () => {
    const event: DecodedEvent = {
      topics: [TOKEN_MINT_TOPIC],
      data: {
        to: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        amount: "1000.5000000",
      },
      ledger: 12345,
      txHash: "abc123",
      eventIndex: 0,
    };

    const result = decodeTokenMint(event);
    expect(result).toEqual({
      to: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      amount: "1000.5000000",
    });
  });

  it("accepts 'user' field as alias for 'to'", () => {
    const event: DecodedEvent = {
      topics: [TOKEN_MINT_TOPIC],
      data: {
        user: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        amount: 500,
      },
      ledger: 12345,
      txHash: "abc123",
      eventIndex: 0,
    };

    const result = decodeTokenMint(event);
    expect(result.to).toBe("GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB");
    expect(result.amount).toBe("500");
  });

  it("normalizes bigint amount to string", () => {
    const event: DecodedEvent = {
      topics: [TOKEN_MINT_TOPIC],
      data: {
        to: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        amount: BigInt("9007199254740991"),
      },
      ledger: 12345,
      txHash: "abc123",
      eventIndex: 0,
    };

    const result = decodeTokenMint(event);
    expect(result.amount).toBe("9007199254740991");
  });

  it("throws on invalid recipient address", () => {
    const event: DecodedEvent = {
      topics: [TOKEN_MINT_TOPIC],
      data: { to: "invalid", amount: "100" },
      ledger: 12345,
      txHash: "abc123",
      eventIndex: 0,
    };

    expect(() => decodeTokenMint(event)).toThrow("must be a valid Stellar public key");
  });

  it("throws on negative amount", () => {
    const event: DecodedEvent = {
      topics: [TOKEN_MINT_TOPIC],
      data: {
        to: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        amount: "-100",
      },
      ledger: 12345,
      txHash: "abc123",
      eventIndex: 0,
    };

    expect(() => decodeTokenMint(event)).toThrow("must be a non-negative numeric value");
  });

  it("throws on non-object payload", () => {
    const event: DecodedEvent = {
      topics: [TOKEN_MINT_TOPIC],
      data: "not an object",
      ledger: 12345,
      txHash: "abc123",
      eventIndex: 0,
    };

    expect(() => decodeTokenMint(event)).toThrow("payload must be an object");
  });
});

describe("decodeTokenTransfer", () => {
  it("decodes valid token transfer payload", () => {
    const event: DecodedEvent = {
      topics: [TOKEN_TRANSFER_TOPIC],
      data: {
        from: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        to: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        amount: "250.0000000",
      },
      ledger: 12345,
      txHash: "abc123",
      eventIndex: 0,
    };

    const result = decodeTokenTransfer(event);
    expect(result).toEqual({
      from: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      to: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      amount: "250.0000000",
    });
  });

  it("normalizes numeric amount to string", () => {
    const event: DecodedEvent = {
      topics: [TOKEN_TRANSFER_TOPIC],
      data: {
        from: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        to: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        amount: 123.456,
      },
      ledger: 12345,
      txHash: "abc123",
      eventIndex: 0,
    };

    const result = decodeTokenTransfer(event);
    expect(result.amount).toBe("123.456");
  });

  it("throws on invalid sender address", () => {
    const event: DecodedEvent = {
      topics: [TOKEN_TRANSFER_TOPIC],
      data: {
        from: "invalid",
        to: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        amount: "100",
      },
      ledger: 12345,
      txHash: "abc123",
      eventIndex: 0,
    };

    expect(() => decodeTokenTransfer(event)).toThrow("sender must be a valid Stellar public key");
  });

  it("throws on invalid recipient address", () => {
    const event: DecodedEvent = {
      topics: [TOKEN_TRANSFER_TOPIC],
      data: {
        from: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        to: "invalid",
        amount: "100",
      },
      ledger: 12345,
      txHash: "abc123",
      eventIndex: 0,
    };

    expect(() => decodeTokenTransfer(event)).toThrow("recipient must be a valid Stellar public key");
  });
});

describe("handleTokenMint", () => {
  let mockDb: HandlerContext["db"];
  let mockRedis: HandlerContext["redis"];
  let mockLogger: HandlerContext["logger"];
  let context: HandlerContext;

  beforeEach(() => {
    mockDb = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("SELECT")) {
          return { rows: [{ exists: false }] };
        }
        return { rows: [] };
      }),
    } as any;

    mockRedis = {
      del: vi.fn(async () => 1),
    } as any;

    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    context = {
      db: mockDb,
      redis: mockRedis,
      logger: mockLogger,
    };
  });

  it("inserts new token balance on first mint", async () => {
    const event: DecodedEvent = {
      topics: [TOKEN_MINT_TOPIC],
      data: {
        to: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        amount: "1000.0000000",
      },
      ledger: 12345,
      txHash: "abc123",
      eventIndex: 0,
    };

    await handleTokenMint(event, context);

    expect(mockDb.query).toHaveBeenCalled();
    const calls = vi.mocked(mockDb.query).mock.calls;
    const insertCall = calls.find((call) =>
      String(call[0]).includes("INSERT INTO token_balances"),
    );
    expect(insertCall).toBeDefined();
    expect(insertCall?.[1]).toEqual([
      "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "1000.0000000",
    ]);
  });

  it("invalidates relevant caches", async () => {
    const event: DecodedEvent = {
      topics: [TOKEN_MINT_TOPIC],
      data: {
        to: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        amount: "500",
      },
      ledger: 12345,
      txHash: "abc123",
      eventIndex: 0,
    };

    await handleTokenMint(event, context);

    expect(mockRedis?.del).toHaveBeenCalledWith(
      "token_balance:GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "stats:global",
      "leaderboard:top20",
    );
  });

  it("logs info message on successful mint", async () => {
    const event: DecodedEvent = {
      topics: [TOKEN_MINT_TOPIC],
      data: {
        to: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        amount: "750",
      },
      ledger: 12345,
      txHash: "abc123",
      eventIndex: 0,
    };

    await handleTokenMint(event, context);

    expect(mockLogger.info).toHaveBeenCalledWith("Token mint processed", {
      to: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      amount: "750",
      ledger: 12345,
      txHash: "abc123",
    });
  });
});

describe("handleTokenTransfer", () => {
  let mockDb: HandlerContext["db"];
  let mockRedis: HandlerContext["redis"];
  let mockLogger: HandlerContext["logger"];
  let context: HandlerContext;

  beforeEach(() => {
    mockDb = {
      query: vi.fn(async (sql: string) => {
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
          return { rows: [] };
        }
        if (sql.includes("SELECT balance FROM token_balances")) {
          return { rows: [{ balance: "100.0000000" }] };
        }
        if (sql.includes("SELECT")) {
          return { rows: [{ exists: false }] };
        }
        return { rows: [] };
      }),
    } as any;

    mockRedis = {
      del: vi.fn(async () => 2),
    } as any;

    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    context = {
      db: mockDb,
      redis: mockRedis,
      logger: mockLogger,
    };
  });

  it("uses transaction for atomic debit/credit", async () => {
    const event: DecodedEvent = {
      topics: [TOKEN_TRANSFER_TOPIC],
      data: {
        from: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        to: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        amount: "250",
      },
      ledger: 12345,
      txHash: "abc123",
      eventIndex: 0,
    };

    await handleTokenTransfer(event, context);

    const calls = vi.mocked(mockDb.query).mock.calls.map((c) => c[0]);
    expect(calls).toContain("BEGIN");
    expect(calls).toContain("COMMIT");
  });

  it("debits sender and credits recipient", async () => {
    const event: DecodedEvent = {
      topics: [TOKEN_TRANSFER_TOPIC],
      data: {
        from: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        to: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        amount: "150",
      },
      ledger: 12345,
      txHash: "abc123",
      eventIndex: 0,
    };

    await handleTokenTransfer(event, context);

    const calls = vi.mocked(mockDb.query).mock.calls;
    const debitCall = calls.find(
      (call) =>
        String(call[0]).includes("INSERT INTO token_balances") &&
        String(call[0]).includes("balance - $2"),
    );
    const creditCall = calls.find(
      (call) =>
        String(call[0]).includes("INSERT INTO token_balances") &&
        String(call[0]).includes("balance + EXCLUDED.balance"),
    );

    expect(debitCall).toBeDefined();
    expect(creditCall).toBeDefined();
    expect(debitCall?.[1]).toEqual([
      "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "150",
    ]);
    expect(creditCall?.[1]).toEqual([
      "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      "150",
    ]);
  });

  it("invalidates both sender and recipient caches", async () => {
    const event: DecodedEvent = {
      topics: [TOKEN_TRANSFER_TOPIC],
      data: {
        from: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        to: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        amount: "200",
      },
      ledger: 12345,
      txHash: "abc123",
      eventIndex: 0,
    };

    await handleTokenTransfer(event, context);

    expect(mockRedis?.del).toHaveBeenCalledWith(
      "token_balance:GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "token_balance:GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      "stats:global",
      "leaderboard:top20",
    );
  });

  it("warns if sender balance goes negative", async () => {
    mockDb = {
      query: vi.fn(async (sql: string) => {
        if (sql === "BEGIN" || sql === "COMMIT") {
          return { rows: [] };
        }
        if (sql.includes("SELECT balance FROM token_balances")) {
          return { rows: [{ balance: "-50.0000000" }] };
        }
        if (sql.includes("SELECT")) {
          return { rows: [{ exists: false }] };
        }
        return { rows: [] };
      }),
    } as any;

    context.db = mockDb;

    const event: DecodedEvent = {
      topics: [TOKEN_TRANSFER_TOPIC],
      data: {
        from: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        to: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        amount: "300",
      },
      ledger: 12345,
      txHash: "abc123",
      eventIndex: 0,
    };

    await handleTokenTransfer(event, context);

    expect(mockLogger.warn).toHaveBeenCalledWith(
      "Token transfer resulted in negative sender balance",
      expect.objectContaining({
        from: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        senderBalance: "-50.0000000",
      }),
    );
  });

  it("rolls back transaction on error", async () => {
    mockDb = {
      query: vi.fn(async (sql: string) => {
        if (sql === "BEGIN") return { rows: [] };
        if (sql === "ROLLBACK") return { rows: [] };
        if (sql.includes("SELECT")) return { rows: [{ exists: false }] };
        throw new Error("Database error");
      }),
    } as any;

    context.db = mockDb;

    const event: DecodedEvent = {
      topics: [TOKEN_TRANSFER_TOPIC],
      data: {
        from: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        to: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        amount: "100",
      },
      ledger: 12345,
      txHash: "abc123",
      eventIndex: 0,
    };

    await expect(handleTokenTransfer(event, context)).rejects.toThrow("Database error");

    const calls = vi.mocked(mockDb.query).mock.calls.map((c) => c[0]);
    expect(calls).toContain("ROLLBACK");
  });
});
