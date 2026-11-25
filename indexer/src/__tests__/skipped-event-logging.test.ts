import { describe, expect, it, vi } from "vitest";
import { makeContractFilter } from "../contract-filter.js";
import { writeEventToDb } from "../event-router.js";

describe("structured debug logging for skipped events (#944)", () => {
  it("identifies the rejected contract without emitting logs for allowed IDs", () => {
    const debug = vi.fn();
    const filter = makeContractFilter(["C_ALLOWED"], { debug });
    expect(filter("C_ALLOWED")).toBe(true);
    expect(debug).not.toHaveBeenCalled();
    expect(filter("C_NOT_ALLOWED")).toBe(false);
    expect(debug).toHaveBeenCalledWith(
      "skipped event: contract not in configured allowlist",
      { reason: "unconfigured_contract", contractId: "C_NOT_ALLOWED" },
    );
  });

  it("logs router miss while preserving dead-letter behavior", async () => {
    const debug = vi.fn();
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    await writeEventToDb(
      { topics: ["unknown", "event"], data: {}, ledger: 10, txHash: "abc" },
      { query }, { del: vi.fn() }, { debug },
    );
    expect(debug).toHaveBeenCalledWith(
      "skipped event: unrecognized topic",
      expect.objectContaining({ reason: "unrecognized_topic", ledger: 10, txHash: "abc" }),
    );
    expect(query).toHaveBeenCalledWith(expect.stringContaining("dead_letter_events"), expect.any(Array));
  });

  it("logs validation failure before dead-lettering", async () => {
    const debug = vi.fn();
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    await writeEventToDb(
      { topics: ["bet_placed"], data: { amount: -2 }, ledger: 12, txHash: "xyz" },
      { query }, { del: vi.fn() }, { debug },
    );
    expect(debug).toHaveBeenCalledWith(
      "skipped event: payload validation failed",
      expect.objectContaining({ reason: "invalid_payload", route: "bet_placed" }),
    );
    expect(query).toHaveBeenCalledWith(expect.stringContaining("dead_letter_events"), expect.any(Array));
  });
});
