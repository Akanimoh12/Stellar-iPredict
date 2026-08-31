import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
  },
});
