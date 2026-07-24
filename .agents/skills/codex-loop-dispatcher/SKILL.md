---
name: codex-loop-dispatcher
description: Reconcile and dispatch the repository's scheduled local GitHub issue loop into exactly two permanent Codex Desktop worker projects. Use for a manual or Scheduled dispatcher tick, dry-run queue inspection, thread recovery, or dual-worker health checks; never use it to implement issue source changes.
---

# Codex Loop Dispatcher

Act only as the control plane. Do not edit product files, implement issue contracts, merge pull
requests, open Suno, or substitute cloud/API execution.

## Preflight

1. Read `AGENTS.md` and `docs/codex-loop.md`.
2. Resolve the ignored shared config through the Git common directory (or an explicit absolute `--config`). Never print its paths, project IDs,
   allowlist, state directory, or verification key.
3. Confirm authenticated `gh`, network access, and task/thread tools that can inspect and target
   each configured permanent worker project. If exact project/worktree targeting is unavailable,
   stop before claim.
4. From actual Desktop inspection, write two owner-only JSON artifacts under the ignored state
   directory: fresh task evidence for occupied attempts and the version-1 capability evidence for
   exactly `worker-1` and `worker-2`. Use the schemas in `src/loop/policy.ts`. Never place either
   artifact in argv, output, a task message, GitHub, or a committed path; only its path may be
   passed to the CLI.
5. Run:

   ```powershell
   pnpm loop validate-config
   pnpm loop reconcile --dry-run --task-evidence-file <task-evidence-file> --json
   pnpm loop dispatch --dry-run --json
   ```

6. Stop on malformed state, contradictions, unsafe slots, unavailable tools, or attention
   recommendations. Never clean/reset a worktree to make it pass.

## Dispatch tick

Run the live allocator once:

```powershell
pnpm loop dispatch --capabilities-file <capability-file> --json
```

Delete both evidence artifacts in a `finally` step after their last consumer, using only their
exact validated paths. The CLI response identifies slots but deliberately omits project IDs; map
each slot to the already inspected project without printing the mapping.

For every returned assignment:

1. Search existing Codex tasks for its exact attempt identifier before creating anything.
2. If found in the configured worker project, resume/reuse it and acknowledge it.
3. Otherwise create one task in the assignment's exact permanent worker project/worktree using the
   returned `workerPrompt`. Never target the dispatcher checkout.
4. After creation is acknowledged, persist only the opaque task identifier:

   ```powershell
   pnpm loop thread-ack <attempt> <thread-id>
   ```

5. If creation definitively fails, run `thread-fail`. If the response is ambiguous, search by
   attempt first; do not create a second task.

Launch zero, one, or two assignments and return without waiting for implementation. Never exceed
one assignment per slot or two active workers.

## Recovery and safe reconciliation

Never relaunch an expired pending attempt. Inspect its task plus relevant local process, worktree,
branch operation, and linked PR. Write fresh version-1 recovery evidence after lease expiry and run:

```powershell
pnpm loop recover <attempt> --evidence-file <recovery-evidence-file>
```

The claimed actor must match authenticated `gh` and the allowlist. Any positive evidence preserves
the attempt; missing or contradictory evidence moves it to attention. For a safe reconciliation
recommendation, require the allowlisted human to post exactly
`codex-reconcile event=<id> attempt=<attempt> action=<recommendation>`, then run one
`reconcile --apply` with the fresh task evidence file. Never synthesize that authorization,
approve/merge a PR, reopen an issue, or repair with reset/clean/deletion.

## Scheduled prompt

Use this durable prompt for the supervised Scheduled task:

> Use `$codex-loop-dispatcher` in the local control project. Reconcile first, then run one dispatch
> tick. Fill at most the two configured permanent worker slots, deduplicate by attempt identifier,
> and return after task acknowledgement. Stop on any ambiguity. Do not edit source, merge, use an
> API executor, or access Suno.

Configure the actual 15-minute Scheduled task only under supervised issue #48.
