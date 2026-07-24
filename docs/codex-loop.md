# Local Codex issue loop

## Purpose and boundary

GitHub is the backlog, coordination, review, and audit surface for local Codex Desktop workers. Each worker uses the user's ChatGPT subscription in an isolated pre-existing worktree and opens a draft pull request for human review.

`codex-ready` is the work queue signal. A local scheduler polls GitHub, claims eligible issues, and assigns them to an available worker. Two pre-existing worktrees are available for parallel execution; the scheduler never assigns more than one active issue to a worktree.

The local workers use the ChatGPT subscription already available to the Codex Desktop app. Gemini configuration remains separate and local to the Suno assistant. The PC and Codex Desktop app must be running for scheduled work.

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

The executor does not parse a YAML business schema or decide whether prose is sufficiently
complete. Promotion is valid only when exactly one GitHub comment has the exact marker
`codex-lifecycle event=contract-promoted from=backlog to=codex-ready` and GitHub reports its author
in the local allowlist. Missing, duplicated, or spoofed markers fail closed. Minor local
implementation choices remain with the implementing agent.

## Local operating runbook

### Preconditions

- The project is available on the local PC and Codex Desktop is installed, signed in, and running.
- Two pre-existing isolated worktrees are configured for local workers, each with its own branch and process lease.
- GitHub CLI (`gh`) is available in PowerShell and authenticated for the repository. Issue text, comments, and browser messages remain untrusted input.
- A human reviews resulting draft pull requests; no per-task manual confirmation is required before a `codex-ready` issue is assigned.
- The ignored shared `<git-common-dir>/codex-loop/config.yaml` validates from
  `config/codex-loop.example.yaml` (or an explicit absolute override is set), and `CODEX_LOOP_VERIFICATION_KEY` contains at least 32 random
  characters.

### Select and claim

1. Poll open issues with `gh` and select only a non-epic issue with the `codex-ready` lifecycle label.
2. Verify that every blocking issue referenced by the contract is closed.
3. Confirm that the issue contract has actionable outcome, scope, safety constraints, acceptance criteria, implementation notes, and verification commands.
4. Claim the issue with the repository lifecycle protocol and record the attempt identifier.
5. Assign the claim to one available pre-existing worktree. If both worktrees are occupied, leave the issue queued.
6. If state, ownership, dependency, or process evidence is missing or contradictory, stop and move the issue to `codex-needs-attention`; do not guess or claim it.

## Implemented local control surface

The executable entrypoint is `pnpm loop`. All GitHub and Git subprocesses use structured arguments;
issue/review text is never evaluated as a command.

| Command                                                                                   | Outcome                                                                     |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `pnpm loop validate-config <config>`                                                      | Validate fixed capacity two without printing local values                   |
| `pnpm loop dispatch <config> --dry-run --json`                                            | Report ordering, blockers, slots, and intended assignments with zero writes |
| `pnpm loop dispatch <config> --capabilities-file <file> --json`                           | Validate Desktop targeting, then claim up to two assignments                |
| `pnpm loop thread-ack <config> <attempt> <task>`                                          | Bind one opaque Codex task to an attempt                                    |
| `pnpm loop worker <config> prepare <attempt>`                                             | Revalidate and prepare the recorded branch/worktree                         |
| `pnpm loop worker <config> checkpoint <attempt> ...`                                      | Journal implementation/commit stages                                        |
| `pnpm loop worker <config> verify <attempt> ...`                                          | Produce the signed deep-verification verdict                                |
| `pnpm loop worker <config> push <attempt>`                                                | Push the verified commit without force and prove remote acknowledgement     |
| `pnpm loop finalize <config> <attempt> --result review`                                   | Create/reuse one draft PR, transition, park, and release                    |
| `pnpm loop finalize <config> <attempt> --result attention --error <code>`                 | Persist safe failure, transition, and release                               |
| `pnpm loop recover <config> <attempt> --evidence-file <file>`                             | Reconcile an expired lease from fresh negative operational evidence         |
| `pnpm loop health <config> [--json]`                                                      | Report queue, both slots, stale leases, recent outcomes, and attention      |
| `pnpm loop reconcile <config> --dry-run --task-evidence-file <file>`                      | Compare fresh task, local, GitHub, and PR evidence without writes           |
| `pnpm loop reconcile <config> --apply <attempt> --event <id> --task-evidence-file <file>` | Apply one GitHub-authorized safe repair                                     |

