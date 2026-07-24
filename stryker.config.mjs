/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  checkers: ["typescript"],
  coverageAnalysis: "perTest",
  mutate: [
    "src/domain/weighted-selection.ts",
    "src/domain/generation-plan.ts",
    // The loop's externally-effectful services deliberately delegate their safety
    // decisions to these deterministic modules. Keeping the mutation map here
    // makes the PR gate bounded while still killing mutations in claim/release,
    // lease recovery, publication, rework, reconciliation, retention, and verdict
    // routing rules.
    "src/loop/domain.ts",
    "src/loop/policy.ts",
    "src/loop/verification.ts",
  ],
  plugins: ["@stryker-mutator/typescript-checker", "@stryker-mutator/vitest-runner"],
  reporters: ["clear-text", "html"],
  testRunner: "vitest",
  thresholds: { high: 90, low: 75, break: 75 },
};
