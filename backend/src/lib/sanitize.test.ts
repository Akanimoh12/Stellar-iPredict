import { describe, expect, it, vi } from "vitest";
import {
  auditStoredContent,
  sanitizeForHtmlOutput,
  sanitizeImageUrl,
  sanitizeMarketQuestion,
} from "./sanitize.js";

describe("market text sanitization", () => {
  it("strips markup and enforces the market-question length limit", () => {
    const result = sanitizeMarketQuestion(
      `<script>alert(1)</script>${"x".repeat(600)}`,
    );

    expect(result).toHaveLength(500);
    expect(result).toMatch(/^alert\(1\)/);
    expect(result).not.toMatch(/[<>]/);
  });

  it("rejects unsafe image URL schemes", () => {
    expect(sanitizeImageUrl("javascript:alert(1)")).toBeNull();
    expect(sanitizeImageUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(sanitizeImageUrl("https://images.example/market.png")).toBe(
      "https://images.example/market.png",
    );
  });

  it("escapes legacy markup when returning stored text", () => {
    expect(sanitizeForHtmlOutput("<script>alert(1)</script>")).toBe(
      "&lt;script&gt;alert(1)&lt;&#x2F;script&gt;",
    );
  });

  it("reports existing unsafe market content during an audit", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: 1, question: "<b>Question</b>" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 2, image_url: "javascript:alert(1)" }] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(auditStoredContent({ query })).resolves.toMatchObject([
      { table: "markets", column: "question", id: 1 },
      { table: "markets", column: "image_url", id: 2 },
    ]);
    expect(query).toHaveBeenCalledTimes(4);
  });
});