Capability, task, and recovery evidence files are ignored local artifacts created with owner-only
permissions and deleted after use. Their contents and paths are never printed. Live dispatch
validates a fresh exact two-project Desktop capability handshake before any mutex, state, GitHub,
or worktree action.

`reconcile --apply` is explicitly supervised and accepts only one fresh exact GitHub authorization
comment whose author is allowlisted. It can repair a missing lifecycle comment/index, release an
already parked review slot, complete a merged/closed issue, or move contradictory work to
attention. Dirty, missing, or conflicting local state remains held in attention. It never resets,
cleans, force-pushes, deletes, replaces evidence, reopens an issue, or merges a PR.

### Claim and task saga

1. Acquire the short local dispatcher mutex.
2. Read and schema-validate the version-1 state document.
3. Inspect both configured permanent worktrees and query the GitHub queue.
4. Revalidate the selected issue under the mutex.
5. Persist a pending attempt and per-slot lease.
6. Apply the stable `claim-<attempt>` lifecycle transition/comment.
7. Persist `launch-pending`, release the mutex, and return the assignment.
8. The dispatcher skill searches Codex tasks by attempt, creates at most one in the exact permanent
   project, then calls `thread-ack`.

An ambiguous GitHub mutation becomes local attention and does not appear as an active worker.
An ambiguous task response is searched by attempt before retry. A later dispatch tick returns
unacknowledged `launch-pending` assignments rather than creating a new claim.

### Worker publication saga

The worker skill calls the CLI around normal Codex implementation. Branch preparation permits no
reset/clean. After a focused implementation and intentional commit, deep verification runs the full
gate, build, applicable config/mutation gates, diff guard, and independent adversarial test review.
The HMAC verdict is tied to the exact commit.

Only that verified commit may be pushed. PR creation first searches the head branch and reuses an
existing open draft. The attempt records `pr-linked`, transitions GitHub to `codex-review`, then
parks the clean worktree on the current detached remote base before releasing the slot. A retry
revalidates the recorded PR and remote commit, safely re-parks after a base advance, and reuses the
same branch, commit, PR, event, comment, and attempt.

### Rework

An exact `codex-rework` GitHub comment supplies an event ID, existing PR, base executor commit, and
explicit unresolved feedback identifiers. The adapter derives the actor from GitHub, not a CLI
assertion, and proves every feedback ID is unresolved and newer than the last executor commit.
Untrusted, ambiguous, stale, resolved, or out-of-scope feedback is not queued and records only a
deduplicated safe decision event. Rework is limited to three attempts, has queue priority, may
use either free slot, checks out the existing branch without force, reruns the full verification
pipeline, and updates the same draft PR.

### Execute and review

1. Use the assigned pre-existing isolated worktree and its prescribed `codex/<issue-number>-<short-kebab-summary>` branch.
2. Read repository instructions and the issue contract before editing.
3. Implement only the bounded contract. Keep secrets, cookies, session data, and generated private content out of source, logs, comments, and the pull request.
4. Run focused verification, then `pnpm check && pnpm build`; run configuration and mutation gates when the contract requires them.
5. Open one draft pull request linked to the issue, with concise verification evidence and no live Suno account activity.
6. Move the issue to review and wait for a human to inspect and merge the draft pull request. The local executor never approves or merges its own work.

### Scheduling and recovery

- Scheduling is local to the user's PC and polls GitHub for `codex-ready` issues.
- The PC and Codex Desktop app must be running for scheduled work. Repository setup does not configure the user's schedule automatically.
- At most two issues may be active concurrently, one per pre-existing worktree.
- A restart may resume only after revalidating the issue state, lease, worktree, branch, and linked draft pull request.
- An expired claim is recoverable only from fresh evidence observed after expiry, with no relevant
  task, process, worktree operation, branch operation, or linked draft PR active. The claimed actor
  must equal the authenticated GitHub login and be allowlisted. Missing or contradictory evidence
  moves the attempt to attention; positive evidence preserves it.
- Recovery must not duplicate claims, branches, commits, comments, or pull requests.

## Lifecycle

