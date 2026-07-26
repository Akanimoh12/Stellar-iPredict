import { describe, it, expect } from "vitest";
import { RATE_LIMITS } from "./rateLimits.js";

describe("RATE_LIMITS configuration", () => {
  it("defines the expected routes and limits matching the design doc", () => {
    expect(RATE_LIMITS["GET /api/markets"]).toEqual({ requests: 60, window: 60 });
    expect(RATE_LIMITS["GET /api/markets/:id"]).toEqual({ requests: 120, window: 60 });
    expect(RATE_LIMITS["POST /api/oracle/*"]).toEqual({ requests: 10, window: 60 });
    expect(RATE_LIMITS.default).toEqual({ requests: 30, window: 60 });
  });
});
