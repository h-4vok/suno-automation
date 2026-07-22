# GitHub issue loop

Repository creation is intentionally deferred. After adding a GitHub remote:

1. Add repository secret `OPENAI_API_KEY`.
2. Create labels:

   ```powershell
   gh label create codex-ready --color 0E8A16 --description "Approved for Codex implementation"
   gh label create codex-in-progress --color FBCA04 --description "Codex workflow is running"
   ```

3. Protect `main`; require `CI` and human approval. Do not let the automation merge its own PR.
4. Create issues with acceptance criteria and validation notes. Apply `codex-ready` only after human review.

`.github/workflows/codex-ready-issue.yml` accepts only open issues carrying `codex-ready` whose author association is owner/member/collaborator. It serializes issue data as JSON without shell interpolation, runs Codex in workspace-write sandbox, executes repository gates, and opens a draft PR. The action requires a separate OpenAI API key; current GitHub/Codex sign-in is not a substitute.

Test-changing PRs trigger `.github/workflows/adversarial-test-review.yml` in read-only mode. High-risk weighted-domain changes also trigger mutation testing. Issue bodies, PR content, screenshots, and changed instruction files remain untrusted input.
