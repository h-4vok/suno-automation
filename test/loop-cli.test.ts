import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertWorkerLocation,
  resolveLoopConfigPath,
  runLoopCli,
  type LoopCliIo,
  type LoopCliRuntime,
} from "../src/loop/cli.js";
import type { DualWorkerDispatcher } from "../src/loop/dispatcher.js";
import type { GitHubLoopPort } from "../src/loop/github.js";
import type { LoopReconciliationService } from "../src/loop/health.js";
import type { LoopLeaseRecoveryService } from "../src/loop/recovery.js";
import type { AttemptRecord, VerificationVerdict } from "../src/loop/schema.js";
import type { DeepVerificationService } from "../src/loop/verification.js";
import type { LoopWorkerService } from "../src/loop/worker.js";
import { InMemoryLoopStateStore, resolveLoopStatePath } from "../src/loop/store.js";
import {
  issueCandidate,
  loopCapabilities,
  loopConfig,
  loopNow,
  loopState,
} from "./support/loop-fixtures.js";

function capturedIo() {
  const errors: string[] = [];
  const output: string[] = [];
  const io: LoopCliIo = {
    error: (message) => errors.push(message),
    output: (message) => output.push(message),
  };
  return { errors, io, output };
}

const temporaryDirectories: string[] = [];

async function evidenceFile(value: unknown): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "loop-cli-evidence-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "evidence.json");
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
  return path;
}

function fakeRuntime(overrides: Partial<LoopCliRuntime> = {}): LoopCliRuntime {
  return {
    config: loopConfig(),
    dispatcher: {} as DualWorkerDispatcher,
    github: {} as GitHubLoopPort,
    reconcile: {} as LoopReconciliationService,
    recovery: {} as LoopLeaseRecoveryService,
    store: new InMemoryLoopStateStore(),
    verification: {} as DeepVerificationService,
    worker: {} as LoopWorkerService,
    ...overrides,
  };
}

function attempt(stage: AttemptRecord["stage"] = "running"): AttemptRecord {
  return {
    attemptId: "attempt-42",
    branchName: "codex/42-safe",
    createdAt: loopNow,
    issueNumber: 42,
    issueUrl: "https://github.com/owner/repo/issues/42",
    leaseExpiresAt: "2026-07-23T14:00:00.000Z",
    repairPasses: 0,
    selectionReason: "priority-p0",
    slotId: "worker-1",
    stage,
    threadId: "thread-42",
    trigger: "implementation",
    updatedAt: loopNow,
  };
}

