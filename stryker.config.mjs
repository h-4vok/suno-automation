/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  checkers: ["typescript"],
  coverageAnalysis: "perTest",
  mutate: ["src/domain/weighted-selection.ts", "src/domain/generation-plan.ts"],
  plugins: ["@stryker-mutator/typescript-checker", "@stryker-mutator/vitest-runner"],
  reporters: ["clear-text", "html"],
  testRunner: "vitest",
  thresholds: { high: 90, low: 75, break: 75 },
};
