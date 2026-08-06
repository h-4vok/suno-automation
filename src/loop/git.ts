import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

import type { SlotSafetyEvidence, SlotSafetyPort } from "./dispatcher.js";
import type { AttemptRecord, LoopSlotConfig } from "./schema.js";

const execFileAsync = promisify(execFile);

export class GitCommandError extends Error {
  readonly safeCode: string;

  constructor(safeCode: string) {
    super(`Git operation failed (${safeCode}).`);
    this.name = "GitCommandError";
    this.safeCode = safeCode;
  }
}

interface GitResult {
  readonly stdout: string;
}

export interface GitCommandRunner {
  run(cwd: string, args: readonly string[]): Promise<GitResult>;
}

export class ExecFileGitRunner implements GitCommandRunner {
  async run(cwd: string, args: readonly string[]): Promise<GitResult> {
    try {
      const result = await execFileAsync("git", [...args], {
        cwd,
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
        shell: false,
        windowsHide: true,
      });
      return { stdout: result.stdout.trim() };
    } catch {
      throw new GitCommandError("git-command-failed");
    }
  }
}

export interface PublicationEvidence {
  readonly branchName: string;
  readonly commitSha: string;
}

export interface WorkerGitPort extends SlotSafetyPort {
  park(slot: LoopSlotConfig, baseBranch: string, attempt: AttemptRecord): Promise<void>;
  prepare(
    slot: LoopSlotConfig,
    baseBranch: string,
    attempt: AttemptRecord,
  ): Promise<PublicationEvidence>;
  publicationEvidence(slot: LoopSlotConfig, attempt: AttemptRecord): Promise<PublicationEvidence>;
  push(slot: LoopSlotConfig, attempt: AttemptRecord): Promise<PublicationEvidence>;
}

export interface GitMetadataCoordinator {
  runExclusive<T>(cwd: string, operation: () => Promise<T>): Promise<T>;
}

interface GitMetadataLockRecord {
  readonly expiresAt: string;
  readonly pid: number;
  readonly token: string;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function parseMetadataLock(value: string): GitMetadataLockRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new GitCommandError("git-metadata-lock-corrupt");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("expiresAt" in parsed) ||
    typeof parsed.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(parsed.expiresAt)) ||
    !("pid" in parsed) ||
    !Number.isInteger(parsed.pid) ||
    (parsed.pid as number) <= 0 ||
    !("token" in parsed) ||
    typeof parsed.token !== "string" ||
    !/^[a-f\d-]{20,}$/i.test(parsed.token)
  ) {
    throw new GitCommandError("git-metadata-lock-corrupt");
  }
  return parsed as unknown as GitMetadataLockRecord;
}

export class FileGitMetadataCoordinator implements GitMetadataCoordinator {
  readonly #runner: GitCommandRunner;

  constructor(runner: GitCommandRunner) {
    this.#runner = runner;
  }

