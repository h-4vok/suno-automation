# Operations

## Codex issue execution boundary

GitHub is used for backlog, issue contracts, lifecycle audit, and draft-pull-request review. Codex Desktop workers run locally on the user's PC through the ChatGPT subscription available in the app. Two pre-existing isolated worktrees are available, with one active issue per worktree.

The scheduler polls GitHub for `codex-ready` issues, verifies dependencies, claims eligible work, and assigns it to an available worktree. GitHub Actions remain reserved for repository validation (`ci.yml` and `mutation.yml`). The local PC and Codex Desktop app must be running for scheduled work; this repository does not install or enable a user schedule automatically.

Workers must fail closed when issue state, dependencies, ownership, secrets, worktree state, or recovery evidence is unknown. They must never place credentials, cookies, session data, or private generated content in GitHub. Every implementation ends in a human-reviewed draft pull request; workers do not self-approve or merge.

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
