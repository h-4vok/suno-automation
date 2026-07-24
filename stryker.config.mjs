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
  // The bounded loop map is intentionally broader than the original two
  // selection modules. Keep the CI gate below the observed baseline while
  // still failing a meaningful regression; the aspirational warning remains
  // at 90 so additional mutation tests are visible in every report.
  thresholds: { high: 90, low: 70, break: 70 },
};
