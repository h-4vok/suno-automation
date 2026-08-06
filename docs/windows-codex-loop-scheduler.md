# Windows Codex loop scheduler

This trial executor is a deterministic Windows Task Scheduler control plane for one permanent
worktree (`worker-1`). It is separate from Codex Desktop Automations: PowerShell performs cheap
slot checks and GitHub claims, and starts `codex exec` only after it has claimed an eligible issue.
An empty queue or busy worker therefore consumes no Codex tokens.

## Install

1. Copy `config/codex-loop.scheduler.example.json` to
   `<git-common-dir>/codex-loop/scheduler-config.json`; replace the repository and the local
   `worker-1` path. Keep this copy uncommitted.
2. Authenticate `gh` and ensure `codex` is on `PATH` for the Windows account that owns the task.
3. Run `scripts/codex-loop/install-scheduled-task.ps1` with the local config path.

The installer creates one task only. It does not create Desktop threads or install a Desktop
Automation.

## Runtime behavior

`dispatch.ps1` first reads the shared ignored journal in
`<git-common-dir>/codex-loop/scheduler/worker-1.json`. A fresh wrapper PID plus heartbeat means
busy, so it returns before calling GitHub. Only a free parked slot queries `gh`, re-fetches the
oldest `codex-ready` issue, changes it to `codex-in-progress`, and starts the wrapper.

The wrapper records wrapper and Codex child PIDs, PID start time, heartbeat, issue, branch,
recovery count, and local logs. Its `finally` writes durable terminal evidence. If a wrapper dies
or its heartbeat becomes stale, the next tick preserves the branch, changes, commits, PR and log,
stops the process tree, then launches recovery on the same issue and branch. Five recoveries are
allowed; then the issue moves to `codex-needs-attention`. It is never silently requeued.

A completed wrapper releases its slot only after GitHub shows `codex-review` and the worktree is
clean and detached. All other terminal records remain held for safety.

## Trial cap

The scheduler increments ignored `scheduler.json` at every tick, including empty and busy ticks.
It disables its own Scheduled Task after the tenth tick. This is an initial-observation cap; do not
remove it until the one-worker trial has evidence of correct claim, execution, recovery, and
release behavior.
