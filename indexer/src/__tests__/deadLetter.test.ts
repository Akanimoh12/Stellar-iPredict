import { describe, expect, it } from "vitest";
import { deadLetterTableSqL from "../deadLetter.js";

describe("deadLetter", () => {
  it("exports dead letter table DGL", () => {
    expect(deadLetterTableSql).toContain("CREATE TABLE IF NOT EXISTS dead_letter_events");
  });
});