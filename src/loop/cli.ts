import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { DualWorkerDispatcher, type DispatchReport } from "./dispatcher.js";
import { LocalGitWorktreeAdapter } from "./git.js";
import { GhCliLoopAdapter, type GitHubLoopPort } from "./github.js";
import { buildHealth, LoopReconciliationService } from "./health.js";
import {
  DispatcherCapabilityEvidenceSchema,
  LeaseRecoveryEvidenceSchema,
  TaskEvidenceSetSchema,
  type DispatcherCapabilityEvidence,
} from "./policy.js";
import { LoopLeaseRecoveryService } from "./recovery.js";
import type { LoopConfig } from "./schema.js";
import {
  FileDispatcherMutex,
  FileLoopStateStore,
  loadLoopConfig,
  resolveLoopStatePath,
  type LoopStateStore,
} from "./store.js";
import { DeepVerificationService, loadAdversarialReview } from "./verification.js";
import { LoopWorkerService, queueTrustedRework } from "./worker.js";

export interface LoopCliRuntime {
  readonly config: LoopConfig;
  readonly dispatcher: DualWorkerDispatcher;
  readonly github: GitHubLoopPort;
  readonly recovery: LoopLeaseRecoveryService;
  readonly reconcile: LoopReconciliationService;
  readonly store: LoopStateStore;
  readonly verification: DeepVerificationService;
  readonly worker: LoopWorkerService;
}

export interface LoopCliIo {
  error(message: string): void;
  output(message: string): void;
}

export interface LoopCliOptions {
  readonly assertWorkerLocation?: (runtime: LoopCliRuntime, attemptId: string) => Promise<void>;
  readonly createRuntime?: (configPath: string) => Promise<LoopCliRuntime>;
  readonly loadConfig?: (configPath: string) => Promise<LoopConfig>;
  readonly resolveConfigPath?: (explicitPath: string | undefined) => Promise<string>;
}

export async function assertWorkerLocation(
  runtime: LoopCliRuntime,
  attemptId: string,
): Promise<void> {
  const state = await runtime.store.read();
  const attempt = state.attempts.find((candidate) => candidate.attemptId === attemptId);
  if (attempt === undefined) throw new Error("attempt-not-found");
  const slot = runtime.config.slots.find((candidate) => candidate.id === attempt.slotId);
  if (slot === undefined) throw new Error("slot-config-missing");
  const [actual, expected] = await Promise.all([
    realpath(process.cwd()),
    realpath(slot.worktreePath),
  ]);
  const identity = (path: string) =>
    process.platform === "win32" ? path.replaceAll("/", "\\").toLowerCase() : path;
  if (identity(actual) !== identity(expected)) {
    throw new Error("worker-worktree-identity-conflict");
  }
}

interface ConfigPathResolutionOptions {
  readonly cwd?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly gitCommonDirectory?: (cwd: string) => Promise<string>;
}

const execFileAsync = promisify(execFile);

async function defaultGitCommonDirectory(cwd: string): Promise<string> {
  try {
    const result = await execFileAsync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      {
        cwd,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        shell: false,
        windowsHide: true,
      },
    );
    const value = result.stdout.trim();
    if (value === "") throw new Error("empty-git-common-dir");
    return isAbsolute(value) ? value : resolve(cwd, value);
  } catch {
    throw new Error("loop-config-path-unavailable");
  }
}

export async function resolveLoopConfigPath(
  explicitPath: string | undefined,
  options: ConfigPathResolutionOptions = {},
): Promise<string> {
  const cwd = options.cwd ?? process.cwd();
  const configured = explicitPath?.trim() ?? options.environment?.CODEX_LOOP_CONFIG?.trim();
  if (configured !== undefined && configured !== "") {
    return isAbsolute(configured) ? configured : resolve(cwd, configured);
  }
  const commonDirectory = await (options.gitCommonDirectory ?? defaultGitCommonDirectory)(cwd);
  const absoluteCommonDirectory = isAbsolute(commonDirectory)
    ? commonDirectory
    : resolve(cwd, commonDirectory);
  return join(absoluteCommonDirectory, "codex-loop", "config.yaml");
}

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function required(value: string | undefined, usage: string): string {
  if (value === undefined || value.trim() === "") throw new Error(usage);
  return value;
}

function has(args: readonly string[], name: string): boolean {
  return args.includes(name);
}

