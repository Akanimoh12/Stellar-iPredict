import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    // Integration tests boot a Postgres container via testcontainers, so they
    // need a local Docker daemon. Keep the default `npm test` deterministic by
    // running them explicitly through `npm run test:integration`.
    exclude: ["src/__tests__/integration/**", "node_modules/**", "dist/**"],
    projects: [
      {
        test: {
          name: "unit",
          include: ["src/__tests__/*.test.ts"],
        },
      },
      {
        test: {
          name: "handlers",
          include: ["test/*.test.ts"],
          testTimeout: 60_000,
          hookTimeout: 60_000,
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