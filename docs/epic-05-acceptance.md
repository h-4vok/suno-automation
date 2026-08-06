# Epic 05 acceptance map

This map is the implementation evidence for issues #42-#47. Issue #48 remains the only supervised
Desktop/Scheduled smoke gate.

| Issue | Executable outcome                                                                                                                                       | Primary regression evidence                                                     |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| #42   | Trusted promotion, deterministic two-slot claim, immediate revalidation, fresh negative-evidence lease recovery                                          | `loop-domain`, `loop-dispatcher`, `loop-policy`, `loop-recovery`, `loop-github` |
| #43   | Typed Desktop capability handshake before every live claim; zero/one/two task launch with attempt deduplication                                          | `loop-cli`, `loop-dispatcher`, `codex-loop-dispatcher` skill                    |
| #44   | One branch/verified commit/draft PR, acknowledged push, GitHub-before-park finalization, crash-safe retry, no-change blocking                            | `loop-worker`, `loop-git`, `loop-verification`                                  |
| #45   | Commit-bound HMAC verdict, focused/full/build/config/mutation routing, diff safety, adversarial report enforcement                                       | `loop-verification`, `loop-policy`, mutation configuration                      |
| #46   | GitHub-authored exact rework request, unresolved post-commit feedback, same PR/branch, three-pass limit, secret-free rejection audit                     | `loop-github`, `loop-worker`, `loop-policy`                                     |
| #47   | Redacted health, task-backed reconciliation, safe supervised apply, merged completion, closed-unmerged attention, local conflict hold, audited retention | `loop-health`, `loop-recovery`, `loop-store`, `loop-dispatcher`, `loop-policy`  |

Repository gate:

```powershell
pnpm check
pnpm build
pnpm validate:config
pnpm test:mutation
git diff --check
```

The independent test reviewer must run `$adversarial-test-review` after the final test diff.

## Manual gate: #48

Follow `docs/operations.md` with the real two permanent Codex Desktop projects:

1. prove live dispatch refuses missing/stale/wrong capability evidence before a claim;
2. run two harmless isolated issues in parallel and leave a third queued;
3. verify one task, branch, commit, draft PR, lifecycle comment, and slot per attempt;
4. interrupt and recover one attempt from fresh evidence without duplication;
5. exercise one exact trusted rework request on the existing PR;
6. inspect redacted health, retention audit, and one supervised safe reconciliation;
7. leave all synthetic PRs open for human inspection.

No step authorizes opening Suno, using its authenticated profile, clicking **Create**, approving or
merging a PR, force-pushing, or destructively cleaning a worktree.