function optionValues(args: readonly string[], name: string): readonly string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== name) continue;
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${name.slice(2)}-missing`);
    }
    values.push(value);
  }
  return values;
}

function extractOption(
  args: readonly string[],
  name: string,
): { readonly args: readonly string[]; readonly value?: string } {
  const positions = args.flatMap((value, index) => (value === name ? [index] : []));
  if (positions.length > 1) throw new Error(`${name.slice(2)}-duplicate`);
  const index = positions[0];
  if (index === undefined) return { args };
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name.slice(2)}-missing`);
  }
  return {
    args: [...args.slice(0, index), ...args.slice(index + 2)],
    value,
  };
}

function verificationKey(config: LoopConfig): string {
  const value = process.env[config.verificationKeyEnv]?.trim();
  if (value === undefined || value.length < 32) {
    throw new Error("verification-key-missing");
  }
  return value;
}

async function createRuntime(configPath: string): Promise<LoopCliRuntime> {
  const config = await loadLoopConfig(configPath);
  const statePath = resolveLoopStatePath(config, configPath);
  const store = new FileLoopStateStore(statePath);
  const mutex = new FileDispatcherMutex(
    resolve(dirname(statePath), "dispatcher.lock"),
    config.dispatcher.mutexSeconds,
  );
  const github = new GhCliLoopAdapter(config);
  const git = new LocalGitWorktreeAdapter();
  return {
    config,
    dispatcher: new DualWorkerDispatcher(config, store, mutex, github, git),
    github,
    recovery: new LoopLeaseRecoveryService(config, store, github),
    reconcile: new LoopReconciliationService(config, store, github),
    store,
    verification: new DeepVerificationService(config, store),
    worker: new LoopWorkerService(config, store, github, git),
  };
}

function humanDispatch(report: DispatchReport): string {
  const free = report.slots.filter((slot) => slot.status === "free").length;
  const occupied = report.slots.filter((slot) => slot.status === "occupied").length;
  const unsafe = report.slots.filter((slot) => slot.status === "unsafe").length;
  const assignments =
    report.assignments.length === 0
      ? "none"
      : report.assignments
          .map((assignment) => `#${assignment.issueNumber.toString()}->${assignment.slotId}`)
          .join(", ");
  return `Loop dispatch ${report.dryRun ? "dry-run" : "live"}: free=${free.toString()} occupied=${occupied.toString()} unsafe=${unsafe.toString()} assignments=${assignments}`;
}

function publicDispatchReport(report: DispatchReport): unknown {
  return {
    ...report,
    assignments: report.assignments.map((assignment) => ({
      attemptId: assignment.attemptId,
      issueNumber: assignment.issueNumber,
      issueUrl: assignment.issueUrl,
      slotId: assignment.slotId,
      trigger: assignment.trigger,
      workerPrompt: assignment.workerPrompt,
    })),
  };
}

async function jsonFileOption(args: readonly string[], name: string): Promise<unknown> {
  const path = required(option(args, name), `${name} is required`);
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw new Error(`${name.slice(2)}-invalid`);
  }
}

