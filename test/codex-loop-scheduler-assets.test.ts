import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
interface SchedulerExample {
  version: number;
  worker: { id: string; worktreePath: string };
  scheduler: { maxTicks: number; maxRecoveryAttempts: number };
}

async function asset(path: string) {
  return readFile(resolve(root, path), "utf8");
}

describe("one-worker Windows scheduler assets", () => {
  it("keeps the scheduler configuration reproducible and bounded", async () => {
    const config = JSON.parse(
      await asset("config/codex-loop.scheduler.example.json"),
    ) as unknown as SchedulerExample;

    expect(config).toMatchObject({
      version: 1,
      worker: { id: "worker-1" },
      scheduler: { maxTicks: 10, maxRecoveryAttempts: 5 },
    });
    expect(config.worker.worktreePath).toContain("replace");
  });

  it("checks the slot before GitHub selection and leaves recovery work intact", async () => {
    const dispatcher = await asset("scripts/codex-loop/dispatch.ps1");
    const busyCheck = dispatcher.indexOf(
      'if ($null -ne $journal -and $journal.status -eq "running")',
    );
    const issueQuery = dispatcher.indexOf("gh issue list");

    expect(busyCheck).toBeGreaterThan(-1);
    expect(issueQuery).toBeGreaterThan(busyCheck);
    expect(dispatcher).toContain("maxRecoveryAttempts");
    expect(dispatcher).toContain('journal.status -eq "launching"');
    expect(dispatcher).toContain("codex-needs-attention");
    expect(dispatcher).toContain("Disable-ScheduledTask");
    expect(dispatcher).not.toContain("Remove-Item -Recurse");
  });

  it("journals wrapper heartbeats and terminal state around Codex CLI", async () => {
    const wrapper = await asset("scripts/codex-loop/worker-wrapper.ps1");

    expect(wrapper).toContain("lastWrapperHeartbeatAt");
    expect(wrapper).toContain('Start-Process -FilePath "codex"');
    expect(wrapper).toContain("finally");
    expect(wrapper).toContain("preserve all existing useful changes");
  });
});
