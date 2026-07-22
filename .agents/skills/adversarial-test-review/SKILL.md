---
name: adversarial-test-review
description: Review changed or newly written tests for false confidence, vanity assertions, missed failure modes, and mutation sensitivity. Use whenever this repository adds or edits tests, before merging test-heavy changes, when a regression test is claimed, or when asked to challenge coverage quality independently.
---

# Adversarial Test Review

Review as an independent critic. Do not edit unless explicitly asked.

## Workflow

1. Read `AGENTS.md`, `docs/testing.md`, acceptance criteria, and production diff.
2. Map each changed test to one observable requirement and one realistic failure mode.
3. Ask: “What smallest plausible production defect should make this test fail?” Verify assertion reaches that defect rather than a mock or copied implementation.
4. For claimed regressions, seek evidence test failed before fix. If unavailable, state uncertainty.
5. Run focused tests. Run `pnpm test:mutation` when weighted selection/planning changed or when assertion sensitivity remains doubtful.
6. Check boundaries, negative paths, retries, duplicate delivery, unsafe defaults, and accidental live Suno actions.
7. Classify each test: strong, weak, redundant, or missing. Coverage percentage never upgrades classification by itself.

## Reject these patterns

- Asserting a mock returns its configured value.
- Reimplementing production algorithm inside expected-value calculation.
- Snapshotting large output without semantic assertions.
- Testing private call order when public outcome matters.
- Regression test that passes on the known-bad revision.
- Happy path without closed failure for browser selectors, auth, quota state, or retries.
- “No throw” as sole proof of state transition or external action.

## Output

Lead with actionable findings ordered by severity. Include file/line, defect a weak test would miss, and a concrete strengthening. Then list commands run and unresolved proof gaps. Say “No actionable findings” when evidence supports it; do not invent findings to appear adversarial.
