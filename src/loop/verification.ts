import { createHmac, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import {
  AdversarialReviewSchema,
  VerificationVerdictSchema,
  type AdversarialReview,
  type LoopConfig,
  type VerificationFinding,
  type VerificationVerdict,
} from "./schema.js";
import { hasDelivered, recordAudit } from "./domain.js";
import type { LoopStateStore } from "./store.js";

const execFileAsync = promisify(execFile);
export interface VerificationPlan {
  readonly changedPaths: readonly string[];
  readonly config: boolean;
  readonly highRisk: boolean;
  readonly testsChanged: boolean;
}

export interface VerificationCommandRunner {
  run(cwd: string, executable: string, args: readonly string[]): Promise<number>;
}

export class ExecFileVerificationRunner implements VerificationCommandRunner {
  async run(cwd: string, executable: string, args: readonly string[]): Promise<number> {
    const startedAt = Date.now();
    try {
      await execFileAsync(executable, [...args], {
        cwd,
        encoding: "utf8",
        maxBuffer: 50 * 1024 * 1024,
        shell: false,
        windowsHide: true,
      });
      return Date.now() - startedAt;
    } catch {
      throw new Error("verification-command-failed");
    }
  }
}

export interface VerificationGitPort {
  changedPaths(cwd: string, baseRef: string): Promise<readonly string[]>;
  commitSha(cwd: string): Promise<string>;
  diff(cwd: string, baseRef: string): Promise<string>;
}

export class VerificationGitAdapter implements VerificationGitPort {
  async changedPaths(cwd: string, baseRef: string): Promise<readonly string[]> {
    return (
      await execFileAsync("git", ["diff", "--name-only", `${baseRef}...HEAD`], {
        cwd,
        encoding: "utf8",
        shell: false,
        windowsHide: true,
      })
    ).stdout
      .split(/\r?\n/)
      .map((path) => path.trim())
      .filter(Boolean);
  }

  async commitSha(cwd: string): Promise<string> {
    return (
      await execFileAsync("git", ["rev-parse", "HEAD"], {
        cwd,
        encoding: "utf8",
        shell: false,
        windowsHide: true,
      })
    ).stdout.trim();
  }

  async diff(cwd: string, baseRef: string): Promise<string> {
    return (
      await execFileAsync("git", ["diff", "--unified=0", `${baseRef}...HEAD`], {
        cwd,
        encoding: "utf8",
        maxBuffer: 50 * 1024 * 1024,
        shell: false,
        windowsHide: true,
      })
    ).stdout;
  }
}

export function packageManagerExecutable(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "pnpm.cmd" : "pnpm";
}

const HIGH_RISK_PATHS = [
  /^src\/loop\//,
  /^src\/domain\/(?:issue-promotion|generation-plan|weighted-selection)\.ts$/,
  /^src\/persistence\//,
  /^src\/server\/auth\.ts$/,
  /^extension\/src\/(?:dom-adapter|live-attempt-guard|command-executor)\.ts$/,
];

export function planVerification(changedPaths: readonly string[]): VerificationPlan {
  const normalized = changedPaths.map((path) => path.replaceAll("\\", "/"));
  return {
    changedPaths: normalized,
    config: normalized.some(
      (path) =>
        path.startsWith("config/") ||
        path === "src/config/schema.ts" ||
        path === "src/loop/schema.ts",
    ),
    highRisk: normalized.some((path) => HIGH_RISK_PATHS.some((pattern) => pattern.test(path))),
    testsChanged: normalized.some(
      (path) => path.startsWith("test/") || /\.test\.[cm]?[jt]s$/.test(path),
    ),
  };
}

const secretPatterns: readonly [RegExp, string][] = [
  [/\bAIza[A-Za-z0-9_-]{20,}\b/, "google-api-key"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/, "github-token"],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/, "api-secret"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private-key"],
  [/\b(?:cookie|authorization)\s*[:=]\s*["'][^"']{12,}["']/i, "session-secret"],
];

const unsafeAddedPatterns: readonly [RegExp, string][] = [
  [/\ballowLiveSubmissions\s*[:=]\s*true\b/i, "live-suno-enabled"],
  [/\bautomation\.mode\s*[:=]\s*["']?live\b/i, "live-suno-enabled"],
  [/\bgit\s+push\b[^\n]*(?:--force|-f)\b/i, "force-push-workflow"],
  [/\bgit\s+reset\s+--hard\b/i, "destructive-git-workflow"],
];

export function scanDiff(diff: string): readonly VerificationFinding[] {
  const findings: VerificationFinding[] = [];
  const additions = diff
    .split(/\r?\n/)
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .join("\n");
  for (const [pattern, id] of secretPatterns) {
    if (pattern.test(additions)) {
      findings.push({
        confidence: "high",
        id,
        location: "repository-diff",
        requiredAction: "Remove the sensitive value and rotate it before publication.",
        severity: "P0",
        summary: "A secret-like value is present in the proposed diff.",
      });
    }
  }
  for (const [pattern, id] of unsafeAddedPatterns) {
    if (pattern.test(additions)) {
      findings.push({
        confidence: "high",
        id,
        location: "repository-diff",
        requiredAction:
          "Remove the unsafe workflow change or obtain a separate supervised contract.",
        severity: "P1",
        summary: "The diff would weaken a live-action or Git safety boundary.",
      });
    }
  }
  return findings;
}

export async function loadAdversarialReview(path: string): Promise<AdversarialReview> {
  return AdversarialReviewSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

function signaturePayload(verdict: Omit<VerificationVerdict, "signature">): string {
  return JSON.stringify(verdict);
}

function signVerdict(
  verdict: Omit<VerificationVerdict, "signature">,
  key: string,
): VerificationVerdict {
  const signature = createHmac("sha256", key).update(signaturePayload(verdict)).digest("hex");
  return VerificationVerdictSchema.parse({ ...verdict, signature });
}

export function verifyVerdictSignature(verdict: VerificationVerdict, key: string): boolean {
  const { signature, ...unsigned } = verdict;
  const expected = createHmac("sha256", key).update(signaturePayload(unsigned)).digest("hex");
  return timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"));
}

export interface DeepVerificationInput {
  readonly adversarialReview?: AdversarialReview;
  readonly attemptId: string;
  /** Deprecated compatibility input. It is intentionally ignored as verification evidence. */
  readonly focusedPassed?: boolean;
  readonly focusedTests?: readonly string[];
  readonly key: string;
}

export class DeepVerificationService {
  readonly #commands: VerificationCommandRunner;
  readonly #config: LoopConfig;
  readonly #git: VerificationGitPort;
  readonly #now: () => Date;
  readonly #store: LoopStateStore;

  constructor(
    config: LoopConfig,
    store: LoopStateStore,
    commands: VerificationCommandRunner = new ExecFileVerificationRunner(),
    git: VerificationGitPort = new VerificationGitAdapter(),
    now: () => Date = () => new Date(),
  ) {
    this.#config = config;
    this.#store = store;
    this.#commands = commands;
    this.#git = git;
    this.#now = now;
  }

  async verify(input: DeepVerificationInput): Promise<VerificationVerdict> {
    const state = await this.#store.read();
    const attempt = state.attempts.find((candidate) => candidate.attemptId === input.attemptId);
    if (attempt === undefined) throw new Error("attempt-not-found");
    if (attempt.repairPasses >= 2 && attempt.verification?.status !== "pass") {
      throw new Error("repair-pass-limit");
    }
    if (!["committed", "verified"].includes(attempt.stage)) {
      throw new Error("attempt-not-committed");
    }
    const slot = this.#config.slots.find((candidate) => candidate.id === attempt.slotId);
    if (slot === undefined) throw new Error("slot-config-missing");
    const baseRef = `origin/${this.#config.repository.baseBranch}`;
    const changedPaths = await this.#git.changedPaths(slot.worktreePath, baseRef);
    const plan = planVerification(changedPaths);
    const findings = [...scanDiff(await this.#git.diff(slot.worktreePath, baseRef))];
    if (plan.changedPaths.length === 0) {
      findings.push({
        confidence: "high",
        id: "no-changed-paths",
        location: "repository-diff",
        requiredAction: "Finalize the attempt as no-change attention without publishing.",
        severity: "P1",
        summary: "The executor commit contains no changes relative to the configured base.",
      });
    }
    const commands: VerificationVerdict["commands"][number][] = [];
    const changedTests = plan.changedPaths.filter(
      (path) => path.startsWith("test/") || /\.test\.[cm]?[jt]s$/.test(path),
    );
    const requestedFocusedTests = (input.focusedTests ?? []).map((path) =>
      path.replaceAll("\\", "/"),
    );
    const invalidFocusedTarget = requestedFocusedTests.find(
      (path) =>
        !changedTests.includes(path) ||
        path.startsWith("/") ||
        /^[a-z]:\//i.test(path) ||
        path.split("/").includes(".."),
    );
    const focusedTargets = requestedFocusedTests.length > 0 ? requestedFocusedTests : changedTests;
    if (invalidFocusedTarget !== undefined) {
      commands.push({ durationMs: 0, name: "focused", status: "block" });
      findings.push({
        confidence: "high",
        id: "focused-target-invalid",
        location: "changed-tests",
        requiredAction: "Choose focused tests from the changed repository test paths.",
        severity: "P1",
        summary: "Focused verification requested an untrusted or unrelated test target.",
      });
    } else if (focusedTargets.length > 0) {
      await this.#runGate(commands, slot.worktreePath, "focused", [
        "exec",
        "vitest",
        "run",
        ...focusedTargets,
      ]);
    } else if (
      plan.changedPaths.some(
        (path) =>
          path.startsWith("src/") || path.startsWith("extension/") || path.startsWith("scripts/"),
      )
    ) {
      commands.push({ durationMs: 0, name: "focused", status: "block" });
      findings.push({
        confidence: "high",
        id: "focused-test-missing",
        location: "repository-diff",
        requiredAction: "Add or change an outcome test that exercises the implementation.",
        severity: "P1",
        summary: "Code changed without a focused test target in the same commit.",
      });
    } else {
      commands.push({ durationMs: 0, name: "focused", status: "not-applicable" });
    }

    if (plan.testsChanged) {
      if (input.adversarialReview === undefined) {
        findings.push({
          confidence: "high",
          id: "adversarial-review-missing",
          location: "changed-tests",
          requiredAction: "Run the read-only adversarial test review and provide its JSON verdict.",
          severity: "P1",
          summary: "Changed tests have no independent adversarial review.",
        });
      } else {
        findings.push(...input.adversarialReview.findings);
        if (input.adversarialReview.status !== "pass") {
          findings.push({
            confidence: "high",
            id: "adversarial-review-blocked",
            location: "changed-tests",
            requiredAction: "Resolve the reviewer findings and rerun an independent review.",
            severity: "P1",
            summary: "The adversarial test review did not pass.",
          });
        }
      }
    }

    await this.#runGate(commands, slot.worktreePath, "full-gate", ["check"]);
    await this.#runGate(commands, slot.worktreePath, "build", ["build"]);
    if (plan.config) {
      await this.#runGate(commands, slot.worktreePath, "config", ["validate:config"]);
    } else {
      commands.push({ durationMs: 0, name: "config", status: "not-applicable" });
    }
    if (plan.highRisk) {
      await this.#runGate(commands, slot.worktreePath, "mutation", ["test:mutation"]);
    } else {
      commands.push({ durationMs: 0, name: "mutation", status: "not-applicable" });
    }

    const blockingFinding = findings.some(
      (finding) =>
        finding.confidence === "high" && (finding.severity === "P0" || finding.severity === "P1"),
    );
    const commandFailure = commands.some((command) => ["block", "error"].includes(command.status));
    const unsigned = {
      attemptId: input.attemptId,
      commands,
      commitSha: await this.#git.commitSha(slot.worktreePath),
      createdAt: this.#now().toISOString(),
      findings,
      slotId: attempt.slotId,
      status: blockingFinding || commandFailure ? ("block" as const) : ("pass" as const),
      version: 1 as const,
    };
    const verdict = signVerdict(unsigned, input.key);
    await this.#store.update((draft) => {
      const target = draft.attempts.find((candidate) => candidate.attemptId === input.attemptId);
      if (target === undefined) throw new Error("attempt-not-found");
      target.verification = verdict;
      target.updatedAt = verdict.createdAt;
      if (verdict.status === "pass") {
        target.stage = "verified";
        target.commitSha = verdict.commitSha;
        if (!hasDelivered(draft, "stage-verified", target.attemptId)) {
          recordAudit(draft, {
            at: verdict.createdAt,
            attemptId: target.attemptId,
            eventId: "stage-verified",
            issueNumber: target.issueNumber,
            result: "success",
            slotId: target.slotId,
            stage: "verified",
          });
        }
      } else if (target.repairPasses < 2) {
        target.repairPasses += 1;
      }
    });
    return verdict;
  }

  async #runGate(
    commands: VerificationVerdict["commands"][number][],
    cwd: string,
    name: VerificationVerdict["commands"][number]["name"],
    args: readonly string[],
  ): Promise<void> {
    try {
      const durationMs = await this.#commands.run(cwd, packageManagerExecutable(), args);
      commands.push({ durationMs, name, status: "pass" });
    } catch {
      commands.push({ durationMs: 0, name, status: "block" });
    }
  }
}
