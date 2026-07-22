# Repository guidance

## Mission

Build a local-first, auditable assistant that uses otherwise-expiring Suno free-plan credits for personal instrumental experiments. Preserve user control and fail closed around browser actions.

## Commands

- Install: `pnpm install --frozen-lockfile`
- Full gate: `pnpm check && pnpm build`
- Focused tests: `pnpm exec vitest run <test-file>`
- Mutation gate: `pnpm test:mutation`
- Config check: `pnpm validate:config`

## Non-negotiable invariants

- Never put `GEMINI_API_KEY`, extension tokens, cookies, or Suno session data in source, logs, fixtures, issue bodies, or PRs.
- Bind coordinator to `127.0.0.1`; require bearer auth for every endpoint except `/health`.
- Default mode remains `observe`. A Suno submission requires server mode `live` and extension `allowLiveSubmissions=true`.
- Unknown DOM/quota state fails closed. Never guess and click.
- Keep Gemini and Suno control text in English. All songs remain instrumental; structure contains no sung lyrics.
- UI adapters must use semantic fallbacks and tests. Do not silently replace them with one brittle generated CSS selector.
- Do not access or mutate the live Suno account unless the user explicitly requests that test in the current task.

## Engineering expectations

- Keep domain selection, planning, and workflow logic independent of browser and SDK adapters.
- Name implementation branches `codex/<issue-number>-<short-kebab-summary>`; use `codex/epic-<issue-number>-<short-kebab-summary>` for work spanning an epic. Keep names lowercase, descriptive, and under 60 characters.
- Validate every boundary with schemas. Inject clock, randomness, persistence, and AI interfaces for tests.
- Add a regression test that fails under the defect before fixing it.
- Prefer outcome tests over implementation assertions. Run `$adversarial-test-review` whenever tests change.
- Update config example and relevant docs with any new user-facing option.
- Preserve idempotency across retries and process restarts.

## Definition of done

1. Acceptance behavior is implemented with safe defaults.
2. `pnpm check && pnpm build` passes.
3. High-risk domain changes survive `pnpm test:mutation` or include a documented reason.
4. Diff is reviewed for secret leakage, accidental live actions, retry duplication, and vanity tests.
5. Architecture/operations docs match behavior.

Read `docs/architecture.md`, `docs/testing.md`, and `SECURITY.md` when changing workflow, browser, persistence, authentication, or tests.
