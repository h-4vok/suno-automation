# Operations

## Codex issue execution boundary

GitHub is used for backlog, issue contracts, lifecycle audit, and draft-pull-request review. Codex Desktop workers run locally on the user's PC through the ChatGPT subscription available in the app. Two pre-existing isolated worktrees are available, with one active issue per worktree.

The scheduler polls GitHub for `codex-ready` issues, verifies dependencies, claims eligible work, and assigns it to an available worktree. GitHub Actions remain reserved for repository validation (`ci.yml` and `mutation.yml`). The local PC and Codex Desktop app must be running for scheduled work; this repository does not install or enable a user schedule automatically.

Workers must fail closed when issue state, dependencies, ownership, secrets, worktree state, or recovery evidence is unknown. They must never place credentials, cookies, session data, or private generated content in GitHub. Every implementation ends in a human-reviewed draft pull request; workers do not self-approve or merge.

## Codex loop supervised setup

Do not enable Scheduled until the full dry-run and smoke sequence passes.

1. From a clean control checkout, inspect the worktree plan:

   ```powershell
   .\scripts\setup-codex-loop-worktrees.ps1 `
     -ControlRoot <control> `
     -Worker1Path <new-worker-1> `
     -Worker2Path <new-worker-2>
   ```

2. Re-run with `-Apply` only after verifying the three exact resolved directories. The script
   creates two detached worktrees from the fetched remote base and installs frozen dependencies. It
   never deletes, resets, cleans, or moves another worktree.
3. In Codex Desktop, add each as a permanent project. Keep the control checkout as the dispatcher
   project. Copy `config/codex-loop.example.yaml` to ignored
   the shared Git-common-dir `codex-loop/config.yaml` (or an absolute local override); replace paths, opaque project IDs, and trusted login locally.
4. Generate at least 32 random characters for `CODEX_LOOP_VERIFICATION_KEY` in the local environment.
   This is an integrity key, not an OpenAI credential. Never print or commit it.
5. Validate and inspect:

   ```powershell
   pnpm loop validate-config
   pnpm loop health --json
   pnpm loop dispatch --dry-run --json
   ```

6. Manually invoke `$codex-loop-dispatcher` once. It must inspect actual Codex tasks/projects,
   create owner-only ignored task/capability evidence files without echoing their contents, run
   reconciliation and live dispatch with those files, then delete them. Confirm both permanent
   projects can be targeted and no claim occurs before the capability handshake.
7. In Codex Desktop **Scheduled**, create one project-scoped standalone task in the control project
   at a 15-minute cadence. Use the exact durable prompt in the dispatcher skill. Keep the machine
   powered on and Codex Desktop running.
8. Start with workspace-scoped write plus explicit `git`, `gh`, `pnpm`, GitHub network, and exact
   ignored state-directory access. Do not grant browser/Computer Use, home-wide write, OpenAI API,
   or live Suno access.

Codex Scheduled tasks are configured and inspected in the Desktop/web UI; the CLI only prepares and
tests the repository workflow. Scheduled runs are unattended, so inspect the first runs before
leaving the cadence active. See the official
[Scheduled tasks](https://learn.chatgpt.com/docs/automations) and
[worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees) documentation.

### Synthetic concurrency smoke

Use three independent, harmless, non-browser issues whose changes touch isolated disposable
fixtures/docs. Promote only the three synthetic items.

1. With both slots free, make two issues `codex-ready` and run one supervised dispatch tick.
2. Confirm distinct attempts/tasks/worktrees and `codex-in-progress` on both.
3. Promote the third; confirm it remains untouched in `codex-ready` while capacity is two.
4. Let the first two produce one draft PR each. Confirm commit-bound verification evidence and no
   second PR/branch.
5. Interrupt one worker after a safe journal stage. Use the dispatcher skill to capture fresh task
   evidence and run reconcile dry-run. Resume it, or post the exact supervised reconciliation
   marker and apply the single recommendation. Prove no duplicate task/comment/commit/PR.
6. Confirm health shows `2/2`, then a released slot and the third assignment.
7. Leave synthetic PRs open for human inspection. A human closes/merges and cleans them after
   acceptance; automation does not.

### Pause and recovery

- Pause the Scheduled task in **Scheduled** before maintenance or config/allowlist changes.
- Run `pnpm loop health ... --json`, then use `$codex-loop-dispatcher` to capture fresh task
  evidence and run reconciliation.
- Resume only when issue lifecycle, lease, task, worktree, branch, commit, and PR evidence agree.
- Expired-lease recovery requires a fresh owner-only evidence file observed after expiry, with the
  authenticated `gh` login equal to an allowlisted actor and every task/process/worktree/branch/PR
  signal definitively absent. Unknown evidence goes to attention; positive evidence is preserved.
- Reconciliation apply requires an exact fresh GitHub marker:
  `codex-reconcile event=<id> attempt=<attempt> action=<recommendation>`. Never fix evidence with
  reset, clean, force push, branch deletion, replacement PR, issue reopening, or merge.
- To disable the loop, pause/delete the Scheduled task first, leave state evidence intact, then
  remove permanent worktrees manually only after proving they are clean and fully pushed.

## One-time local setup

1. Run `pnpm setup:local`. It creates missing local files and copies a random extension token to the clipboard without printing it. Existing config and token are preserved.
2. Add real presets to `config/config.yaml`. Keep style prompts and instrument instructions in English.
3. Add a Gemini API key to `.env` only when moving beyond `observe`.
4. Run `corepack pnpm check && corepack pnpm build` for engineering validation.
5. Open `brave://extensions`, enable Developer mode, choose **Load unpacked**, and select the exact absolute folder `C:\src\suno-automation\extension\dist`. Do not select `extension` or the repository root. The generated `LOAD_THIS_FOLDER.txt` identifies the installable package.
6. Click the extension's toolbar icon. Keep `http://127.0.0.1:4317`, paste the clipboard token, leave live submissions off, and save.
7. Start the coordinator with `pnpm start` and leave that terminal open.

