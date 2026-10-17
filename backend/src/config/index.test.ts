import { describe, it, expect } from "vitest";
import { envSchema } from "./index.js";

describe("envSchema configuration validation", () => {
  const validBaseEnv = {
    DATABASE_URL: "postgres://localhost:5432/ipredict_test",
    ORACLE_API_KEY: "secret-key-123",
  };

  it("passes when all required variables including ORACLE_API_KEY are present", () => {
    const result = envSchema.safeParse(validBaseEnv);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ORACLE_API_KEY).toBe("secret-key-123");
      expect(result.data.PORT).toBe(4000);
      expect(result.data.DB_POOL_SIZE).toBe(10);
    }
  });

  it("fails fast when ORACLE_API_KEY is missing", () => {
    const env = {
      DATABASE_URL: "postgres://localhost:5432/ipredict_test",
    };
    const result = envSchema.safeParse(env);
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.includes("ORACLE_API_KEY"));
      expect(issue).toBeDefined();
      expect(issue?.message).toBe("ORACLE_API_KEY is required");
    }
  });

  it("fails fast when ORACLE_API_KEY is an empty string", () => {
    const env = {
      DATABASE_URL: "postgres://localhost:5432/ipredict_test",
      ORACLE_API_KEY: "",
    };
    const result = envSchema.safeParse(env);
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.includes("ORACLE_API_KEY"));
      expect(issue).toBeDefined();
      expect(issue?.message).toBe("ORACLE_API_KEY is required");
    }
  });

  it("fails fast when DATABASE_URL is missing", () => {
    const env = {
      ORACLE_API_KEY: "secret-key-123",
    };
    const result = envSchema.safeParse(env);
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.includes("DATABASE_URL"));
      expect(issue).toBeDefined();
    }
  });
});