export async function runLoopCli(
  args: readonly string[],
  io: LoopCliIo = {
    error: (message) => process.stderr.write(`${message}\n`),
    output: (message) => process.stdout.write(`${message}\n`),
  },
  options: LoopCliOptions = {},
): Promise<number> {
  try {
    const [command, ...rawArguments] = args;
    if (command === undefined) throw new Error("codex-loop-command-required");
    const extractedConfig = extractOption(rawArguments, "--config");
    let rest = extractedConfig.args;
    const legacyConfig =
      extractedConfig.value === undefined && /\.ya?ml$/i.test(rest[0] ?? "") ? rest[0] : undefined;
    if (legacyConfig !== undefined) rest = rest.slice(1);
    const configPath = await (
      options.resolveConfigPath ??
      ((explicitPath) => resolveLoopConfigPath(explicitPath, { environment: process.env }))
    )(extractedConfig.value ?? legacyConfig);
    if (command === "validate-config") {
      const config = await (options.loadConfig ?? loadLoopConfig)(configPath);
      io.output(
        `Valid Codex loop config: version=${config.version.toString()} capacity=${config.slots.length.toString()} cadence=${config.dispatcher.pollMinutes.toString()}m`,
      );
      return 0;
    }
    const runtime = await (options.createRuntime ?? createRuntime)(configPath);
    const verifyWorkerLocation =
      options.assertWorkerLocation ??
      (options.createRuntime === undefined ? assertWorkerLocation : () => Promise.resolve());
    if (command === "dispatch") {
      const dryRun = has(rest, "--dry-run");
      let capabilities: DispatcherCapabilityEvidence | undefined;
      if (!dryRun) {
        const parsed = DispatcherCapabilityEvidenceSchema.safeParse(
          await jsonFileOption(rest, "--capabilities-file"),
        );
        if (!parsed.success) throw new Error("capability-evidence-invalid");
        capabilities = parsed.data;
      }
      const report = await runtime.dispatcher.dispatch(dryRun, capabilities);
      io.output(
        has(rest, "--json") ? JSON.stringify(publicDispatchReport(report)) : humanDispatch(report),
      );
      return 0;
    }
    if (command === "thread-ack") {
      const attemptId = required(rest[0], "Usage: thread-ack <config> <attempt> <thread>");
      const threadId = required(rest[1], "Usage: thread-ack <config> <attempt> <thread>");
      await runtime.dispatcher.acknowledgeThread(attemptId, threadId);
      io.output(`Thread acknowledgement recorded for attempt ${attemptId}.`);
      return 0;
    }
    if (command === "thread-fail") {
      const attemptId = required(rest[0], "Usage: thread-fail <config> <attempt>");
      await runtime.dispatcher.failLaunch(attemptId);
      io.output(`Thread launch failure finalized for attempt ${attemptId}.`);
      return 0;
    }
    if (command === "worker") {
      const [action, attemptId] = rest;
      const workerAction = required(
        action,
        "Usage: worker <config> <prepare|checkpoint|verify|push> <attempt>",
      );
      const workerAttemptId = required(
        attemptId,
        "Usage: worker <config> <prepare|checkpoint|verify|push> <attempt>",
      );
      await verifyWorkerLocation(runtime, workerAttemptId);
      if (workerAction === "prepare") {
        const attempt = await runtime.worker.prepare(workerAttemptId);
        const state = await runtime.store.read();
        const reworkRequest =
          attempt.trigger === "rework"
            ? state.reworkRequests
                .filter(
                  (request) =>
                    request.issueNumber === attempt.issueNumber && request.status === "claimed",
                )
                .sort((left, right) => right.requestedAt.localeCompare(left.requestedAt))[0]
            : undefined;
        io.output(
          `Worker prepared attempt ${attempt.attemptId} on ${attempt.slotId}; branch=${attempt.branchName ?? "missing"}.${reworkRequest === undefined ? "" : ` approved-feedback=${reworkRequest.approvedFeedbackIds.join(",")}`}`,
        );
        return 0;
      }
      if (workerAction === "checkpoint") {
        const stage = required(
          option(rest, "--stage"),
          "worker checkpoint requires --stage implemented|committed",
        );
        if (stage !== "implemented" && stage !== "committed") {
          throw new Error("invalid-checkpoint-stage");
        }
        const attempt = await runtime.worker.checkpoint(
          workerAttemptId,
          stage,
          option(rest, "--commit"),
        );
        io.output(`Worker checkpoint recorded: ${attempt.stage}.`);
        return 0;
      }
      if (workerAction === "verify") {
        if (has(rest, "--focused-pass")) {
          throw new Error("focused-pass-evidence-not-accepted");
        }
        const reviewPath = option(rest, "--review");
        const review =
          reviewPath === undefined ? undefined : await loadAdversarialReview(reviewPath);
        const focusedTests = optionValues(rest, "--focused-test");
        const verdict = await runtime.verification.verify({
          ...(review === undefined ? {} : { adversarialReview: review }),
          attemptId: workerAttemptId,
          ...(focusedTests.length === 0 ? {} : { focusedTests }),
          key: verificationKey(runtime.config),
        });
        io.output(JSON.stringify(verdict));
        return verdict.status === "pass" ? 0 : 2;
      }
      if (workerAction === "push") {
        const attempt = await runtime.worker.push(workerAttemptId, verificationKey(runtime.config));
        io.output(`Push acknowledged for attempt ${attempt.attemptId}.`);
        return 0;
      }
      throw new Error("unknown-worker-action");
    }
    if (command === "finalize") {
      const attemptId = required(rest[0], "Usage: finalize <config> <attempt> --result ...");
      await verifyWorkerLocation(runtime, attemptId);
      const result = required(
        option(rest, "--result"),
        "finalize requires --result review|attention",
      );
      if (result === "review") {
        const attempt = await runtime.worker.finalizeReview(
          attemptId,
          verificationKey(runtime.config),
        );
        io.output(
          `Attempt ${attempt.attemptId} finalized in review with draft PR #${attempt.pullRequest?.number.toString() ?? "unknown"}.`,
        );
        return 0;
      }
      if (result === "attention") {
        const errorCode = required(
          option(rest, "--error"),
          "attention finalization requires --error <safe-code>",
        );
        const attempt = await runtime.worker.finalizeAttention(attemptId, errorCode);
        io.output(`Attempt ${attempt.attemptId} finalized in attention.`);
        return 0;
      }
      throw new Error("invalid-finalize-result");
    }
    if (command === "rework-request") {
      const issueNumber = Number(
        required(option(rest, "--issue"), "rework-request requires --issue"),
      );
      const approvedFeedbackIds = required(
        option(rest, "--feedback"),
        "rework-request requires --feedback id[,id]",
      ).split(",");
      const request = await queueTrustedRework(runtime.config, runtime.store, runtime.github, {
        approvedFeedbackIds,
        baseCommit: required(option(rest, "--base-commit"), "--base-commit is required"),
        eventId: required(option(rest, "--event"), "--event is required"),
        issueNumber,
        prNumber: Number(required(option(rest, "--pr"), "--pr is required")),
      });
      io.output(
        `Trusted rework queued for issue #${request.issueNumber.toString()} with event ${request.eventId}.`,
      );
      return 0;
    }
    if (command === "recover") {
      const attemptId = required(rest[0], "Usage: recover <config> <attempt> --evidence-file ...");
      const parsedEvidence = LeaseRecoveryEvidenceSchema.safeParse(
        await jsonFileOption(rest, "--evidence-file"),
      );
      if (!parsedEvidence.success) throw new Error("recovery-evidence-invalid");
      const evidence = parsedEvidence.data;
      const recovered = await runtime.recovery.recover(attemptId, evidence);
      io.output(
        `Recovery ${recovered.decision} recorded for attempt ${recovered.attempt.attemptId}.`,
      );
      return 0;
    }
    if (command === "health") {
      const queue = await runtime.github.listQueue();
      const tracked =
        runtime.github.listTrackedIssues === undefined
          ? queue
          : await runtime.github.listTrackedIssues();
      const health = buildHealth(await runtime.store.read(), queue, new Date(), tracked);
      if (has(rest, "--json")) io.output(JSON.stringify(health));
      else {
        io.output(
          `Codex loop health: active=${health.summary.activeWorkers.toString()}/2 queued=${health.queue.total.toString()} stale=${health.summary.staleLeases.toString()} attention=${health.attention.length.toString()} contradictions=${health.summary.contradictions.length.toString()}`,
        );
      }
      return health.summary.contradictions.length === 0 ? 0 : 2;
    }
    if (command === "reconcile") {
      const parsedTaskEvidence = TaskEvidenceSetSchema.safeParse(
        await jsonFileOption(rest, "--task-evidence-file"),
      );
      if (!parsedTaskEvidence.success) throw new Error("task-evidence-invalid");
      const taskEvidence = parsedTaskEvidence.data;
      if (has(rest, "--dry-run")) {
        const report = await runtime.reconcile.reconcileDryRun(taskEvidence);
        if (has(rest, "--json")) io.output(JSON.stringify(report));
        else {
          io.output(
            `Reconciliation dry-run: ${report.items.length.toString()} active attempt(s); ${report.items.filter((item) => item.recommendation === "move-to-attention").length.toString()} require attention.`,
          );
        }
        return report.items.some((item) => item.recommendation === "move-to-attention") ? 2 : 0;
      }
      const attemptId = required(
        option(rest, "--apply"),
        "reconcile requires --dry-run or --apply <attempt>",
      );
      const result = await runtime.reconcile.apply(
        attemptId,
        required(option(rest, "--event"), "reconcile apply requires --event"),
        taskEvidence,
      );
      io.output(
        `Reconciliation ${result.applied ? "applied" : "deferred"} for attempt ${result.item.attemptId}; action=${result.item.recommendation}.`,
      );
      return result.applied ? 0 : 2;
    }
    throw new Error(
      "Usage: <validate-config|dispatch|thread-ack|thread-fail|worker|finalize|rework-request|recover|health|reconcile> [--config <path>]",
    );
  } catch (error: unknown) {
    io.error(error instanceof Error ? error.message : "codex-loop-command-failed");
    return 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  process.exitCode = await runLoopCli(process.argv.slice(2));
}
