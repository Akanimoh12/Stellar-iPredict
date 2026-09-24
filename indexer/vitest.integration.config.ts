import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 120_000,
    hookTimeout: 120_000,
    sequence: { concurrent: false },
    include: ["src/__tests__/integration/**/*.test.ts"],
  },
});