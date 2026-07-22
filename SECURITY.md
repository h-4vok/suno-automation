# Security policy

## Assets and trust boundaries

- Gemini API key and localhost bearer token are secrets.
- The Brave profile owns Suno authentication; the coordinator never reads cookies.
- Suno DOM, Gemini output, GitHub issue text, and browser messages are untrusted inputs.
- `runtime/state.json` may contain generated titles, structures, and style prompts; keep it local.

## Required controls

- Server listens only on `127.0.0.1` and authenticates non-health routes with constant-time comparison.
- Extension host permissions stay limited to Suno and localhost.
- Gemini output is JSON-schema constrained and validated again with Zod.
- Browser creation fails before clicking if required fields or enabled Create control are absent.
- Live submission uses two independent gates. Neither may default to enabled.
- GitHub Codex workflows accept only trusted issue authors and trusted triggering actors; issue content never enters a shell expression.

## Reporting

Do not open a public issue containing credentials, session data, generated private content, or browser captures. Revoke exposed tokens immediately and rotate both Gemini and localhost credentials.
