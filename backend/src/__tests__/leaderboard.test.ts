import { describe, it, expect, beforeEach } from "vitest";
import {
  upsertLeaderboardEntry,
  getLeaderboardEntry,
  clearLeaderboard,
} from "@/db/leaderboard";

describe("upsertLeaderboardEntry", () => {
  beforeEach(() => {
    clearLeaderboard();
  });

  it("creates a new entry on first upsert", () => {
    const result = upsertLeaderboardEntry("GALICE", 100, "won");

    expect(result.success).toBe(true);
    expect(result.hash).toBeDefined();

    const entry = getLeaderboardEntry("GALICE");
    expect(entry).toEqual({
      address: "GALICE",
      points: 100,
      won: 1,
      lost: 0,
    });
  });

  it("accumulates points and wins across multiple upserts", () => {
    upsertLeaderboardEntry("GBOB", 50, "won");
    upsertLeaderboardEntry("GBOB", 30, "won");

    const entry = getLeaderboardEntry("GBOB");
    expect(entry).toEqual({
      address: "GBOB",
      points: 80,
      won: 2,
      lost: 0,
    });
  });

  it("increments lost counter on loss outcome", () => {
    upsertLeaderboardEntry("GCAROL", 20, "lost");

    const entry = getLeaderboardEntry("GCAROL");
    expect(entry).toEqual({
      address: "GCAROL",
      points: 20,
      won: 0,
      lost: 1,
    });
  });

  it("handles mixed won and lost outcomes", () => {
    upsertLeaderboardEntry("GDAVE", 10, "won");
    upsertLeaderboardEntry("GDAVE", 5, "lost");
    upsertLeaderboardEntry("GDAVE", 15, "won");

    const entry = getLeaderboardEntry("GDAVE");
    expect(entry).toEqual({
      address: "GDAVE",
      points: 30,
      won: 2,
      lost: 1,
    });
  });

  it("returns error for empty address", () => {
    const result = upsertLeaderboardEntry("", 10, "won");
    expect(result.success).toBe(false);
    expect(result.error).toBe("address is required");
  });

  it("returns error for whitespace-only address", () => {
    const result = upsertLeaderboardEntry("   ", 10, "won");
    expect(result.success).toBe(false);
    expect(result.error).toBe("address is required");
  });

  it("returns error for negative pointsDelta", () => {
    const result = upsertLeaderboardEntry("GALICE", -5, "won");
    expect(result.success).toBe(false);
    expect(result.error).toBe("pointsDelta must be a non-negative number");
  });

  it("accepts zero pointsDelta", () => {
    const result = upsertLeaderboardEntry("GALICE", 0, "lost");
    expect(result.success).toBe(true);

    const entry = getLeaderboardEntry("GALICE");
    expect(entry!.points).toBe(0);
    expect(entry!.lost).toBe(1);
  });
});