  async runExclusive<T>(cwd: string, operation: () => Promise<T>): Promise<T> {
    const commonResult = await this.#runner.run(cwd, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    const commonDirectory = isAbsolute(commonResult.stdout)
      ? commonResult.stdout
      : resolve(cwd, commonResult.stdout);
    const lockDirectory = join(commonDirectory, "codex-loop");
    const lockPath = join(lockDirectory, "git-metadata.lock");
    await mkdir(lockDirectory, { mode: 0o700, recursive: true });
    const token = randomUUID();
    const record: GitMetadataLockRecord = {
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
      pid: process.pid,
      token,
    };
    for (let attempt = 0; attempt < 400; attempt += 1) {
      try {
        const handle = await open(lockPath, "wx", 0o600);
        try {
          await handle.writeFile(JSON.stringify(record), "utf8");
        } finally {
          await handle.close();
        }
        let result: T | undefined;
        let operationError: unknown;
        try {
          result = await operation();
        } catch (error: unknown) {
          operationError = error;
        }
        let releaseError: unknown;
        try {
          const current = parseMetadataLock(await readFile(lockPath, "utf8"));
          if (current.token !== token) {
            releaseError = new GitCommandError("git-metadata-lock-ownership-lost");
          } else {
            await unlink(lockPath);
          }
        } catch {
          releaseError = new GitCommandError("git-metadata-lock-corrupt");
        }
        if (operationError instanceof Error) throw operationError;
        if (operationError !== undefined)
          throw new GitCommandError("git-metadata-operation-failed");
        if (releaseError instanceof Error) throw releaseError;
        if (releaseError !== undefined) throw new GitCommandError("git-metadata-release-failed");
        return result as T;
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let existing: GitMetadataLockRecord;
        try {
          existing = parseMetadataLock(await readFile(lockPath, "utf8"));
        } catch {
          throw new GitCommandError("git-metadata-lock-corrupt");
        }
        const expiresAt = Date.parse(existing.expiresAt);
        if (
          Number.isInteger(existing.pid) &&
          typeof existing.token === "string" &&
          Number.isFinite(expiresAt) &&
          expiresAt <= Date.now() &&
          !processAlive(existing.pid)
        ) {
          try {
            await rename(lockPath, `${lockPath}.stale-${randomUUID()}`);
          } catch (renameError: unknown) {
            if ((renameError as NodeJS.ErrnoException).code !== "ENOENT") throw renameError;
          }
          continue;
        }
        await new Promise<void>((accept) => {
          setTimeout(accept, 25);
        });
      }
    }
    throw new GitCommandError("git-metadata-lock-busy");
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export class LocalGitWorktreeAdapter implements WorkerGitPort {
  readonly #metadata: GitMetadataCoordinator;
  readonly #runner: GitCommandRunner;

  constructor(
    runner: GitCommandRunner = new ExecFileGitRunner(),
    metadata?: GitMetadataCoordinator,
  ) {
    this.#runner = runner;
    this.#metadata = metadata ?? new FileGitMetadataCoordinator(runner);
  }

  async inspect(slot: LoopSlotConfig, baseBranch: string): Promise<SlotSafetyEvidence> {
    if (!(await exists(slot.worktreePath))) return { reason: "worktree-missing", safe: false };
    let canonicalPath: string;
    try {
      canonicalPath = await realpath(slot.worktreePath);
    } catch {
      return { reason: "worktree-identity-unknown", safe: false };
    }
    const unsafe = (reason: string): SlotSafetyEvidence => ({
      canonicalPath,
      reason,
      safe: false,
    });
    try {
      const inside = await this.#runner.run(slot.worktreePath, [
        "rev-parse",
        "--is-inside-work-tree",
      ]);
      if (inside.stdout !== "true") return unsafe("not-a-worktree");
      const status = await this.#runner.run(slot.worktreePath, [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ]);
      if (status.stdout !== "") return unsafe("worktree-dirty");
      const branch = await this.#runner.run(slot.worktreePath, ["branch", "--show-current"]);
      if (branch.stdout !== "" && branch.stdout !== baseBranch) {
        return unsafe("worktree-on-owned-branch");
      }
      const head = await this.#runner.run(slot.worktreePath, ["rev-parse", "HEAD"]);
      const base = await this.#runner.run(slot.worktreePath, [
        "ls-remote",
        "--heads",
        "origin",
        `refs/heads/${baseBranch}`,
      ]);
      const remoteBaseHead = base.stdout.split(/\s+/)[0];
      if (!/^[a-f\d]{7,64}$/i.test(remoteBaseHead ?? "")) {
        return unsafe("worktree-base-unknown");
      }
      if (head.stdout !== remoteBaseHead) return unsafe("worktree-base-stale");
      return { canonicalPath, safe: true };
    } catch (error: unknown) {
      return unsafe(
        error instanceof GitCommandError ? error.safeCode : "worktree-inspection-failed",
      );
    }
  }

  async refresh(slot: LoopSlotConfig, baseBranch: string): Promise<SlotSafetyEvidence> {
    const initial = await this.inspect(slot, baseBranch);
    if (initial.safe || initial.reason !== "worktree-base-stale") return initial;
    return this.#metadata.runExclusive(slot.worktreePath, () =>
      this.#refreshUnlocked(slot, baseBranch, initial),
    );
  }

  async #refreshUnlocked(
    slot: LoopSlotConfig,
    baseBranch: string,
    initial: SlotSafetyEvidence,
  ): Promise<SlotSafetyEvidence> {
    const [inside, status, branch] = await Promise.all([
      this.#runner.run(slot.worktreePath, ["rev-parse", "--is-inside-work-tree"]),
      this.#runner.run(slot.worktreePath, ["status", "--porcelain=v1", "--untracked-files=all"]),
      this.#runner.run(slot.worktreePath, ["branch", "--show-current"]),
    ]);
    if (
      inside.stdout !== "true" ||
      status.stdout !== "" ||
      (branch.stdout !== "" && branch.stdout !== baseBranch)
    ) {
      return {
        ...(initial.canonicalPath === undefined ? {} : { canonicalPath: initial.canonicalPath }),
        reason: "worktree-refresh-precondition-failed",
        safe: false,
      };
    }
    await this.#runner.run(slot.worktreePath, ["fetch", "origin", baseBranch]);
    await this.#runner.run(slot.worktreePath, ["switch", "--detach", `origin/${baseBranch}`]);
    return this.inspect(slot, baseBranch);
  }

  async prepare(
    slot: LoopSlotConfig,
    baseBranch: string,
    attempt: AttemptRecord,
  ): Promise<PublicationEvidence> {
    return this.#metadata.runExclusive(slot.worktreePath, () =>
      this.#prepareUnlocked(slot, baseBranch, attempt),
    );
  }

  async #prepareUnlocked(
    slot: LoopSlotConfig,
    baseBranch: string,
    attempt: AttemptRecord,
  ): Promise<PublicationEvidence> {
    if (attempt.branchName === undefined) throw new GitCommandError("branch-not-recorded");
    await this.#runner.run(slot.worktreePath, ["fetch", "origin", baseBranch]);
    let safety = await this.inspect(slot, baseBranch);
    if (safety.reason === "worktree-base-stale") {
      safety = await this.#refreshUnlocked(slot, baseBranch, safety);
    }
    const current = await this.#runner.run(slot.worktreePath, ["branch", "--show-current"]);
    if (!safety.safe && current.stdout !== attempt.branchName) {
      throw new GitCommandError(safety.reason ?? "unsafe-worktree");
    }

    const targetExists = await this.#refExists(
      slot.worktreePath,
      `refs/heads/${attempt.branchName}`,
    );
    const remoteListing = await this.#runner.run(slot.worktreePath, [
      "ls-remote",
      "--heads",
      "origin",
      `refs/heads/${attempt.branchName}`,
    ]);
    const remoteExists = remoteListing.stdout !== "";
    if (remoteExists) {
      await this.#runner.run(slot.worktreePath, ["fetch", "origin", attempt.branchName]);
    }
    if (attempt.trigger === "implementation" && remoteExists) {
      throw new GitCommandError("branch-collision");
    }
    if (attempt.trigger === "implementation") {
      const owner = await this.#branchOwner(slot.worktreePath, attempt.branchName);
      if (owner !== undefined && owner !== attempt.attemptId) {
        throw new GitCommandError("branch-ownership-conflict");
      }
      if ((targetExists || current.stdout === attempt.branchName) && owner === undefined) {
        throw new GitCommandError("branch-ownership-unproven");
      }
      if (!targetExists && current.stdout !== attempt.branchName && owner === undefined) {
        await this.#runner.run(slot.worktreePath, [
          "config",
          "--local",
          `branch.${attempt.branchName}.codex-loop-attempt`,
          attempt.attemptId,
        ]);
      }
    }
    if (current.stdout !== attempt.branchName) {
      if (attempt.trigger === "rework" && !remoteExists) {
        throw new GitCommandError("rework-branch-missing");
      }
      if (targetExists) {
        await this.#runner.run(slot.worktreePath, ["switch", attempt.branchName]);
      } else if (remoteExists) {
        await this.#runner.run(slot.worktreePath, [
          "switch",
          "--track",
          "-c",
          attempt.branchName,
          `origin/${attempt.branchName}`,
        ]);
      } else {
        await this.#runner.run(slot.worktreePath, [
          "switch",
          "-c",
          attempt.branchName,
          `origin/${baseBranch}`,
        ]);
      }
    }
    const status = await this.#runner.run(slot.worktreePath, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]);
    if (status.stdout !== "") throw new GitCommandError("worktree-dirty");
    if (remoteExists) {
      const divergence = await this.#runner.run(slot.worktreePath, [
        "rev-list",
        "--left-right",
        "--count",
        `${attempt.branchName}...origin/${attempt.branchName}`,
      ]);
      const [ahead, behind] = divergence.stdout.split(/\s+/).map(Number);
      if (behind !== 0 || (attempt.trigger === "rework" && ahead !== 0)) {
        throw new GitCommandError("branch-diverged");
      }
    }
    return {
      branchName: attempt.branchName,
      commitSha: (await this.#runner.run(slot.worktreePath, ["rev-parse", "HEAD"])).stdout,
    };
  }

  async push(slot: LoopSlotConfig, attempt: AttemptRecord): Promise<PublicationEvidence> {
    return this.#metadata.runExclusive(slot.worktreePath, () => this.#pushUnlocked(slot, attempt));
  }

  async #pushUnlocked(slot: LoopSlotConfig, attempt: AttemptRecord): Promise<PublicationEvidence> {
    if (attempt.branchName === undefined) throw new GitCommandError("branch-not-recorded");
    const branch = await this.#runner.run(slot.worktreePath, ["branch", "--show-current"]);
    if (branch.stdout !== attempt.branchName)
      throw new GitCommandError("branch-ownership-conflict");
    await this.#assertBranchOwner(slot.worktreePath, attempt);
    const status = await this.#runner.run(slot.worktreePath, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]);
    if (status.stdout !== "") throw new GitCommandError("uncommitted-changes");
    try {
      await this.#runner.run(slot.worktreePath, [
        "push",
        "--set-upstream",
        "origin",
        attempt.branchName,
      ]);
    } catch {
      try {
        return await this.#publicationEvidenceUnlocked(slot, attempt);
      } catch {
        throw new GitCommandError("push-ambiguous");
      }
    }
    return this.#publicationEvidenceUnlocked(slot, attempt);
  }

  async publicationEvidence(
    slot: LoopSlotConfig,
    attempt: AttemptRecord,
  ): Promise<PublicationEvidence> {
    return this.#metadata.runExclusive(slot.worktreePath, () =>
      this.#publicationEvidenceUnlocked(slot, attempt),
    );
  }

  async #publicationEvidenceUnlocked(
    slot: LoopSlotConfig,
    attempt: AttemptRecord,
  ): Promise<PublicationEvidence> {
    if (attempt.branchName === undefined) throw new GitCommandError("branch-not-recorded");
    await this.#runner.run(slot.worktreePath, ["fetch", "origin", attempt.branchName]);
    const branch = await this.#runner.run(slot.worktreePath, ["branch", "--show-current"]);
    if (branch.stdout !== attempt.branchName)
      throw new GitCommandError("branch-ownership-conflict");
    await this.#assertBranchOwner(slot.worktreePath, attempt);
    const local = await this.#runner.run(slot.worktreePath, ["rev-parse", "HEAD"]);
    const remote = await this.#runner.run(slot.worktreePath, [
      "rev-parse",
      `origin/${attempt.branchName}`,
    ]);
    if (local.stdout !== remote.stdout) throw new GitCommandError("push-not-acknowledged");
    return { branchName: attempt.branchName, commitSha: local.stdout };
  }

  async park(slot: LoopSlotConfig, baseBranch: string, attempt: AttemptRecord): Promise<void> {
    await this.#metadata.runExclusive(slot.worktreePath, () =>
      this.#parkUnlocked(slot, baseBranch, attempt),
    );
  }

  async #parkUnlocked(
    slot: LoopSlotConfig,
    baseBranch: string,
    attempt: AttemptRecord,
  ): Promise<void> {
    if (attempt.branchName === undefined || attempt.commitSha === undefined) {
      throw new GitCommandError("publication-evidence-missing");
    }
    const branch = await this.#runner.run(slot.worktreePath, ["branch", "--show-current"]);
    if (branch.stdout === attempt.branchName) {
      const evidence = await this.#publicationEvidenceUnlocked(slot, attempt);
      if (evidence.commitSha !== attempt.commitSha) {
        throw new GitCommandError("parked-remote-commit-conflict");
      }
    } else if (branch.stdout === "") {
      const status = await this.#runner.run(slot.worktreePath, [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ]);
      if (status.stdout !== "") throw new GitCommandError("uncommitted-changes");
      await this.#runner.run(slot.worktreePath, ["fetch", "origin", attempt.branchName]);
      const remote = await this.#runner.run(slot.worktreePath, [
        "rev-parse",
        `origin/${attempt.branchName}`,
      ]);
      if (remote.stdout !== attempt.commitSha) {
        throw new GitCommandError("parked-remote-commit-conflict");
      }
      await this.#runner.run(slot.worktreePath, ["fetch", "origin", baseBranch]);
      const [head, base] = await Promise.all([
        this.#runner.run(slot.worktreePath, ["rev-parse", "HEAD"]),
        this.#runner.run(slot.worktreePath, ["rev-parse", `origin/${baseBranch}`]),
      ]);
      if (head.stdout !== base.stdout) {
        await this.#runner.run(slot.worktreePath, ["switch", "--detach", `origin/${baseBranch}`]);
        const parked = await this.#runner.run(slot.worktreePath, ["rev-parse", "HEAD"]);
        if (parked.stdout !== base.stdout) {
          throw new GitCommandError("parked-head-conflict");
        }
      }
      return;
    } else {
      throw new GitCommandError("branch-ownership-conflict");
    }
    const status = await this.#runner.run(slot.worktreePath, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]);
    if (status.stdout !== "") throw new GitCommandError("uncommitted-changes");
    await this.#runner.run(slot.worktreePath, ["fetch", "origin", baseBranch]);
    await this.#runner.run(slot.worktreePath, ["switch", "--detach", `origin/${baseBranch}`]);
  }

  async #refExists(cwd: string, ref: string): Promise<boolean> {
    try {
      await this.#runner.run(cwd, ["show-ref", "--verify", "--quiet", ref]);
      return true;
    } catch {
      return false;
    }
  }

  async #branchOwner(cwd: string, branchName: string): Promise<string | undefined> {
    try {
      return (
        await this.#runner.run(cwd, [
          "config",
          "--local",
          "--get",
          `branch.${branchName}.codex-loop-attempt`,
        ])
      ).stdout;
    } catch {
      return undefined;
    }
  }

  async #assertBranchOwner(cwd: string, attempt: AttemptRecord): Promise<void> {
    if (attempt.trigger === "rework" || attempt.branchName === undefined) return;
    if ((await this.#branchOwner(cwd, attempt.branchName)) !== attempt.attemptId) {
      throw new GitCommandError("branch-ownership-conflict");
    }
  }
}
