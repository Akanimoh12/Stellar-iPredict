import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
    projects: [
      {
        test: {
          name: "unit",
          include: ["src/__tests__/*.test.ts"],
        },
      },
      {
        test: {
          name: "integration",
          include: ["src/__tests__/integration/*.test.ts"],
          testTimeout: 60_000,
          hookTimeout: 60_000,
          sequence: { concurrent: false },
        },
      },
    ],
  },
});