The extension popup reports whether the coordinator is connected, offline, or rejecting the token.
Opening the popup or saving valid settings requests an immediate poll. An offline coordinator during
extension installation is expected and retries automatically; it is not an extension installation
failure.

`Coordinator connected` appears in the extension popup, not as a routine service-worker console
message. A quiet service-worker console is expected during successful polling. The status history
records why quota was classified. Suno's `Upgrade to Pro` and `Earn Credits` navigation is
promotional and does not prove that the current daily balance is exhausted; likewise, Create is
normally disabled while its form is empty and may become enabled after valid fields are filled. The
adapter treats that enabled/disabled state only as local form readiness, never as quota evidence. If
Suno exposes neither a remaining-credit number nor an explicit exhaustion message, inspection
deliberately returns `unknown`. This does not block observe or draft preparation, and neither mode
claims that credits are available. A `submitted` result records that the guarded click was
dispatched; Suno's subsequent UI/quota state determines whether its server accepted the request. If
that post-submit state is still unknown, the run stops before another click.

Brave retains extension error entries after the code that produced them has been replaced. After
building and pressing **Reload** on version 0.1.5, open **Errors** and press **Clear all** once. If the
same entry does not return during a fresh poll, it was historical. Opening an old entry can display
the current bundle at the old saved line number, so the code shown beside an old error is not proof
that the current bundle emitted it.

No Suno cookie or password enters config. Brave's existing profile remains the sole authentication owner.

## Safe acceptance sequence

### Observe

Keep `automation.mode: observe`. Run `pnpm start` and leave that terminal open, then in another
terminal run `pnpm run:now`. The extension polls at least once per minute; opening its popup
requests an immediate poll. It may open a background Suno Create tab and inspect controls; it must
not fill or click. Check with:

```powershell
pnpm status
```

Expected completion reason: `observe-only`, `credits-unavailable`, or a closed failure describing an unknown UI state.

### Draft

Set mode to `draft`, restart server, and manually trigger one forced run only after inspecting prior state. The current CLI does not force by default; use the authenticated HTTP API with `{ "reason": "manual", "force": true }` when intentional. Confirm title, structure, style, and Instrumental in Suno. Create must remain unclicked.

### Live

Set server mode to `live`, restart, then explicitly enable live submissions in extension options. Both settings are required. Keep `maxGenerationsPerDay: 1` for first live acceptance; raise only after checking state and Suno results.

## Scheduling and recovery

Coordinator must be running at cron time. The schedule uses `Europe/London` by default and handles daylight-saving changes through the configured IANA timezone. Safe inspection/draft messages may retry; live sends never retry after an ambiguous browser response. A restarted coordinator reloads `runtime/state.json`, re-inspects interrupted planning, and cancels persisted live work if current config is no longer `live`.

To run the coordinator automatically after Windows logon, inspect and then execute `scripts/install-windows-task.ps1`. It registers a user-level task but is never run automatically by repository setup.

## Updating presets

- Add YAML entries; no code change needed.
- Use equal weights for equal probability.
- Set `enabled: false` for a temporarily disabled style.
- Set `weight: 0` for an instrument that should remain documented but unselected.
- Run `pnpm validate:config` after edits (the default script validates the example; pass your local path to the CLI for local config).

## Token commands

- `pnpm get-extension-token` keeps the existing token and copies it to the clipboard.
- `pnpm rotate-extension-token` replaces it, then requires a coordinator restart and saving the new token in the extension.
- The token is a local shared secret, not a Suno, Gemini, or OpenAI credential. Commands never print it.

## UI drift

If status ends with unknown state or missing fields, do not enable live. Capture only a sanitized list of visible labels/placeholders—never cookies or page source containing personal data—then update `extension/src/dom-adapter.ts` and its DOM contract tests together.
