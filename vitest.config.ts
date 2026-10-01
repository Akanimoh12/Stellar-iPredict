export default {
  test: {
    include: ["test/**/*.test.ts", "oracle/test/**/*.test.ts", "oracle/src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      reportsDirectory: "coverage",

    },
  },
};

