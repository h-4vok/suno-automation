import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FileGitMetadataCoordinator,
  GitCommandError,
  LocalGitWorktreeAdapter,
  type GitCommandRunner,
} from "../src/loop/git.js";
import type { AttemptRecord, LoopSlotConfig } from "../src/loop/schema.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

class GitSimulation implements GitCommandRunner {
  readonly branchOwners = new Map<string, string>();
  readonly calls: string[][] = [];
  readonly localRefs = new Set<string>();
  readonly remoteRefs = new Set<string>();
  readonly remoteHeads = new Map<string, string>();
  base = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  currentBranch = "";
  dirty = false;
  divergence = "0 0";
  failPush = false;
  head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  inside = true;

  run(cwd: string, args: readonly string[]): Promise<{ readonly stdout: string }> {
    this.calls.push([...args]);
    const command = args.join(" ");
    if (command === "rev-parse --is-inside-work-tree") {
      return Promise.resolve({ stdout: this.inside ? "true" : "false" });
    }
    if (command === "rev-parse --path-format=absolute --git-common-dir") {
      return Promise.resolve({ stdout: join(cwd, ".git-common") });
    }
    if (command === "status --porcelain=v1 --untracked-files=all") {
      return Promise.resolve({ stdout: this.dirty ? " M unsafe.ts" : "" });
    }
    if (args[0] === "fetch") return Promise.resolve({ stdout: "" });
    if (args[0] === "ls-remote") {
      const ref = args.at(-1) ?? "";
      const branch = ref.replace("refs/heads/", "");
      if (branch === "main") {
        return Promise.resolve({ stdout: `${this.base}\trefs/heads/main` });
      }
      const sha = this.remoteHeads.get(branch);
      return Promise.resolve({
        stdout: sha === undefined ? "" : `${sha}\trefs/heads/${branch}`,
      });
    }
    if (args[0] === "config" && args[1] === "--local") {
      const key = args.at(-2);
      if (args[2] === "--get") {
        const owner = this.branchOwners.get(args[3] ?? "");
        return owner === undefined
          ? Promise.reject(new GitCommandError("missing-config"))
          : Promise.resolve({ stdout: owner });
      }
      const value = args.at(-1);
      if (key === undefined || value === undefined) {
        return Promise.reject(new GitCommandError("invalid-config"));
      }
      this.branchOwners.set(key, value);
      return Promise.resolve({ stdout: "" });
    }
    if (command === "branch --show-current") {
      return Promise.resolve({ stdout: this.currentBranch });
    }
    if (command === "rev-parse HEAD") return Promise.resolve({ stdout: this.head });
    if (command === "rev-parse origin/main") return Promise.resolve({ stdout: this.base });
    if (args[0] === "rev-parse" && args[1]?.startsWith("origin/")) {
      const branch = args[1].slice("origin/".length);
      const sha = this.remoteHeads.get(branch);
      return sha === undefined
        ? Promise.reject(new GitCommandError("missing-ref"))
        : Promise.resolve({ stdout: sha });
    }
    if (args[0] === "show-ref") {
      const ref = args.at(-1);
      const exists = ref !== undefined && (this.localRefs.has(ref) || this.remoteRefs.has(ref));
      return exists
        ? Promise.resolve({ stdout: "" })
        : Promise.reject(new GitCommandError("missing-ref"));
    }
    if (args[0] === "switch") {
      if (args[1] === "--detach") {
        this.currentBranch = "";
        this.head = this.base;
      } else if (args[1] === "--track") {
        const branch = args[3];
        if (branch === undefined) return Promise.reject(new Error("branch missing"));
        this.currentBranch = branch;
        this.localRefs.add(`refs/heads/${branch}`);
        this.head = this.remoteHeads.get(branch) ?? this.head;
      } else if (args[1] === "-c") {
        const branch = args[2];
        if (branch === undefined) return Promise.reject(new Error("branch missing"));
        this.currentBranch = branch;
        this.localRefs.add(`refs/heads/${branch}`);
      } else {
        const branch = args[1];
        if (branch === undefined) return Promise.reject(new Error("branch missing"));
        this.currentBranch = branch;
      }
      return Promise.resolve({ stdout: "" });
    }
    if (args[0] === "rev-list") return Promise.resolve({ stdout: this.divergence });
    if (args[0] === "push") {
      if (this.failPush) return Promise.reject(new GitCommandError("network"));
      const branch = args.at(-1);
      if (branch === undefined) return Promise.reject(new Error("branch missing"));
      this.remoteRefs.add(`refs/remotes/origin/${branch}`);
      this.remoteHeads.set(branch, this.head);
      return Promise.resolve({ stdout: "" });
    }
    return Promise.reject(new Error(`Unexpected Git command: ${command}`));
  }
}

