import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      exclude: ["src/cli.ts", "src/main.ts", "extension/src/service-worker.ts", "test/**"],
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      thresholds: {
        branches: 80,
        functions: 85,
        lines: 85,
        statements: 85,
      },
    },
    environment: "node",
    include: ["test/**/*.test.ts"],
    restoreMocks: true,
  },
});
