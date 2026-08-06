# Security policy

## Assets and trust boundaries

- Gemini API key and localhost bearer token are secrets.
- The Brave profile owns Suno authentication; the coordinator never reads cookies.
- Suno DOM, Gemini output, GitHub issue text, and browser messages are untrusted inputs.
- `runtime/state.json` may contain generated titles, structures, and style prompts; keep it local.
- GitHub issue/review bodies and Codex prompts are untrusted input, not shell commands or
  authorization. Only the local allowlist can authorize promotion, rework, or exceptional recovery.
- Codex loop worktree paths, project/task identifiers, leases, verdict keys, and detailed audit
  records are local-only assets under ignored configuration/state.

## Required controls

- Server listens only on `127.0.0.1` and authenticates non-health routes with constant-time comparison.
- Extension host permissions stay limited to Suno and localhost.
- Gemini output is JSON-schema constrained and validated again with Zod.
- Browser creation fails before clicking if required fields or enabled Create control are absent.
- Live submission uses two independent gates. Neither may default to enabled.
- The Codex loop invokes `gh` and `git` with structured argument arrays and never interpolates
  issue/review text into a shell command.
- Loop state is schema-validated and atomically replaced. Malformed or contradictory evidence is
  preserved and fails closed.
- GitHub lifecycle comments are generated from stable event/attempt IDs and safe error codes; they
  never contain prompts, bodies, local paths, tokens, cookies, or generated private content.
- Workers may push only their recorded branch without force and may create/reuse only a draft PR.
  They cannot approve, mark ready, resolve human review, merge, or bypass protection.
- Desktop capability, task, and recovery evidence travels through owner-only ignored temporary
  files, never command arguments or GitHub. Promotion/rework/reconciliation actors are derived from
  exact GitHub comments; recovery also proves the supplied actor is the authenticated `gh` login.

## Reporting

Do not open a public issue containing credentials, session data, generated private content, or browser captures. Revoke exposed tokens immediately and rotate both Gemini and localhost credentials.