async function slot(): Promise<LoopSlotConfig> {
  const worktreePath = await mkdtemp(join(tmpdir(), "loop-git-"));
  directories.push(worktreePath);
  return { id: "worker-1", projectId: "project-1", worktreePath };
}

function attempt(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    attemptId: "attempt-42",
    branchName: "codex/42-safe",
    createdAt: "2026-07-23T12:00:00.000Z",
    issueNumber: 42,
    issueUrl: "https://github.com/owner/repo/issues/42",
    leaseExpiresAt: "2026-07-23T14:00:00.000Z",
    repairPasses: 0,
    selectionReason: "priority-p0",
    slotId: "worker-1",
    stage: "running",
    threadId: "thread-42",
    trigger: "implementation",
    updatedAt: "2026-07-23T12:00:00.000Z",
    ...overrides,
  };
}

describe("local Git worktree adapter", () => {
  it("serializes shared git metadata changes and removes only its own lock", async () => {
    const commonDirectory = await mkdtemp(join(tmpdir(), "loop-git-common-"));
    directories.push(commonDirectory);
    const runner: GitCommandRunner = {
      run: () => Promise.resolve({ stdout: commonDirectory }),
    };
    const coordinator = new FileGitMetadataCoordinator(runner);
    let observedLock = false;

    const result = await coordinator.runExclusive(commonDirectory, async () => {
      const lock = join(commonDirectory, "codex-loop", "git-metadata.lock");
      await expect(access(lock)).resolves.toBeUndefined();
      observedLock = true;
      return "completed";
    });

    expect(result).toBe("completed");
    expect(observedLock).toBe(true);
    await expect(
      access(join(commonDirectory, "codex-loop", "git-metadata.lock")),
    ).rejects.toThrow();
  });

  it("fails closed when shared git metadata lock content is malformed", async () => {
    const commonDirectory = await mkdtemp(join(tmpdir(), "loop-git-corrupt-lock-"));
    directories.push(commonDirectory);
    const lockDirectory = join(commonDirectory, "codex-loop");
    await mkdir(lockDirectory, { recursive: true });
    await writeFile(join(lockDirectory, "git-metadata.lock"), "not-json", "utf8");
    const coordinator = new FileGitMetadataCoordinator({
      run: () => Promise.resolve({ stdout: commonDirectory }),
    });
    const operation = vi.fn(() => Promise.resolve());

    await expect(coordinator.runExclusive(commonDirectory, operation)).rejects.toThrow(
      "git-metadata-lock-corrupt",
    );
    expect(operation).not.toHaveBeenCalled();
  });

  it("fails closed for missing, dirty, non-worktree, owned-branch, and stale-base slots", async () => {
    const simulation = new GitSimulation();
    const adapter = new LocalGitWorktreeAdapter(simulation);
    const missing = {
      id: "worker-1" as const,
      projectId: "p1",
      worktreePath: join(tmpdir(), "definitely-missing-loop-worktree"),
    };
    await expect(adapter.inspect(missing, "main")).resolves.toEqual({
      reason: "worktree-missing",
      safe: false,
    });

    const configured = await slot();
    simulation.inside = false;
    await expect(adapter.inspect(configured, "main")).resolves.toMatchObject({
      reason: "not-a-worktree",
      safe: false,
    });
    simulation.inside = true;
    simulation.dirty = true;
    await expect(adapter.inspect(configured, "main")).resolves.toMatchObject({
      reason: "worktree-dirty",
      safe: false,
    });
    simulation.dirty = false;
    simulation.currentBranch = "codex/old";
    await expect(adapter.inspect(configured, "main")).resolves.toMatchObject({
      reason: "worktree-on-owned-branch",
      safe: false,
    });
    simulation.currentBranch = "";
    simulation.head = "old-base";
    await expect(adapter.inspect(configured, "main")).resolves.toMatchObject({
      reason: "worktree-base-stale",
      safe: false,
    });
  });

  it("prepares a new branch, pushes with acknowledgement, and parks safely", async () => {
    const simulation = new GitSimulation();
    const adapter = new LocalGitWorktreeAdapter(simulation);
    const configured = await slot();
    const record = attempt();

    await expect(adapter.inspect(configured, "main")).resolves.toMatchObject({ safe: true });
    const prepared = await adapter.prepare(configured, "main", record);
    expect(prepared).toEqual({
      branchName: "codex/42-safe",
      commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    simulation.head = "abcdef1234567";
    await expect(adapter.push(configured, record)).resolves.toEqual({
      branchName: "codex/42-safe",
      commitSha: "abcdef1234567",
    });
    await adapter.park(configured, "main", {
      ...record,
      commitSha: "abcdef1234567",
    });

    expect(simulation.currentBranch).toBe("");
    expect(simulation.calls.some((args) => args.includes("reset"))).toBe(false);
    expect(simulation.calls.some((args) => args.includes("clean"))).toBe(false);
    expect(simulation.calls.some((args) => args.includes("--force"))).toBe(false);
  });

  it("retries parking from detached state, rejects dirt, and follows an advanced base safely", async () => {
    const simulation = new GitSimulation();
    const adapter = new LocalGitWorktreeAdapter(simulation);
    const configured = await slot();
    const record = attempt({ commitSha: "abcdef1234567", stage: "pr-linked" });
    simulation.currentBranch = "";
    simulation.head = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    simulation.base = "cccccccccccccccccccccccccccccccccccccccc";
    simulation.remoteHeads.set("codex/42-safe", "abcdef1234567");

    simulation.dirty = true;
    await expect(adapter.park(configured, "main", record)).rejects.toThrow("uncommitted-changes");

    simulation.dirty = false;
    await expect(adapter.park(configured, "main", record)).resolves.toBeUndefined();
    expect(simulation.currentBranch).toBe("");
    expect(simulation.head).toBe("cccccccccccccccccccccccccccccccccccccccc");
    expect(simulation.calls.some((args) => args.join(" ") === "switch --detach origin/main")).toBe(
      true,
    );
    expect(simulation.calls.some((args) => args.includes("reset"))).toBe(false);
    expect(simulation.calls.some((args) => args.includes("clean"))).toBe(false);
  });

  it("refuses to park when the branch advanced beyond the verified commit", async () => {
    const simulation = new GitSimulation();
    const adapter = new LocalGitWorktreeAdapter(simulation);
    const configured = await slot();
    simulation.currentBranch = "codex/42-safe";
    simulation.head = "advanced1234567";
    simulation.remoteHeads.set("codex/42-safe", "advanced1234567");
    simulation.branchOwners.set("branch.codex/42-safe.codex-loop-attempt", "attempt-42");

    await expect(
      adapter.park(configured, "main", attempt({ commitSha: "abcdef1234567", stage: "pr-linked" })),
    ).rejects.toThrow("parked-remote-commit-conflict");
    expect(simulation.currentBranch).toBe("codex/42-safe");
  });

  it("recovers an ambiguous push only when the remote commit proves success", async () => {
    const simulation = new GitSimulation();
    const adapter = new LocalGitWorktreeAdapter(simulation);
    const configured = await slot();
    const record = attempt();
    await adapter.prepare(configured, "main", record);
    simulation.head = "abcdef1234567";
    simulation.failPush = true;
    simulation.remoteHeads.set("codex/42-safe", "abcdef1234567");

    await expect(adapter.push(configured, record)).resolves.toEqual({
      branchName: "codex/42-safe",
      commitSha: "abcdef1234567",
    });

    simulation.remoteHeads.set("codex/42-safe", "different");
    await expect(adapter.push(configured, record)).rejects.toThrow("push-ambiguous");
  });

  it("reuses only the recorded rework branch and rejects divergence/collision", async () => {
    const simulation = new GitSimulation();
    const adapter = new LocalGitWorktreeAdapter(simulation);
    const configured = await slot();
    const rework = attempt({ trigger: "rework" });

    await expect(adapter.prepare(configured, "main", rework)).rejects.toThrow(
      "rework-branch-missing",
    );

    simulation.remoteRefs.add("refs/remotes/origin/codex/42-safe");
    simulation.remoteHeads.set("codex/42-safe", "abcdef1234567");
    await expect(adapter.prepare(configured, "main", rework)).resolves.toMatchObject({
      branchName: "codex/42-safe",
    });

    simulation.currentBranch = "";
    simulation.head = simulation.base;
    simulation.localRefs.delete("refs/heads/codex/42-safe");
    await expect(
      adapter.prepare(configured, "main", attempt({ trigger: "implementation" })),
    ).rejects.toThrow("branch-collision");

    simulation.currentBranch = "codex/42-safe";
    simulation.localRefs.add("refs/heads/codex/42-safe");
    simulation.divergence = "0 1";
    await expect(adapter.prepare(configured, "main", rework)).rejects.toThrow("branch-diverged");
  });

  it("refuses unsafe branch ownership and publication states before any forceful recovery", async () => {
    const configured = await slot();
    const noBranch = new LocalGitWorktreeAdapter(new GitSimulation());
    await expect(
      noBranch.prepare(configured, "main", attempt({ branchName: undefined })),
    ).rejects.toThrow("branch-not-recorded");

    const ownership = new GitSimulation();
    ownership.localRefs.add("refs/heads/codex/42-safe");
    ownership.branchOwners.set("branch.codex/42-safe.codex-loop-attempt", "other-attempt");
    const ownedAdapter = new LocalGitWorktreeAdapter(ownership);
    await expect(ownedAdapter.prepare(configured, "main", attempt())).rejects.toThrow(
      "branch-ownership-conflict",
    );

    const publish = new GitSimulation();
    const publishAdapter = new LocalGitWorktreeAdapter(publish);
    const record = attempt();
    await publishAdapter.prepare(configured, "main", record);
    publish.currentBranch = "codex/not-this-attempt";
    await expect(publishAdapter.push(configured, record)).rejects.toThrow(
      "branch-ownership-conflict",
    );
    publish.currentBranch = "codex/42-safe";
    publish.dirty = true;
    await expect(publishAdapter.push(configured, record)).rejects.toThrow("uncommitted-changes");
    expect(publish.calls.some((args) => args.includes("--force"))).toBe(false);
  });

  it("refreshes only a clean detached stale worktree and otherwise preserves it for attention", async () => {
    const simulation = new GitSimulation();
    const adapter = new LocalGitWorktreeAdapter(simulation);
    const configured = await slot();
    simulation.head = "old-base";
    await expect(adapter.refresh(configured, "main")).resolves.toMatchObject({ safe: true });
    expect(simulation.head).toBe(simulation.base);

    simulation.head = "another-old-base";
    simulation.dirty = true;
    await expect(adapter.refresh(configured, "main")).resolves.toMatchObject({
      reason: "worktree-dirty",
      safe: false,
    });
    expect(simulation.head).toBe("another-old-base");
  });
});