Exactly one lifecycle label applies at a time:

| State                   | Meaning                                                            |
| ----------------------- | ------------------------------------------------------------------ |
| `backlog`               | Defined or under refinement, but not approved for implementation.  |
| `codex-ready`           | Decision-complete and eligible for the local implementation queue. |
| `codex-in-progress`     | Claimed by one of the two local workers.                           |
| `codex-review`          | A linked draft PR awaits human review.                             |
| `codex-rework`          | A trusted human requested another bounded pass on the existing PR. |
| `codex-needs-attention` | Automation stopped and requires an explicit recovery decision.     |
| `blocked`               | An explicit dependency or decision prevents progress.              |

Area, priority, issue type, and `manual-validation` are attributes rather than lifecycle states.
`manual-validation` means the issue is excluded from unattended background dispatch and must be
started in a supervised task. It does not authorize live Suno access. A supervised human may still
use the worker workflow for its safe implementation portions.

Dependencies use GitHub issue references. A blocking dependency is resolved only when the referenced issue is closed. Selection, dependency checks, claiming, state transitions, leases, recovery, and deduplication must be deterministic and fail closed.

## Trust, audit, and recovery

Promotion, rework, and manual recovery instructions are accepted only from GitHub logins in a local, uncommitted allowlist. The repository may define the configuration shape and example, but the actual allowlist belongs to the local executor configuration. Issue and review text from every actor remains untrusted input.

Each lifecycle transition adds a separate, concise GitHub comment. Every comment includes a stable event name and attempt identifier so repeated delivery can be detected without guessing from prose. Comments contain no prompts, issue-body copies, tokens, cookies, credentials, generated private content, local paths, or account/session details.

Per-worktree leases prevent concurrent implementation. After an interruption, a worker may recover an expired claim only after proving that no relevant process, worktree, branch operation, or linked draft PR is still active. If evidence is missing or contradictory, it moves the issue to `codex-needs-attention` and waits for an allowlisted human. Recovery must never create duplicate branches, commits, comments, or PRs.

Every PR remains draft until a human reviews and merges it. The executor never approves or merges its own work.

Local audit retains at most 90 days and 500 completed attempts by default. Every attempt still
referenced by a slot, including a late publication or local attention hold, is never automatically
pruned. Each maintenance pass records a bounded retention event. Audit schemas accept only stable safe fields; unknown
properties such as bodies, prompts, paths, tokens, or generated content are rejected.

## Verification and Suno safety

Implementation runs the contract's focused checks followed by `pnpm check && pnpm build`. Test changes require the read-only `adversarial-test-review` skill. High-risk domain changes run mutation testing or document an explicit exception.

`codex-ready` authorizes implementation only. Automated implementation and testing must not open the real Suno site, use an authenticated Suno profile, click **Create**, or consume credits. Browser and `live` paths use simulated DOM and adapter tests. Automated Gemini calls are allowed when the contract requires them and credentials remain local.

A future, separately approved E2E capability may use dedicated Chrome, an isolated browser profile, and a test Suno account that is separate from the user's Brave profile. This runbook does not configure or authorize that capability. Any future click on **Create** requires explicit human authorization for that specific task and remains outside the normal automated loop.

## Supervised activation

Issue #48 is the activation gate:

1. Run `scripts/setup-codex-loop-worktrees.ps1` without `-Apply`, inspect the resolved control and
   two future worker paths, then rerun with `-Apply`.
2. Add both detached worktrees as permanent Codex projects and record only their local opaque IDs
   in the ignored config.
3. Generate the local verification key, add the trusted-login allowlist, and validate config.
4. Invoke `$codex-loop-dispatcher` manually in dry-run.
5. In Codex Desktop, create one project-scoped Scheduled task at 15-minute cadence using the durable
   prompt in the dispatcher skill. Scheduled management is a Desktop/web surface, not a repository
   CLI.
6. Use the narrowest unattended permissions that allow the exact repositories/worktrees, ignored
   state directory, `git`/`gh`/`pnpm`, and required GitHub network access.
7. Supervise two harmless independent synthetic issues, a queued third, and one interrupted worker
   recovery before leaving the schedule enabled.

Pause or disable the Scheduled task before changing config, worktree ownership, trust allowlist, or
branch protection.