afterEach(async () => {
  delete process.env.CODEX_LOOP_VERIFICATION_KEY;
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("Codex loop CLI", () => {
  it("validates the committed example without printing machine identifiers", async () => {
    const capture = capturedIo();
    const result = await runLoopCli(
      ["validate-config", resolve(import.meta.dirname, "..", "config", "codex-loop.example.yaml")],
      capture.io,
    );

    expect(result).toBe(0);
    expect(capture.output).toEqual(["Valid Codex loop config: version=1 capacity=2 cadence=15m"]);
    expect(capture.output.join(" ")).not.toMatch(/worktree|project-worker|trusted/i);
  });

  it("resolves one canonical config and state from control and both worker directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "loop-shared-config-"));
    temporaryDirectories.push(root);
    const commonDirectory = join(root, "control", ".git");
    const canonicalConfig = join(commonDirectory, "codex-loop", "config.yaml");
    const canonicalState = join(commonDirectory, "codex-loop", "state");
    const gitCommonDirectory = vi.fn(() => Promise.resolve(commonDirectory));
    const directories = [join(root, "control"), join(root, "worker-1"), join(root, "worker-2")];

    const resolvedConfigs = await Promise.all(
      directories.map((cwd) =>
        resolveLoopConfigPath(undefined, {
          cwd,
          environment: {},
          gitCommonDirectory,
        }),
      ),
    );

    expect(resolvedConfigs).toEqual([canonicalConfig, canonicalConfig, canonicalConfig]);
    expect(
      resolvedConfigs.map((configPath) =>
        resolveLoopStatePath(
          {
            ...loopConfig(),
            stateDirectory: canonicalState,
          },
          configPath,
        ),
      ),
    ).toEqual([
      join(canonicalState, "state.json"),
      join(canonicalState, "state.json"),
      join(canonicalState, "state.json"),
    ]);
    expect(
      await resolveLoopConfigPath(join(root, "explicit.yaml"), {
        cwd: join(root, "worker-1"),
        environment: { CODEX_LOOP_CONFIG: join(root, "environment.yaml") },
        gitCommonDirectory,
      }),
    ).toBe(join(root, "explicit.yaml"));
  });

  it("does not parse a worker action as a positional config", async () => {
    const capture = capturedIo();
    const prepare = vi.fn(() => Promise.resolve(attempt("prepared")));
    const createRuntime = vi.fn(() =>
      Promise.resolve(
        fakeRuntime({
          worker: { prepare } as unknown as LoopWorkerService,
        }),
      ),
    );

    expect(
      await runLoopCli(["worker", "prepare", "attempt-42"], capture.io, {
        createRuntime,
        resolveConfigPath: () => Promise.resolve("C:\\shared\\codex-loop\\config.yaml"),
      }),
    ).toBe(0);
    expect(createRuntime).toHaveBeenCalledWith("C:\\shared\\codex-loop\\config.yaml");
    expect(prepare).toHaveBeenCalledWith("attempt-42");
  });

  it("binds a worker action to the canonical configured slot, not just its attempt id", async () => {
    const mismatch = await mkdtemp(join(tmpdir(), "loop-wrong-slot-"));
    temporaryDirectories.push(mismatch);
    const store = new InMemoryLoopStateStore({
      ...loopState(),
      attempts: [attempt()],
      slots: [
        {
          attemptId: "attempt-42",
          id: "worker-1",
          leaseExpiresAt: "2026-07-23T14:00:00.000Z",
          status: "running",
        },
        { id: "worker-2", status: "free" },
      ],
    });
    const runtime = fakeRuntime({
      config: {
        ...loopConfig(),
        slots: [
          { ...loopConfig().slots[0], worktreePath: process.cwd() },
          { ...loopConfig().slots[1], worktreePath: mismatch },
        ],
      },
      store,
    });

    await expect(assertWorkerLocation(runtime, "attempt-42")).resolves.toBeUndefined();
    await store.update((state) => {
      const record = state.attempts[0];
      if (record === undefined) throw new Error("fixture-attempt-missing");
      record.slotId = "worker-2";
      state.slots[0] = { id: "worker-1", status: "free" };
      state.slots[1] = {
        attemptId: "attempt-42",
        id: "worker-2",
        leaseExpiresAt: "2026-07-23T14:00:00.000Z",
        status: "running",
      };
    });
    await expect(assertWorkerLocation(runtime, "attempt-42")).rejects.toThrow(
      "worker-worktree-identity-conflict",
    );
  });

  it("keeps the worker skill on executable focused-test evidence, never a claimed boolean", async () => {
    const skill = await readFile(
      resolve(import.meta.dirname, "..", ".agents", "skills", "codex-loop-worker", "SKILL.md"),
      "utf8",
    );
    expect(skill).toContain("--focused-test");
    expect(skill).not.toContain("--focused-pass");

    const capture = capturedIo();
    const result = await runLoopCli(
      ["worker", "verify", "attempt-42", "--focused-pass"],
      capture.io,
      {
        createRuntime: () => Promise.resolve(fakeRuntime()),
        resolveConfigPath: () => Promise.resolve("C:\\shared\\codex-loop\\config.yaml"),
      },
    );
    expect(result).toBe(1);
    expect(capture.errors).toEqual(["focused-pass-evidence-not-accepted"]);
  });

  it("keeps setup inspection read-only until the explicit Apply gate", async () => {
    const setup = await readFile(
      resolve(import.meta.dirname, "..", "scripts", "setup-codex-loop-worktrees.ps1"),
      "utf8",
    );
    const applyGate = setup.indexOf("if (-not $Apply)");
    const fetch = setup.indexOf("git -C $control fetch --prune origin $BaseBranch");
    expect(applyGate).toBeGreaterThan(-1);
    expect(fetch).toBeGreaterThan(applyGate);
    expect(setup.slice(0, applyGate)).toContain("ls-remote --exit-code origin");
  });

  it("exposes machine-readable dry-run dispatch without mutating through the CLI", async () => {
    const capture = capturedIo();
    const dispatch = vi.fn(() =>
      Promise.resolve({
        assignments: [],
        blockers: { "48": ["manual-validation"] },
        dryRun: true,
        queueOrder: [],
        slots: [
          { id: "worker-1" as const, status: "free" as const },
          { id: "worker-2" as const, status: "free" as const },
        ],
        version: 1 as const,
      }),
    );
    const runtime = fakeRuntime({
      dispatcher: { dispatch } as unknown as DualWorkerDispatcher,
    });

    const result = await runLoopCli(
      ["dispatch", "ignored.yaml", "--dry-run", "--json"],
      capture.io,
      { createRuntime: () => Promise.resolve(runtime) },
    );

    expect(result).toBe(0);
    expect(dispatch).toHaveBeenCalledWith(true, undefined);
    expect(JSON.parse(capture.output[0] ?? "")).toMatchObject({
      blockers: { "48": ["manual-validation"] },
      dryRun: true,
    });
  });

  it("requires and routes typed Desktop capability evidence before live dispatch", async () => {
    const capture = capturedIo();
    const dispatch = vi.fn(() =>
      Promise.resolve({
        assignments: [],
        blockers: {},
        dryRun: false,
        queueOrder: [],
        slots: [],
        version: 1 as const,
      }),
    );
    const runtime = fakeRuntime({
      dispatcher: { dispatch } as unknown as DualWorkerDispatcher,
    });
    const capabilities = loopCapabilities();
    const directory = await mkdtemp(join(tmpdir(), "loop-capability-test-"));
    const capabilityPath = join(directory, "capability.json");
    await writeFile(capabilityPath, JSON.stringify(capabilities), { mode: 0o600 });
    try {
      expect(
        await runLoopCli(
          ["dispatch", "ignored.yaml", "--capabilities-file", capabilityPath, "--json"],
          capture.io,
          { createRuntime: () => Promise.resolve(runtime) },
        ),
      ).toBe(0);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
    expect(dispatch).toHaveBeenCalledWith(false, capabilities);
    expect([...capture.output, ...capture.errors].join(" ")).not.toContain(
      capabilities.projects[0].projectId,
    );
    expect(capture.output.join(" ")).not.toContain(capabilities.projects[1].projectId);
  });

  it("bounds malformed capability evidence without echoing local identifiers", async () => {
    const capture = capturedIo();
    const dispatch = vi.fn();
    const capabilityPath = await evidenceFile({
      projectId: "private-project-identifier",
    });

    expect(
      await runLoopCli(
        ["dispatch", "ignored.yaml", "--capabilities-file", capabilityPath],
        capture.io,
        {
          createRuntime: () =>
            Promise.resolve(
              fakeRuntime({
                dispatcher: { dispatch } as unknown as DualWorkerDispatcher,
              }),
            ),
        },
      ),
    ).toBe(1);
    expect(capture.errors).toEqual(["capability-evidence-invalid"]);
    expect(capture.errors.join(" ")).not.toContain("private-project-identifier");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("refuses reconciliation without the explicit dry-run boundary", async () => {
    const capture = capturedIo();

    const result = await runLoopCli(["reconcile", "ignored.yaml"], capture.io, {
      createRuntime: () => Promise.resolve(fakeRuntime()),
    });

    expect(result).toBe(1);
    expect(capture.errors).toEqual(["--task-evidence-file is required"]);
  });

  it("routes task acknowledgement and definitive launch failure", async () => {
    const capture = capturedIo();
    const acknowledgeThread = vi.fn(() => Promise.resolve());
    const failLaunch = vi.fn(() => Promise.resolve());
    const runtime = fakeRuntime({
      dispatcher: {
        acknowledgeThread,
        failLaunch,
      } as unknown as DualWorkerDispatcher,
    });
    const options = { createRuntime: () => Promise.resolve(runtime) };

    await expect(
      runLoopCli(["thread-ack", "ignored.yaml", "attempt-42", "thread-42"], capture.io, options),
    ).resolves.toBe(0);
    await expect(
      runLoopCli(["thread-fail", "ignored.yaml", "attempt-42"], capture.io, options),
    ).resolves.toBe(0);

    expect(acknowledgeThread).toHaveBeenCalledWith("attempt-42", "thread-42");
    expect(failLaunch).toHaveBeenCalledWith("attempt-42");
  });

  it("routes worker prepare, checkpoints, verification, and push", async () => {
    process.env.CODEX_LOOP_VERIFICATION_KEY = "a-strong-local-verification-key-12345";
    const capture = capturedIo();
    const prepare = vi.fn(() => Promise.resolve(attempt("prepared")));
    const checkpoint = vi.fn((_attemptId: string, stage: "implemented" | "committed") =>
      Promise.resolve(attempt(stage)),
    );
    const push = vi.fn(() => Promise.resolve(attempt("pushed")));
    const verdict: VerificationVerdict = {
      attemptId: "attempt-42",
      commands: [],
      commitSha: "abcdef1234567",
      createdAt: loopNow,
      findings: [],
      signature: "0".repeat(64),
      slotId: "worker-1",
      status: "pass",
      version: 1,
    };
    const verify = vi.fn(() => Promise.resolve(verdict));
    const runtime = fakeRuntime({
      verification: { verify } as unknown as DeepVerificationService,
      worker: { checkpoint, prepare, push } as unknown as LoopWorkerService,
    });
    const options = { createRuntime: () => Promise.resolve(runtime) };

    expect(
      await runLoopCli(["worker", "ignored.yaml", "prepare", "attempt-42"], capture.io, options),
    ).toBe(0);
    expect(
      await runLoopCli(
        [
          "worker",
          "ignored.yaml",
          "checkpoint",
          "attempt-42",
          "--stage",
          "committed",
          "--commit",
          "abcdef1234567",
        ],
        capture.io,
        options,
      ),
    ).toBe(0);
    expect(
      await runLoopCli(["worker", "ignored.yaml", "verify", "attempt-42"], capture.io, options),
    ).toBe(0);
    expect(
      await runLoopCli(["worker", "ignored.yaml", "push", "attempt-42"], capture.io, options),
    ).toBe(0);

    expect(prepare).toHaveBeenCalledWith("attempt-42");
    expect(checkpoint).toHaveBeenCalledWith("attempt-42", "committed", "abcdef1234567");
    expect(verify).toHaveBeenCalledWith(expect.objectContaining({ attemptId: "attempt-42" }));
    expect(push).toHaveBeenCalledWith("attempt-42", "a-strong-local-verification-key-12345");
  });

  it("routes review and attention finalization", async () => {
    process.env.CODEX_LOOP_VERIFICATION_KEY = "a-strong-local-verification-key-12345";
    const capture = capturedIo();
    const finalizedReview = {
      ...attempt("review"),
      pullRequest: {
        draft: true as const,
        number: 99,
        url: "https://github.com/owner/repo/pull/99",
      },
    };
    const finalizeReview = vi.fn(() => Promise.resolve(finalizedReview));
    const finalizeAttention = vi.fn(() =>
      Promise.resolve({ ...attempt("attention"), errorCode: "safe-failure" }),
    );
    const runtime = fakeRuntime({
      worker: {
        finalizeAttention,
        finalizeReview,
      } as unknown as LoopWorkerService,
    });
    const options = { createRuntime: () => Promise.resolve(runtime) };

    expect(
      await runLoopCli(
        ["finalize", "ignored.yaml", "attempt-42", "--result", "review"],
        capture.io,
        options,
      ),
    ).toBe(0);
    expect(
      await runLoopCli(
        [
          "finalize",
          "ignored.yaml",
          "attempt-42",
          "--result",
          "attention",
          "--error",
          "safe-failure",
        ],
        capture.io,
        options,
      ),
    ).toBe(0);

    expect(finalizeReview).toHaveBeenCalledOnce();
    expect(finalizeAttention).toHaveBeenCalledWith("attempt-42", "safe-failure");
  });

  it("prints redacted health and reconcile summaries", async () => {
    const healthCapture = capturedIo();
    const listQueue = vi.fn(() =>
      Promise.resolve([issueCandidate(50, { labels: ["codex-ready", "priority:p0"] })]),
    );
    const listTrackedIssues = vi.fn(() => Promise.resolve([]));
    const reconcileDryRun = vi.fn(() =>
      Promise.resolve({ dryRun: true as const, items: [], version: 1 as const }),
    );
    const runtime = fakeRuntime({
      github: {
        listQueue,
        listTrackedIssues,
      } as unknown as GitHubLoopPort,
      reconcile: { reconcileDryRun } as unknown as LoopReconciliationService,
    });
    const options = { createRuntime: () => Promise.resolve(runtime) };
    const taskEvidencePath = await evidenceFile([]);

    expect(await runLoopCli(["health", "ignored.yaml"], healthCapture.io, options)).toBe(0);
    expect(
      await runLoopCli(
        [
          "reconcile",
          "ignored.yaml",
          "--dry-run",
          "--json",
          "--task-evidence-file",
          taskEvidencePath,
        ],
        healthCapture.io,
        options,
      ),
    ).toBe(0);

    expect(healthCapture.output[0]).toBe(
      "Codex loop health: active=0/2 queued=1 stale=0 attention=0 contradictions=0",
    );
    expect(reconcileDryRun).toHaveBeenCalledWith([]);
  });

  it("routes recovery and supervised reconciliation from local evidence files", async () => {
    const capture = capturedIo();
    const recoveryEvidence = {
      actor: "owner",
      attemptId: "attempt-42",
      branchOperation: "absent",
      consistent: true,
      linkedPullRequest: "absent",
      observedAt: loopNow,
      process: "absent",
      task: "absent",
      version: 1,
      worktreeOperation: "absent",
    };
    const recoveryPath = await evidenceFile(recoveryEvidence);
    const taskPath = await evidenceFile([]);
    const recover = vi.fn(() =>
      Promise.resolve({
        attempt: attempt("attention"),
        decision: "safe-expired" as const,
      }),
    );
    const apply = vi
      .fn()
      .mockResolvedValueOnce({
        applied: true,
        item: {
          attemptId: "attempt-42",
          issueNumber: 42,
          recommendation: "complete-merged" as const,
          reasons: [],
          slotId: "worker-1" as const,
        },
        version: 1 as const,
      })
      .mockResolvedValueOnce({
        applied: false,
        item: {
          attemptId: "attempt-42",
          issueNumber: 42,
          recommendation: "finalize-review" as const,
          reasons: [],
          slotId: "worker-1" as const,
        },
        version: 1 as const,
      });
    const runtime = fakeRuntime({
      reconcile: { apply } as unknown as LoopReconciliationService,
      recovery: { recover } as unknown as LoopLeaseRecoveryService,
    });
    const options = { createRuntime: () => Promise.resolve(runtime) };

    expect(
      await runLoopCli(
        ["recover", "ignored.yaml", "attempt-42", "--evidence-file", recoveryPath],
        capture.io,
        options,
      ),
    ).toBe(0);
    expect(
      await runLoopCli(
        [
          "reconcile",
          "ignored.yaml",
          "--apply",
          "attempt-42",
          "--event",
          "reconcile-43",
          "--task-evidence-file",
          taskPath,
        ],
        capture.io,
        options,
      ),
    ).toBe(0);
    expect(
      await runLoopCli(
        [
          "reconcile",
          "ignored.yaml",
          "--apply",
          "attempt-42",
          "--event",
          "reconcile-42",
          "--task-evidence-file",
          taskPath,
        ],
        capture.io,
        options,
      ),
    ).toBe(2);
    expect(recover).toHaveBeenCalledWith("attempt-42", recoveryEvidence);
    expect(apply).toHaveBeenCalledWith("attempt-42", "reconcile-42", []);
    expect(apply).toHaveBeenCalledWith("attempt-42", "reconcile-43", []);
  });

  it("returns bounded errors for invalid worker/finalize commands and a missing key", async () => {
    const capture = capturedIo();
    const runtime = fakeRuntime({
      worker: {
        push: vi.fn(() => Promise.resolve(attempt("pushed"))),
      } as unknown as LoopWorkerService,
    });
    const options = { createRuntime: () => Promise.resolve(runtime) };

    expect(
      await runLoopCli(
        ["worker", "ignored.yaml", "checkpoint", "attempt-42", "--stage", "bad"],
        capture.io,
        options,
      ),
    ).toBe(1);
    expect(
      await runLoopCli(["worker", "ignored.yaml", "push", "attempt-42"], capture.io, options),
    ).toBe(1);
    expect(
      await runLoopCli(
        ["finalize", "ignored.yaml", "attempt-42", "--result", "bad"],
        capture.io,
        options,
      ),
    ).toBe(1);
    expect(capture.errors).toEqual([
      "invalid-checkpoint-stage",
      "verification-key-missing",
      "invalid-finalize-result",
    ]);
  });

  it("rejects malformed operator input before it can invoke a worker or dispatcher side effect", async () => {
    const capture = capturedIo();
    const dispatch = vi.fn();
    const prepare = vi.fn();
    const finalizeAttention = vi.fn();
    const runtime = fakeRuntime({
      dispatcher: { dispatch } as unknown as DualWorkerDispatcher,
      worker: { finalizeAttention, prepare } as unknown as LoopWorkerService,
    });
    const options = { createRuntime: () => Promise.resolve(runtime) };
    const invalidCommands = [
      [] as string[],
      ["dispatch", "ignored.yaml"] as string[],
      ["worker", "ignored.yaml"] as string[],
      ["worker", "ignored.yaml", "checkpoint", "attempt-42"] as string[],
      ["finalize", "ignored.yaml", "attempt-42", "--result", "attention"] as string[],
      ["reconcile", "ignored.yaml", "--dry-run"] as string[],
      ["unknown", "ignored.yaml"] as string[],
      ["health", "--config", "one.yaml", "--config", "two.yaml"] as string[],
    ];

    for (const command of invalidCommands) {
      expect(await runLoopCli(command, capture.io, options)).toBe(1);
    }

    expect(dispatch).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(finalizeAttention).not.toHaveBeenCalled();
    expect(capture.errors).toEqual(
      expect.arrayContaining([
        "codex-loop-command-required",
        "--capabilities-file is required",
        "Usage: worker <config> <prepare|checkpoint|verify|push> <attempt>",
        "worker checkpoint requires --stage implemented|committed",
        "attention finalization requires --error <safe-code>",
        "--task-evidence-file is required",
        "config-duplicate",
      ]),
    );
  });

  it("routes JSON health and dry-run reconciliation without an apply side effect", async () => {
    const capture = capturedIo();
    const listQueue = vi.fn(() => Promise.resolve([]));
    const dryRun = vi.fn(() =>
      Promise.resolve({
        dryRun: true,
        items: [
          {
            attemptId: "attempt-42",
            issueNumber: 42,
            recommendation: "move-to-attention",
            reasons: ["worktree-dirty"],
            slotId: "worker-1",
          },
        ],
        version: 1,
      }),
    );
    const taskPath = await evidenceFile([]);
    const runtime = fakeRuntime({
      github: { listQueue } as unknown as GitHubLoopPort,
      reconcile: { reconcileDryRun: dryRun } as unknown as LoopReconciliationService,
    });
    const options = { createRuntime: () => Promise.resolve(runtime) };

    await expect(
      runLoopCli(["health", "ignored.yaml", "--json"], capture.io, options),
    ).resolves.toBe(0);
    await expect(
      runLoopCli(
        ["reconcile", "ignored.yaml", "--dry-run", "--json", "--task-evidence-file", taskPath],
        capture.io,
        options,
      ),
    ).resolves.toBe(2);
    expect(listQueue).toHaveBeenCalledOnce();
    expect(dryRun).toHaveBeenCalledWith([]);
    expect(capture.output.at(-1)).toContain("move-to-attention");
  });
});
