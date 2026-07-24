# Testing strategy

## Pyramid

- Unit: weighted intervals, probability boundary, prompt rules, config invariants, auth.
- Component: coordinator with injected clock/random/AI/store; extension adapter in a simulated DOM.
- Integration: authenticated Fastify requests, command leasing/idempotency, atomic file persistence.
- Loop domain: dual-slot allocation, lifecycle sagas, retries, leases, rework, redaction, health,
  and reconciliation with injected GitHub/Git/clock/state ports.
- Manual acceptance: real Brave/Suno only through observe → draft → one-generation live promotion.

`pnpm test` enforces global thresholds of 85% statements/lines/functions and 80% branches. Coverage is a floor, not proof.

## Adversarial evidence

When tests change, invoke `$adversarial-test-review`. Reviewer must map each changed test to a failure mode and identify the smallest plausible production defect that makes it fail. Tests that only restate mocks, inspect implementation details, or pass before the fix are weak.

For weighted planning changes, `pnpm test:mutation` is the mechanical backstop. CI runs mutation testing when those high-risk files change and on manual request. Surviving mutants require a test improvement or an explicit explanation of equivalent/unreachable behavior.

The same mutation command covers `src/loop/domain.ts`, `src/loop/policy.ts`, and
`src/loop/verification.ts`. This is a deliberate bounded map rather than a mutation run over the
effectful adapters: `domain.ts` owns deterministic selection, claim/resume, lifecycle transition,
release/finalization, deduplication, and retention; `policy.ts` owns capability, lease recovery,
publication, rework, and reconciliation decisions; `verification.ts` owns gate routing, diff
safety, and verdict signing. Dispatcher, worker, recovery, and health tests exercise those rules
through their ports, but mutating their I/O orchestration creates an impractical CI gate without
adding a distinct decision surface. Loop changes are high risk when they affect selection, claims,
leases, lifecycle, recovery, retention, deduplication, verification routing, or publication
predicates.

The bounded five-file map has a blocking mutation floor of 70% and a 90% warning target. The lower
blocking floor is deliberate: it is calibrated to the initial 73.41% baseline of the newly covered
loop decision surface, rather than pretending that the narrower pre-loop 75% floor measured the
same thing. A surviving mutant still needs a focused test or a documented equivalent/unreachable
explanation before it is accepted.

## Codex loop verification gate

Every implementation and rework attempt records focused-test evidence, then binds these gates to
the exact commit:

1. `pnpm check`
2. `pnpm build`
3. `pnpm validate:config` when config/schema paths changed
4. read-only `$adversarial-test-review` when tests changed
5. `pnpm test:mutation` when the versioned high-risk path map matches
6. a diff guard for secret-like values, live-Suno enablement, force push, and destructive Git flow

Non-applicable gates are explicit in the signed local verdict. A mandatory command failure,
malformed/missing adversarial report, high-confidence P0/P1 finding, secret/live-action finding, or
material mutation failure blocks push. Two repair passes are allowed before attention.

## Regression protocol

1. Reproduce defect with a focused failing test.
2. Confirm failure message points at behavior, not incidental implementation.
3. Implement smallest fix.
4. Run focused test, then `pnpm check && pnpm build`.
5. Run adversarial review; resolve high-confidence gaps before merge.
