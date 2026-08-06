# Architecture

## System shape

```mermaid
flowchart LR
  Cron["Local GitHub issue scheduler"] --> Workers["Two local Codex Desktop workers"]
  Workers --> Coordinator["Coordinator state machine"]
  Coordinator --> Domain["Weighted style + optional instrument"]
  Domain --> Gemini["Gemini structured output"]
  Coordinator <--> Extension["Brave/Chrome MV3 extension"]
  Extension <--> Suno["Authenticated Suno tab"]
  Coordinator --> State["Atomic local JSON state"]
```

The split is intentional: issue polling, assignment, and leases run locally; secrets and Suno orchestration stay in Node; cookies stay inside the browser profile; the content script knows only the prepared Suno fields. Two pre-existing worktrees provide bounded parallelism, one active issue per worktree.

## Codex engineering control plane

The GitHub issue loop is a separate subsystem under `src/loop`; it never calls the Suno coordinator,
browser extension, Gemini adapter, or live-action paths.

```mermaid
flowchart LR
  Scheduled["Windows Task Scheduler"] --> Dispatch["Deterministic PowerShell dispatcher"]
  Dispatch --> Journal["Ignored per-slot journal"]
  Dispatch <--> GitHub["GitHub issues and draft PRs"]
  Dispatch --> A["worker-1 codex exec wrapper"]
  A --> Journal
  A --> PRA["One branch + one draft PR"]
```

Configuration fixes capacity at the ordered tuple `worker-1`, `worker-2`. The mutex is held only
while reconciling candidates and reserving slots. A durable lease belongs to one slot/attempt;
worker execution never holds a global lock. The claim saga persists a pending reservation, applies
one idempotent GitHub lifecycle event, then waits for the Scheduled adapter to acknowledge the
opaque Codex task identifier. An acknowledgement retry searches by attempt identifier before
creating another task.

Each attempt journals safe stages from `reserved` through `review` or `attention`. State and audit
writes validate against Zod and use temporary-file replacement. Malformed state is preserved and
startup fails closed. Issue bodies, review text, prompts, project identifiers, worktree paths, and
credentials are excluded from audit and lifecycle comments.

Workers create or reuse `codex/<issue>-<slug>` from the configured remote base. Publication requires
a clean commit-bound verification verdict, an acknowledged non-force push, and exactly one open
draft PR for the head branch. The worktree is parked on a detached remote base only after the remote
commit and PR are proven; review state releases its slot.

The legacy two-slot TypeScript loop remains an auditable domain control surface. The trial Windows
executor is deliberately separate: PowerShell performs cheap local slot checks and GitHub claims,
then invokes Codex CLI only for an already claimed issue. It does not pretend there is a stable
in-process Desktop API or create Desktop tasks.
Before a live tick, the Desktop control plane writes a short-lived schema-validated capability
artifact proving exact access to both configured projects and task controls. Operational evidence
uses the same ignored-file boundary so project IDs and recovery details never enter argv, output,
GitHub, or durable audit.

Recovery and reconciliation separate pure policy from effects. Fresh GitHub-authenticated or
GitHub-comment authorization is evaluated before any state transition. Safe apply operations can
repair lifecycle acknowledgements and terminal indexes; local conflicts remain capacity-holding
attention and no code path performs destructive Git cleanup.

## Daily run

1. Cron creates one run for the current day in the configured timezone.
2. Extension leases an `inspect` command, opens or reuses an exact `https://suno.com/create` tab, and reports `available`, `upgrade`, or `unknown`. Other Suno tabs are left untouched. A positive remaining-credit count means available; only an explicit zero/exhaustion message means upgrade. Enabled or disabled composer actions, `Free Plan`, `Earn Credits`, and promotional `Upgrade to Pro` links are inconclusive and remain unknown.
3. `upgrade` completes without work. `observe` records what was observable and stops without claiming availability. An initial `unknown` does not block draft preparation because no quota-consuming action has occurred. After a live click, `unknown` stops the run to prevent another ambiguous click.
4. `draft` or `live` selects one enabled style by weight. An independent probability decides whether to select a weighted feature instrument.
5. Gemini returns `{title, lyricsField}` under JSON Schema; Zod validates bracket-only structure.
6. Extension activates Custom mode, fills title/structure/style, and enables Instrumental.
7. `draft` stops. In `live`, the adapter locates `button[aria-label="Create song"]` first, with a text-based semantic fallback. It checks local form readiness only after filling the fields and clicks only when the extension's separate local safety gate is enabled and the action is enabled.
8. A `submitted` browser result means the guarded click was dispatched, not that Suno's server accepted generation. Quota is inspected again; observable server-driven Suno state remains authoritative. If that result is still unknown, the run stops rather than dispatching another click.

Commands are leased and state/result transitions are atomic and idempotent. State writes use a temporary file plus atomic rename. Live browser dispatch is at-most-once: a lost response is never retried because the click outcome is ambiguous. Interrupted planning is safely re-inspected; an ambiguous creation is stopped for manual reconciliation. The daily guard counts submitted plus pending live generation slots, not songs; each Suno generation may produce two versions.

## Weighted presets

Weights are relative, not ranks. For enabled items:

`P(item) = item.weight / sum(all enabled positive weights)`

Equal values give equal probability. Zero disables selection without deleting the preset. New styles and instruments are plain YAML entries; IDs remain stable kebab-case audit identifiers.

## Modes

| Mode      | Inspect | Call Gemini | Fill Suno | Click Create               |
| --------- | ------- | ----------- | --------- | -------------------------- |
| `observe` | yes     | no          | no        | no                         |
| `draft`   | yes     | yes         | yes       | never                      |
| `live`    | yes     | yes         | yes       | only with extension opt-in |

## Known boundary

Suno has no supported integration in this project. DOM labels can change. Semantic selector fallbacks are covered against simulated DOM, and the current composer has only been inspected read-only. First real validation must remain in `observe`, then `draft`, before live is enabled.
