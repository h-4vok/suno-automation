# Suno Automation

Suno Automation is a local-first assistant for using otherwise-expiring Suno free-plan credits on
personal instrumental experiments. It combines:

- a local TypeScript coordinator that schedules runs and keeps auditable state;
- Gemini structured output for instrumental titles and song structures;
- weighted style presets and optional featured instruments;
- a Brave/Chrome extension that uses the Suno session already open in your browser.

The coordinator never receives your Suno cookies or password. The extension talks only to the
local coordinator and `suno.com`.

> [!IMPORTANT]
> This is an unofficial browser automation project. Suno's UI can change, and free-plan output is
> for personal, non-commercial use. Keep the project in `observe` mode until the current UI has
> been verified.

## How it works

1. A manual command or daily schedule starts a run.
2. The extension opens or reuses `https://suno.com/create` in the background.
3. The coordinator chooses a style using relative weights and may choose a featured instrument.
4. Gemini returns a title and bracketed instrumental structure in English.
5. Depending on the safety mode, the extension observes the UI, prepares a draft, or makes one
   guarded submission attempt.

Suno's server is the final authority on whether credits are available. Promotional text such as
`Upgrade to Pro`, and a disabled Create button on an empty form, are not treated as proof that the
daily balance is exhausted.

## Safety modes

| Mode      | Inspect Suno | Call Gemini | Fill the form | Click Create                        |
| --------- | ------------ | ----------- | ------------- | ----------------------------------- |
| `observe` | Yes          | No          | No            | Never                               |
| `draft`   | Yes          | Yes         | Yes           | Never                               |
| `live`    | Yes          | Yes         | Yes           | Only with a second extension opt-in |

`observe` is the default. A live submission requires both `automation.mode: live` in the local
configuration and **Allow live submissions** in the extension. Neither setting is enabled by
default.

## Requirements

- Node.js 22 or newer
- Corepack with pnpm 11
- Brave or another Chromium-based browser
- A Suno account already signed in to that browser
- A Gemini API key only for `draft` or `live` mode

Bun is optional, but convenient for the day-to-day commands shown below.

## First-time setup

From PowerShell in the repository root:

```powershell
corepack pnpm install --frozen-lockfile
bun run setup:local
corepack pnpm build
```

`setup:local` creates the ignored `.env` and `config/config.yaml` files when missing. It also creates
a random local extension token and copies it to the clipboard without printing the secret.

Next:

1. Edit `config/config.yaml` and add your style and instrument presets. Weights are relative; equal
   weights mean equal probability.
2. Open `brave://extensions` and enable **Developer mode**.
3. Choose **Load unpacked** and select the exact `extension/dist` directory.
4. Open the extension popup, leave `http://127.0.0.1:4317`, paste the token, and keep live
   submissions disabled.
5. Start the coordinator and leave its terminal open:

   ```powershell
   bun run start
   ```

6. In a second terminal, trigger a safe run and inspect its state:

   ```powershell
   bun run run:now
   bun run status
   ```

The extension popup should show its packaged version and `Coordinator connected`. Routine success
is intentionally quiet in the service-worker console.

## Essential commands

| Command                          | Purpose                                                       |
| -------------------------------- | ------------------------------------------------------------- |
| `bun run setup:local`            | Create missing local config and copy the extension token      |
| `bun run get-extension-token`    | Copy the existing extension token again                       |
| `bun run rotate-extension-token` | Replace the token; restart and update the extension afterward |
| `corepack pnpm build`            | Build the coordinator and unpacked extension                  |
| `bun run start`                  | Start the built coordinator and scheduler                     |
| `bun run dev`                    | Start the coordinator directly with file watching             |
| `bun run run:now`                | Start one run in the configured mode                          |
| `bun run status`                 | Print runs, commands, and completion reasons                  |
| `corepack pnpm validate:config`  | Validate the committed example configuration                  |
| `corepack pnpm check`            | Run formatting, lint, type checking, and the full test suite  |
| `corepack pnpm test:mutation`    | Challenge high-risk selection and planning tests              |

After changing extension code, run `corepack pnpm build` and press **Reload** on
`brave://extensions`.

## Configuration

The committed [`config/config.example.yaml`](config/config.example.yaml) documents every setting.
Local values belong in the ignored `config/config.yaml`.

- Style and instrument weights are relative, not rankings.
- `instrumentalFeatureChance` controls how often an extra featured instrument is requested.
- Gemini and Suno control text stays in English.
- Generated structures are instrumental and contain no sung lyrics.
- The scheduler uses an IANA timezone and only runs while the coordinator is running.

## Development and documentation

The project includes unit, component, integration, DOM-contract, and mutation tests. Pre-commit
hooks format and lint staged files; the pre-push hook runs the complete quality gate.

- [Operations and safe acceptance](docs/operations.md)
- [Architecture](docs/architecture.md)
- [Testing strategy](docs/testing.md)
- [Security policy](SECURITY.md)
- [Agent engineering rules](AGENTS.md)

Generated builds, runtime state, local presets, API keys, extension tokens, coverage, and Graphify
artifacts are intentionally excluded from Git.
