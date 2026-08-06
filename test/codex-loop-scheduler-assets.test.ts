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
    expect(dispatcher).toContain('journal.status -eq "failed"');
    expect(dispatcher).toContain('Start-Recovery $journal "worker-terminal-failed"');
    expect(dispatcher).toContain("codex-needs-attention");
    expect(dispatcher).toContain("Disable-ScheduledTask");
    expect(dispatcher).not.toContain("Remove-Item -Recurse");
  });

  it("journals wrapper heartbeats and terminal state around Codex CLI", async () => {
    const wrapper = await asset("scripts/codex-loop/worker-wrapper.ps1");

    expect(wrapper).toContain("lastWrapperHeartbeatAt");
    expect(wrapper).toContain('Get-Command "codex.cmd" -CommandType Application');
    expect(wrapper).toContain("function Start-CodexChild");
    expect(wrapper).toContain('"-EncodedCommand", $encodedRunner');
    expect(wrapper).toContain('& $codexCli "exec" "--json" $prompt');
    expect(wrapper).not.toContain("ArgumentList $arguments");
    expect(wrapper).toContain("codex-launch-failed");
    expect(wrapper).toContain("Get-SafeLaunchDiagnostic");
    expect(wrapper).toContain("finally");
    expect(wrapper).toContain("preserve all existing useful changes");
  });

  it("avoids PowerShell 7-only JSON parsing so the installed task works on Windows PowerShell 5.1", async () => {
    const scripts = await Promise.all([
      asset("scripts/codex-loop/dispatch.ps1"),
      asset("scripts/codex-loop/worker-wrapper.ps1"),
      asset("scripts/codex-loop/install-scheduled-task.ps1"),
    ]);

    for (const script of scripts) {
      expect(script).not.toMatch(/ConvertFrom-Json\s+-AsHashtable/);
    }
  });

  it("can add recovery fields to legacy PowerShell JSON journals", async () => {
    const dispatcher = await asset("scripts/codex-loop/dispatch.ps1");

    expect(dispatcher).toContain("function Set-JsonField");
    expect(dispatcher).toContain(
      "Add-Member -NotePropertyName $Name -NotePropertyValue $FieldValue -Force",
    );
    expect(dispatcher).toContain('Set-JsonField $Journal "startedAt" $recoveryStartedAt');
    expect(dispatcher).not.toContain("$Journal.startedAt =");
  });
});
