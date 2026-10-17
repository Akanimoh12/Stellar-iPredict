import { describe, it, expect, vi, beforeEach } from "vitest";
import { getCheckpoint, saveCheckpoint } from "./checkpoint.js";
import { query } from "./pool.js";

vi.mock("./pool.js", () => ({
  query: vi.fn(),
}));

describe("getCheckpoint", () => {
  beforeEach(() => {
    vi.mocked(query).mockReset();
  });

  it("returns the stored ledger sequence on the happy path", async () => {
    vi.mocked(query).mockResolvedValue({
      rows: [{ id: 0, last_ledger_seq: 12345, updated_at: new Date() }],
      rowCount: 1,
    } as never);

    const result = await getCheckpoint();

    expect(result).toEqual({ lastLedgerSeq: 12345 });
    expect(query).toHaveBeenCalledWith(
      "SELECT id, last_ledger_seq, updated_at FROM checkpoints WHERE id = $1",
      [0],
    );
  });

  it("returns null when no checkpoint row exists yet", async () => {
    vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 0 } as never);

    const result = await getCheckpoint();

    expect(result).toEqual({ lastLedgerSeq: null });
  });
});

describe("saveCheckpoint", () => {
  beforeEach(() => {
    vi.mocked(query).mockReset();
  });

  it("upserts the ledger sequence using parameterized values", async () => {
    vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 1 } as never);

    await saveCheckpoint(54321);

    expect(query).toHaveBeenCalledTimes(1);
    const [text, params] = vi.mocked(query).mock.calls[0];
    expect(text).toContain("INSERT INTO checkpoints");
    expect(text).toContain("ON CONFLICT (id) DO UPDATE");
    expect(params).toEqual([0, 54321]);
  });
});
