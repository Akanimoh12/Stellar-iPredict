import { describe, expect, it } from "vitest";
import type { MarketTally } from "../src/aggregator/tally.js";
import {
  assertCanFinalize,
  createBalancedValidationConfig,
  createDefaultValidationConfig,
  createStrictValidationConfig,
  validateSubmissionData,
  type SubmissionValidationConfig,
} from "../src/aggregator/submission-validator.js";

describe("submission validation", () => {
  const makeTally = (yesVotes: number, noVotes: number): MarketTally => ({
    marketId: "42",
    yesVotes,
    noVotes,
    totalVoters: yesVotes + noVotes,
    votes: [
      ...Array.from({ length: yesVotes }, (_, i) => ({ member: `member-yes-${i}`, outcome: true })),
      ...Array.from({ length: noVotes }, (_, i) => ({ member: `member-no-${i}`, outcome: false })),
    ],
  });

  describe("validateSubmissionData", () => {
    it("passes when minimum submissions are met", () => {
      const tally = makeTally(3, 1); // 4 total
      const config: SubmissionValidationConfig = {
        minRequiredSubmissions: 3,
        enforceThreshold: false,
        threshold: 4,
      };
      const result = validateSubmissionData(tally, config);
      expect(result.isValid).toBe(true);
      expect(result.submissionCount).toBe(4);
      expect(result.requiredSubmissions).toBe(3);
    });

    it("fails when submissions are below minimum", () => {
      const tally = makeTally(1, 1); // 2 total
      const config: SubmissionValidationConfig = {
        minRequiredSubmissions: 4,
        enforceThreshold: false,
        threshold: 4,
      };
      const result = validateSubmissionData(tally, config);
      expect(result.isValid).toBe(false);
      expect(result.reason).toContain("Insufficient submissions: 2/4 required");
    });

    it("passes when threshold is reached (yes)", () => {
      const tally = makeTally(4, 2); // 4 yes, 2 no
      const config: SubmissionValidationConfig = {
        minRequiredSubmissions: 1,
        enforceThreshold: true,
        threshold: 4,
      };
      const result = validateSubmissionData(tally, config);
      expect(result.isValid).toBe(true);
    });

    it("passes when threshold is reached (no)", () => {
      const tally = makeTally(2, 5); // 2 yes, 5 no
      const config: SubmissionValidationConfig = {
        minRequiredSubmissions: 1,
        enforceThreshold: true,
        threshold: 4,
      };
      const result = validateSubmissionData(tally, config);
      expect(result.isValid).toBe(true);
    });

    it("fails when neither outcome reaches threshold", () => {
      const tally = makeTally(3, 3); // 3 yes, 3 no
      const config: SubmissionValidationConfig = {
        minRequiredSubmissions: 1,
        enforceThreshold: true,
        threshold: 4,
      };
      const result = validateSubmissionData(tally, config);
      expect(result.isValid).toBe(false);
      expect(result.reason).toContain("No outcome reached threshold");
    });

    it("fails when both outcomes reach threshold (ambiguous)", () => {
      const tally = makeTally(4, 4); // 4 yes, 4 no
      const config: SubmissionValidationConfig = {
        minRequiredSubmissions: 1,
        enforceThreshold: true,
        threshold: 4,
      };
      const result = validateSubmissionData(tally, config);
      expect(result.isValid).toBe(false);
      expect(result.reason).toContain("Ambiguous: both outcomes reached threshold");
    });

    it("passes when threshold enforcement is disabled", () => {
      const tally = makeTally(1, 1); // 2 total, no threshold reached
      const config: SubmissionValidationConfig = {
        minRequiredSubmissions: 2,
        enforceThreshold: false,
        threshold: 4,
      };
      const result = validateSubmissionData(tally, config);
      expect(result.isValid).toBe(true);
    });

    it("enforces both minimum submissions and threshold", () => {
      const tally = makeTally(2, 1); // 3 total, no threshold reached
      const config: SubmissionValidationConfig = {
        minRequiredSubmissions: 4,
        enforceThreshold: true,
        threshold: 4,
      };
      const result = validateSubmissionData(tally, config);
      expect(result.isValid).toBe(false);
      expect(result.reason).toContain("Insufficient submissions");
    });

    it("validates zero submissions", () => {
      const tally = makeTally(0, 0);
      const config: SubmissionValidationConfig = {
        minRequiredSubmissions: 1,
        enforceThreshold: true,
        threshold: 4,
      };
      const result = validateSubmissionData(tally, config);
      expect(result.isValid).toBe(false);
      expect(result.reason).toContain("Insufficient submissions: 0/1 required");
    });

    it("handles single submission meeting threshold", () => {
      const tally = makeTally(1, 0);
      const config: SubmissionValidationConfig = {
        minRequiredSubmissions: 1,
        enforceThreshold: true,
        threshold: 1,
      };
      const result = validateSubmissionData(tally, config);
      expect(result.isValid).toBe(true);
    });
  });

  describe("assertCanFinalize", () => {
    it("does not throw when validation passes", () => {
      const tally = makeTally(4, 2);
      const config: SubmissionValidationConfig = {
        minRequiredSubmissions: 3,
        enforceThreshold: true,
        threshold: 4,
      };
      expect(() => assertCanFinalize("market-123", tally, config)).not.toThrow();
    });

    it("throws with descriptive error when validation fails", () => {
      const tally = makeTally(2, 1); // 3 total
      const config: SubmissionValidationConfig = {
        minRequiredSubmissions: 5,
        enforceThreshold: true,
        threshold: 4,
      };
      expect(() => assertCanFinalize("market-123", tally, config)).toThrow(
        "Market market-123 cannot be finalized: Insufficient submissions: 3/5 required",
      );
    });

    it("throws when threshold not reached", () => {
      const tally = makeTally(3, 3);
      const config: SubmissionValidationConfig = {
        minRequiredSubmissions: 1,
        enforceThreshold: true,
        threshold: 4,
      };
      expect(() => assertCanFinalize("market-456", tally, config)).toThrow(
        "Market market-456 cannot be finalized: No outcome reached threshold",
      );
    });
  });

  describe("config factory functions", () => {
    describe("createDefaultValidationConfig", () => {
      it("creates config with minimum 1 submission and threshold enforcement", () => {
        const config = createDefaultValidationConfig(4);
        expect(config.minRequiredSubmissions).toBe(1);
        expect(config.enforceThreshold).toBe(true);
        expect(config.threshold).toBe(4);
      });
    });

    describe("createStrictValidationConfig", () => {
      it("creates config requiring all council members", () => {
        const config = createStrictValidationConfig(7, 4);
        expect(config.minRequiredSubmissions).toBe(7);
        expect(config.enforceThreshold).toBe(true);
        expect(config.threshold).toBe(4);
      });
    });

    describe("createBalancedValidationConfig", () => {
      it("creates config requiring threshold submissions", () => {
        const config = createBalancedValidationConfig(4);
        expect(config.minRequiredSubmissions).toBe(4);
        expect(config.enforceThreshold).toBe(true);
        expect(config.threshold).toBe(4);
      });
    });
  });

  describe("realistic scenarios", () => {
    it("prevents finalization with only 1 submission in 4-of-7 council", () => {
      const tally = makeTally(1, 0); // Only 1 member submitted
      const config = createBalancedValidationConfig(4);
      const result = validateSubmissionData(tally, config);
      expect(result.isValid).toBe(false);
      expect(result.reason).toContain("Insufficient submissions: 1/4 required");
    });

    it("allows finalization when threshold is reached with minimum submissions", () => {
      const tally = makeTally(4, 0); // 4 members agreed on yes
      const config = createBalancedValidationConfig(4);
      const result = validateSubmissionData(tally, config);
      expect(result.isValid).toBe(true);
    });

    it("requires all members in strict mode", () => {
      const tally = makeTally(5, 1); // 6 out of 7 submitted
      const config = createStrictValidationConfig(7, 4);
      const result = validateSubmissionData(tally, config);
      expect(result.isValid).toBe(false);
      expect(result.reason).toContain("Insufficient submissions: 6/7 required");
    });

    it("allows finalization in strict mode when all members submit", () => {
      const tally = makeTally(5, 2); // All 7 members submitted, 5 agree on yes
      const config = createStrictValidationConfig(7, 4);
      const result = validateSubmissionData(tally, config);
      expect(result.isValid).toBe(true);
    });

    it("prevents double finalization by catching zero submissions", () => {
      const tally = makeTally(0, 0); // Already finalized, submissions cleared
      const config = createDefaultValidationConfig(4);
      const result = validateSubmissionData(tally, config);
      expect(result.isValid).toBe(false);
    });
  });
});
