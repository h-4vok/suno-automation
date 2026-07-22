---
name: interviewer
description: Interview, refine, create, and update GitHub issues into implementation-ready Codex contracts for this repository. Use when a user asks to clarify, triage, prepare, promote, label, or make a GitHub issue codex-ready; supports a lightweight PM plus tech-lead interview and may apply the `codex-ready` label once every readiness gate passes.
---

# Interviewer

Turn a request or existing issue into a small, auditable, decision-complete Markdown implementation contract. Be a concise PM and tech lead in one conversation; do not invent product decisions. The contract is written for the implementing Codex agent, not parsed as a business schema by the executor.

## Repository guardrails

1. Read `AGENTS.md` first. Read `docs/architecture.md`, `docs/testing.md`, and `SECURITY.md` before refining work involving workflow, browser, persistence, authentication, or tests.
2. Preserve the local-first, fail-closed model. Never include secrets, cookies, tokens, session data, or live-account details in an issue.
3. Treat live Suno actions as out of scope unless the user explicitly requests a current-task test. Keep default behavior `observe`; require both server `live` mode and extension `allowLiveSubmissions=true` for any submission.
4. Keep Gemini/Suno control text English and outputs instrumental where relevant.

## Intake and interview

Start from the issue URL/number when provided; otherwise offer to create a new issue. Read the existing issue, labels, linked issues, and relevant repository context before asking questions.

Ask only the smallest unanswered question needed to remove a material ambiguity. Prefer one question per turn. Cover these dimensions, in this order when applicable:

1. User/problem and desired observable outcome.
2. Scope boundaries: what changes, what explicitly does not, and which interfaces/configuration/docs are affected.
3. Safety, security, data, browser/live-action, and backward-compatibility constraints.
4. Acceptance criteria and failure behavior; phrase concrete behaviors as Given/When/Then where useful.
5. Implementation boundaries, dependencies, migration/rollout, observability, and idempotency/retry concerns.
6. Verification: focused regression tests, full gate (`pnpm check && pnpm build`), config validation, and whether mutation testing is required or has a stated exception.

If the user asks to move quickly, state assumptions in an **Open decisions** section rather than silently deciding. Do not block for cosmetic details.

## Issue contract

Write or update the issue body in this compact Markdown form; omit only sections that truly do not apply. Do not add a YAML contract, issue-form schema, or machine-readable business-plan wrapper.

```markdown
## Problem

## Outcome

## Scope

- In:
- Out:

## Constraints and safety

## Acceptance criteria

- [ ] Given … when … then …

## Implementation notes

Describe the chosen approach, affected interfaces, failure behavior, compatibility constraints, and any implementation boundary needed to avoid a new product or architecture decision during delivery.

## Verification

- [ ] Regression/outcome tests cover …
- [ ] `pnpm check && pnpm build`
- [ ] `pnpm validate:config` (if configuration changes)
- [ ] `pnpm test:mutation` (if high-risk domain logic changes), or documented exception

## Dependencies / rollout

## Open decisions
```

For defects, include reproduction, expected versus actual behavior, and the regression proof required. For changes that edit tests, explicitly require `$adversarial-test-review`. Use outcome assertions, semantic browser fallbacks, schema validation at boundaries, and injected nondeterminism/interfaces when those repository rules apply.

## Readiness and promotion

After each substantive update, evaluate the contract. Applying `codex-ready` declares that the Markdown contract is ready for implementation; the local executor does not independently judge or parse its semantic quality. Apply `codex-ready` automatically only if all are true:

- Outcome, in/out scope, acceptance criteria, and verification are actionable.
- Relevant safety/security/default-mode constraints are explicit.
- Dependencies are linked/resolved, or the issue states there are none.
- No material unanswered decision remains; `Open decisions` is empty or contains only non-blocking implementation discretion.
- The work is small enough to implement or has a clear, independently deliverable first slice.
- The issue contains no secrets or instructions to access a live Suno account without explicit current-task authorization.

Treat referenced issue dependencies as resolved only when every blocking issue is closed. `manual-validation` describes verification that a human must perform; it does not by itself make implementation ineligible. Epics, blank contracts, material open decisions, unresolved dependencies, and unverifiable acceptance criteria remain ineligible.

If any gate fails, do not apply the label. State the shortest remaining question or blocked dependency. Never claim that `codex-ready` runs CI, dispatches GitHub Actions, or otherwise triggers automation; in this repository it is issue metadata only.

Create the label if it is missing and the user has authorized issue updates. When updating an existing issue, preserve useful discussion/history and replace only stale or ambiguous contract content. Report the exact issue URL, changes made, readiness result, label action, and remaining blockers.
