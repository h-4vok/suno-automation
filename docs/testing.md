# Testing strategy

## Pyramid

- Unit: weighted intervals, probability boundary, prompt rules, config invariants, auth.
- Component: coordinator with injected clock/random/AI/store; extension adapter in a simulated DOM.
- Integration: authenticated Fastify requests, command leasing/idempotency, atomic file persistence.
- Manual acceptance: real Brave/Suno only through observe → draft → one-generation live promotion.

`pnpm test` enforces global thresholds of 85% statements/lines/functions and 80% branches. Coverage is a floor, not proof.

## Adversarial evidence

When tests change, invoke `$adversarial-test-review`. Reviewer must map each changed test to a failure mode and identify the smallest plausible production defect that makes it fail. Tests that only restate mocks, inspect implementation details, or pass before the fix are weak.

For weighted planning changes, `pnpm test:mutation` is the mechanical backstop. CI runs mutation testing when those high-risk files change and on manual request. Surviving mutants require a test improvement or an explicit explanation of equivalent/unreachable behavior.

## Regression protocol

1. Reproduce defect with a focused failing test.
2. Confirm failure message points at behavior, not incidental implementation.
3. Implement smallest fix.
4. Run focused test, then `pnpm check && pnpm build`.
5. Run adversarial review; resolve high-confidence gaps before merge.
