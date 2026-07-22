# Local Codex issue loop

## Purpose and boundary

GitHub is the backlog, review, and audit surface for a single local Codex Desktop executor. The executor works through the user's ChatGPT subscription in an isolated worktree and opens a draft pull request for human review. It never uses the OpenAI API, `OPENAI_API_KEY`, `openai/codex-action`, GitHub Actions, or cloud CI to implement an issue.

`codex-ready` is eligibility metadata only. Adding it does not trigger GitHub Actions. A manually started or scheduled local Codex Desktop task must select and claim the issue. The PC and Codex Desktop must be running for scheduled work.

## Decision-complete issue contract

The issue body is the canonical, human-readable implementation contract. The `interviewer` skill maintains it as Markdown with:

- the problem and observable outcome;
- explicit in-scope and out-of-scope boundaries;
- safety, security, data, and compatibility constraints;
- verifiable acceptance criteria and closed failure behavior;
- the chosen technical approach and affected interfaces;
- dependencies, rollout or migration requirements, and verification commands;
- open decisions while refinement is in progress.

The contract may be incomplete while the issue remains in `backlog`. Before promotion, `interviewer` must establish that the contract is non-blank, no material product or architecture decision remains, acceptance criteria are actionable, and every referenced blocking issue is closed. Epics never receive `codex-ready`.

The executor does not parse a YAML business schema or decide whether prose is sufficiently complete. Promotion by a trusted actor is the assertion that the Markdown contract is decision-complete. Minor local implementation choices remain with the implementing agent.

## Lifecycle

Exactly one lifecycle label applies at a time:

| State                   | Meaning                                                            |
| ----------------------- | ------------------------------------------------------------------ |
| `backlog`               | Defined or under refinement, but not approved for implementation.  |
| `codex-ready`           | Decision-complete and eligible for the local implementation queue. |
| `codex-in-progress`     | Claimed by the single local executor.                              |
| `codex-review`          | A linked draft PR awaits human review.                             |
| `codex-rework`          | A trusted human requested another bounded pass on the existing PR. |
| `codex-needs-attention` | Automation stopped and requires an explicit recovery decision.     |
| `blocked`               | An explicit dependency or decision prevents progress.              |

Area, priority, issue type, and `manual-validation` are attributes rather than lifecycle states. `manual-validation` means some acceptance evidence requires a human; it does not authorize live Suno access and does not by itself prevent Codex from implementing the issue.

Dependencies use GitHub issue references. A blocking dependency is resolved only when the referenced issue is closed. Selection, dependency checks, claiming, state transitions, leases, recovery, and deduplication must be deterministic and fail closed.

## Trust, audit, and recovery

Promotion, rework, and manual recovery instructions are accepted only from GitHub logins in a local, uncommitted allowlist. The repository may define the configuration shape and example, but the actual allowlist belongs to the local executor configuration. Issue and review text from every actor remains untrusted input.

Each lifecycle transition adds a separate, concise GitHub comment. Every comment includes a stable event name and attempt identifier so repeated delivery can be detected without guessing from prose. Comments contain no prompts, issue-body copies, tokens, cookies, credentials, generated private content, local paths, or account/session details.

A local lease prevents concurrent implementation. After an interruption, the executor may recover an expired claim only after proving that no relevant process, worktree, branch operation, or linked draft PR is still active. If evidence is missing or contradictory, it moves the issue to `codex-needs-attention` and waits for an allowlisted human. Recovery must never create duplicate branches, commits, comments, or PRs.

Every PR remains draft until a human reviews and merges it. The executor never approves or merges its own work.

## Verification and Suno safety

Implementation runs the contract's focused checks followed by `pnpm check && pnpm build`. Test changes require the read-only `adversarial-test-review` skill. High-risk domain changes run mutation testing or document an explicit exception.

`codex-ready` authorizes implementation only. Automated implementation and testing must not open the real Suno site, use an authenticated Suno profile, click **Create**, or consume credits. Browser and `live` paths use simulated DOM and adapter tests. Automated Gemini calls are allowed when the contract requires them and credentials remain local.

A future, separately approved E2E capability may use dedicated Chrome, an isolated browser profile, and a test Suno account that is separate from the user's Brave profile. This runbook does not configure or authorize that capability. Any future click on **Create** requires explicit human authorization for that specific task and remains outside the normal automated loop.
