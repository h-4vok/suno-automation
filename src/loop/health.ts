import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { promisify } from "node:util";

import {
  lifecycleComment,
  recordAudit,
  releaseAttempt,
  singleLifecycleLabel,
  transitionAttempt,
} from "./domain.js";
import type { GitHubLoopPort, PullRequestSnapshot } from "./github.js";
import {
  reconciliationRecommendation,
  taskEvidenceFor,
  type ReconciliationRecommendation,
  type TaskEvidence,
  TaskEvidenceSetSchema,
} from "./policy.js";
import type { AttemptRecord, IssueCandidate, LoopConfig, LoopSlotId, LoopState } from "./schema.js";
import type { LoopStateStore } from "./store.js";

const execFileAsync = promisify(execFile);
const LOCAL_HOLD_REASONS = [
  "worktree-missing",
  "worktree-dirty",
  "branch-ownership-conflict",
  "commit-conflict",
  "remote-commit-conflict",
  "parked-base-conflict",
] as const;

function latestAttemptForIssue(state: LoopState, issueNumber: number): AttemptRecord | undefined {
  return [...state.attempts]
    .filter((attempt) => attempt.issueNumber === issueNumber)
    .sort(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) ||
        right.updatedAt.localeCompare(left.updatedAt) ||
        right.attemptId.localeCompare(left.attemptId),
    )[0];
}

/**
 * A released review record is historical as soon as a newer attempt for the
 * issue exists. In particular, a rework keeps the same PR/branch but must not
 * let reconciliation of the older review move the issue lifecycle.
 */
function isCurrentReleasedReview(state: LoopState, attempt: AttemptRecord): boolean {
  const ownsSlot = state.slots.some((slot) => slot.attemptId === attempt.attemptId);
  return (
    !ownsSlot &&
    attempt.stage === "review" &&
    attempt.pullRequest !== undefined &&
    attempt.supersededByAttemptId === undefined &&
    latestAttemptForIssue(state, attempt.issueNumber)?.attemptId === attempt.attemptId
  );
}

export interface LoopHealth {
  readonly attention: readonly {
    readonly attemptId: string;
    readonly errorCode?: string;
    readonly issueNumber: number;
  }[];
  readonly queue: {
    readonly byLifecycle: Readonly<Record<string, number>>;
    readonly byPriority: Readonly<Record<string, number>>;
    readonly total: number;
  };
  readonly recentOutcomes: readonly {
    readonly at: string;
    readonly issueNumber: number;
    readonly result: string;
  }[];
  readonly slots: readonly {
    readonly attemptId?: string;
    readonly issueNumber?: number;
    readonly leaseAgeSeconds?: number;
    readonly leaseExpiresAt?: string;
    readonly stale: boolean;
    readonly state: "free" | "reserved" | "running" | "attention";
    readonly worker: LoopSlotId;
  }[];
  readonly summary: {
    readonly activeWorkers: number;
    readonly capacity: 2;
    readonly contradictions: readonly string[];
    readonly staleLeases: number;
  };
  readonly version: 1;
}

function countBy(values: readonly string[]): Readonly<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return result;
}

function priority(issue: IssueCandidate): string {
  return issue.labels.find((label) => /^priority:p[0-2]$/.test(label)) ?? "unknown";
}

function lifecycle(issue: IssueCandidate): string {
  return issue.labels.find((label) => ["codex-ready", "codex-rework"].includes(label)) ?? "unknown";
}

export function buildHealth(
  state: LoopState,
  queue: readonly IssueCandidate[],
  now: Date,
  trackedIssues: readonly IssueCandidate[] = queue,
): LoopHealth {
  const contradictions: string[] = [];
  const locallyActiveIssues = new Set(
    state.slots.flatMap((slot) => {
      const attempt = state.attempts.find((candidate) => candidate.attemptId === slot.attemptId);
      return attempt === undefined ? [] : [attempt.issueNumber];
    }),
  );
  for (const issue of trackedIssues) {
    if (issue.labels.includes("codex-in-progress") && !locallyActiveIssues.has(issue.number)) {
      contradictions.push(`github:#${issue.number.toString()}:orphan-active`);
    }
  }
  const slots = state.slots.map((slot) => {
    const attempt =
      slot.attemptId === undefined
        ? undefined
        : state.attempts.find((candidate) => candidate.attemptId === slot.attemptId);
    if (slot.attemptId !== undefined && attempt === undefined) {
      contradictions.push(`${slot.id}:missing-attempt`);
    }
    if (attempt !== undefined && attempt.slotId !== slot.id) {
      contradictions.push(`${slot.id}:attempt-owner-conflict`);
    }
    const leaseExpiresAt = slot.leaseExpiresAt;
    const expiresAt = leaseExpiresAt === undefined ? undefined : Date.parse(leaseExpiresAt);
    const stale = expiresAt !== undefined && expiresAt <= now.getTime();
    return {
      ...(slot.attemptId === undefined ? {} : { attemptId: slot.attemptId }),
      ...(attempt === undefined ? {} : { issueNumber: attempt.issueNumber }),
      ...(leaseExpiresAt === undefined
        ? {}
        : {
            leaseAgeSeconds: Math.max(
              0,
              Math.floor(
                (now.getTime() - Date.parse(attempt?.createdAt ?? now.toISOString())) / 1_000,
              ),
            ),
            leaseExpiresAt,
          }),
      stale,
      state: slot.status,
      worker: slot.id,
    };
  });
  const attention = state.attempts
    .filter(
      (attempt) => attempt.stage === "attention" && attempt.supersededByAttemptId === undefined,
    )
    .map((attempt) => ({
      attemptId: attempt.attemptId,
      ...(attempt.errorCode === undefined ? {} : { errorCode: attempt.errorCode }),
      issueNumber: attempt.issueNumber,
    }));
  return {
    attention,
    queue: {
      byLifecycle: countBy(queue.map(lifecycle)),
      byPriority: countBy(queue.map(priority)),
      total: queue.length,
    },
    recentOutcomes: state.audit
      .filter((event) => ["success", "attention", "failure"].includes(event.result))
      .sort((left, right) => right.at.localeCompare(left.at))
      .slice(0, 10)
      .map((event) => ({
        at: event.at,
        issueNumber: event.issueNumber,
        result: event.result,
      })),
    slots,
    summary: {
      activeWorkers: state.slots.filter((slot) => ["reserved", "running"].includes(slot.status))
        .length,
      capacity: 2,
      contradictions,
      staleLeases: slots.filter((slot) => slot.stale).length,
    },
    version: 1,
  };
}

export interface ReconciliationItem {
  readonly attemptId: string;
  readonly issueNumber: number;
  readonly recommendation: ReconciliationRecommendation;
  readonly reasons: readonly string[];
  readonly slotId: LoopSlotId;
}

export interface ReconciliationReport {
  readonly dryRun: true;
  readonly items: readonly ReconciliationItem[];
  readonly version: 1;
}

export interface ReconciliationApplyResult {
  readonly applied: boolean;
  readonly item: ReconciliationItem;
  readonly version: 1;
}

export interface LocalAttemptEvidence {
  readonly baseHead?: string;
  readonly branch?: string;
  readonly clean: boolean;
  readonly exists: boolean;
  readonly head?: string;
  readonly remoteBranchHead?: string;
}

export interface ReconciliationEvidencePort {
  inspect(config: LoopConfig, attempt: AttemptRecord): Promise<LocalAttemptEvidence>;
}

export class LocalReconciliationEvidence implements ReconciliationEvidencePort {
  async inspect(config: LoopConfig, attempt: AttemptRecord): Promise<LocalAttemptEvidence> {
    const slot = config.slots.find((candidate) => candidate.id === attempt.slotId);
    if (slot === undefined) return { clean: false, exists: false };
    try {
      await access(slot.worktreePath);
      const [branch, status, head, baseHead, remoteBranchHead] = await Promise.all([
        execFileAsync("git", ["branch", "--show-current"], {
          cwd: slot.worktreePath,
          encoding: "utf8",
          shell: false,
          windowsHide: true,
        }),
        execFileAsync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
          cwd: slot.worktreePath,
          encoding: "utf8",
          shell: false,
          windowsHide: true,
        }),
        execFileAsync("git", ["rev-parse", "HEAD"], {
          cwd: slot.worktreePath,
          encoding: "utf8",
          shell: false,
          windowsHide: true,
        }),
        this.#optionalRef(slot.worktreePath, `origin/${config.repository.baseBranch}`),
        attempt.branchName === undefined
          ? Promise.resolve(undefined)
          : this.#optionalRef(slot.worktreePath, `origin/${attempt.branchName}`),
      ]);
      return {
        ...(baseHead === undefined ? {} : { baseHead }),
        branch: branch.stdout.trim(),
        clean: status.stdout.trim() === "",
        exists: true,
        head: head.stdout.trim(),
        ...(remoteBranchHead === undefined ? {} : { remoteBranchHead }),
      };
    } catch {
      return { clean: false, exists: false };
    }
  }

  async #optionalRef(cwd: string, ref: string): Promise<string | undefined> {
    try {
      return (
        await execFileAsync("git", ["rev-parse", ref], {
          cwd,
          encoding: "utf8",
          shell: false,
          windowsHide: true,
        })
      ).stdout.trim();
    } catch {
      return undefined;
    }
  }
}

export class LoopReconciliationService {
  readonly #config: LoopConfig;
  readonly #evidence: ReconciliationEvidencePort;
  readonly #github: GitHubLoopPort;
  readonly #now: () => Date;
  readonly #store: LoopStateStore;

  constructor(
    config: LoopConfig,
    store: LoopStateStore,
    github: GitHubLoopPort,
    evidence: ReconciliationEvidencePort = new LocalReconciliationEvidence(),
    now: () => Date = () => new Date(),
  ) {
    this.#config = config;
    this.#store = store;
    this.#github = github;
    this.#evidence = evidence;
    this.#now = now;
  }

  async reconcileDryRun(taskEvidence: readonly TaskEvidence[] = []): Promise<ReconciliationReport> {
    taskEvidence = TaskEvidenceSetSchema.parse(taskEvidence);
    const state = await this.#store.read();
    const occupiedAttemptIds = new Set(
      state.slots.flatMap((slot) => (slot.attemptId === undefined ? [] : [slot.attemptId])),
    );
    const occupied = state.slots.flatMap((slot) => {
      if (slot.attemptId === undefined) return [];
      const attempt = state.attempts.find((candidate) => candidate.attemptId === slot.attemptId);
      return attempt === undefined ? [] : [attempt];
    });
    const releasedReviewsByPullRequest = new Map<number, AttemptRecord>();
    for (const attempt of state.attempts
      .filter((candidate) => isCurrentReleasedReview(state, candidate))
      .sort(
        (left, right) =>
          right.updatedAt.localeCompare(left.updatedAt) ||
          left.attemptId.localeCompare(right.attemptId),
      )) {
      const pullRequestNumber = attempt.pullRequest?.number;
      if (pullRequestNumber !== undefined && !releasedReviewsByPullRequest.has(pullRequestNumber)) {
        releasedReviewsByPullRequest.set(pullRequestNumber, attempt);
      }
    }
    const releasedAttention = state.attempts.filter(
      (attempt) =>
        !occupiedAttemptIds.has(attempt.attemptId) &&
        attempt.stage === "attention" &&
        latestAttemptForIssue(state, attempt.issueNumber)?.attemptId === attempt.attemptId,
    );
    const candidateById = new Map(
      [...occupied, ...releasedReviewsByPullRequest.values(), ...releasedAttention].map(
        (attempt) => [attempt.attemptId, attempt],
      ),
    );
    const candidates = [...candidateById.values()];
    const inspectedItems = await Promise.all(
      candidates.map(async (attempt): Promise<ReconciliationItem | undefined> => {
        const reasons: string[] = [];
        const issue = await this.#github.getIssue(attempt.issueNumber);
        const lifecycle = singleLifecycleLabel(issue.labels);
        const ownsSlot = occupiedAttemptIds.has(attempt.attemptId);
        const releasedReview = !ownsSlot && attempt.stage === "review";
        if (!ownsSlot && attempt.stage === "attention" && lifecycle === "codex-needs-attention") {
          return undefined;
        }
        const local = !ownsSlot
          ? { branch: "", clean: true, exists: true }
          : await this.#evidence.inspect(this.#config, attempt);
        const task = taskEvidenceFor(attempt, taskEvidence, this.#now());
        const stale = Date.parse(attempt.leaseExpiresAt) <= this.#now().getTime();
        if (!releasedReview && !local.exists) reasons.push("worktree-missing");
        if (!releasedReview && !local.clean) reasons.push("worktree-dirty");
        if (
          attempt.branchName !== undefined &&
          local.branch !== undefined &&
          local.branch !== "" &&
          local.branch !== attempt.branchName
        ) {
          reasons.push("branch-ownership-conflict");
        }
        if (
          !releasedReview &&
          attempt.commitSha !== undefined &&
          local.head !== undefined &&
          local.branch === attempt.branchName &&
          attempt.commitSha !== local.head
        ) {
          reasons.push("commit-conflict");
        }
        if (
          !releasedReview &&
          attempt.commitSha !== undefined &&
          local.branch === "" &&
          local.remoteBranchHead !== attempt.commitSha
        ) {
          reasons.push("remote-commit-conflict");
        }
        if (
          !releasedReview &&
          local.branch === "" &&
          (local.baseHead === undefined || local.head !== local.baseHead)
        ) {
          reasons.push("parked-base-conflict");
        }
        if (stale) reasons.push("lease-stale");
        if (task.state === "unknown") reasons.push("task-evidence-unknown");
        if (task.state === "absent") reasons.push("task-absent");
        if (task.state === "inactive") reasons.push("task-inactive");
        let pullRequest: PullRequestSnapshot | undefined;
        if (attempt.pullRequest !== undefined) {
          const pr = await this.#github.getPullRequest(attempt.pullRequest.number);
          pullRequest = pr;
          if (
            pr.number !== attempt.pullRequest.number ||
            pr.baseRef !== this.#config.repository.baseBranch ||
            pr.isCrossRepository ||
            pr.headRepositoryOwner.toLowerCase() !== this.#config.repository.owner.toLowerCase() ||
            pr.headRef !== attempt.branchName
          ) {
            reasons.push("pull-request-identity-conflict");
          }
          if (attempt.commitSha === undefined || pr.headSha !== attempt.commitSha) {
            reasons.push("remote-commit-conflict");
          }
          if (pr.state === "closed") reasons.push("pull-request-closed-unmerged");
        }
        if (issue.state === "closed" && pullRequest?.state !== "merged") {
          reasons.push("issue-closed-without-merged-pr");
        }
        const localBranch = releasedReview
          ? "parked"
          : local.branch === ""
            ? "parked"
            : local.branch === attempt.branchName
              ? "attempt"
              : "other";
        const recommendation = reconciliationRecommendation({
          attemptStage: attempt.stage,
          issueState: issue.state,
          lifecycle,
          localBranch,
          localUnsafe:
            reasons.some((reason) => (LOCAL_HOLD_REASONS as readonly string[]).includes(reason)) ||
            reasons.includes("pull-request-identity-conflict") ||
            reasons.includes("pull-request-closed-unmerged") ||
            reasons.includes("issue-closed-without-merged-pr"),
          pullRequest,
          stale,
          taskState: task.state,
          threadRecorded: attempt.threadId !== undefined,
        });
        return {
          attemptId: attempt.attemptId,
          issueNumber: attempt.issueNumber,
          recommendation,
          reasons,
          slotId: attempt.slotId,
        };
      }),
    );
    const items = inspectedItems.filter((item): item is ReconciliationItem => item !== undefined);
    return { dryRun: true, items, version: 1 };
  }

  async apply(
    attemptId: string,
    eventId: string,
    taskEvidence: readonly TaskEvidence[],
  ): Promise<ReconciliationApplyResult> {
    const report = await this.reconcileDryRun(taskEvidence);
    const item = report.items.find((candidate) => candidate.attemptId === attemptId);
    if (item === undefined) {
      const state = await this.#store.read();
      const attempt = state.attempts.find((candidate) => candidate.attemptId === attemptId);
      const audit = state.audit.find(
        (candidate) => candidate.attemptId === attemptId && candidate.eventId === eventId,
      );
      if (
        attempt !== undefined &&
        audit !== undefined &&
        ["review", "attention", "completed"].includes(attempt.stage)
      ) {
        return {
          applied: false,
          item: {
            attemptId,
            issueNumber: attempt.issueNumber,
            recommendation:
              attempt.stage === "completed"
                ? "complete-merged"
                : attempt.stage === "review"
                  ? "release-review-slot"
                  : "move-to-attention",
            reasons: ["already-applied"],
            slotId: attempt.slotId,
          },
          version: 1,
        };
      }
      throw new Error("reconciliation-attempt-not-found");
    }
    if (["leave-running", "resume-thread", "finalize-review"].includes(item.recommendation)) {
      return { applied: false, item, version: 1 };
    }
    const state = await this.#store.read();
    const attempt = state.attempts.find((candidate) => candidate.attemptId === attemptId);
    if (attempt === undefined) throw new Error("attempt-not-found");
    if (attempt.stage === "review" && !isCurrentReleasedReview(state, attempt)) {
      throw new Error("reconciliation-attempt-superseded");
    }
    if (this.#github.getReconciliationAuthorization === undefined) {
      throw new Error("reconciliation-authorization-port-unavailable");
    }
    const authorization = await this.#github.getReconciliationAuthorization({
      action: item.recommendation,
      attemptId,
      eventId,
      issueNumber: attempt.issueNumber,
    });
    if (
      !this.#config.trustedLogins.some(
        (trusted) => trusted.toLowerCase() === authorization.actor.toLowerCase(),
      )
    ) {
      throw new Error("untrusted-reconciliation-actor");
    }
    const authorizedAt = Date.parse(authorization.authorizedAt);
    if (
      !Number.isFinite(authorizedAt) ||
      Math.abs(this.#now().getTime() - authorizedAt) > 5 * 60 * 1_000
    ) {
      throw new Error("reconciliation-authorization-stale");
    }
    const stateAfterAuthorization = await this.#store.read();
    const attemptAfterAuthorization = stateAfterAuthorization.attempts.find(
      (candidate) => candidate.attemptId === attemptId,
    );
    if (attemptAfterAuthorization === undefined) throw new Error("attempt-not-found");
    if (
      attemptAfterAuthorization.stage === "review" &&
      !isCurrentReleasedReview(stateAfterAuthorization, attemptAfterAuthorization)
    ) {
      throw new Error("reconciliation-attempt-superseded");
    }
    const confirmed = (await this.reconcileDryRun(taskEvidence)).items.find(
      (candidate) => candidate.attemptId === attemptId,
    );
    if (confirmed?.recommendation !== item.recommendation) {
      throw new Error("reconciliation-evidence-changed");
    }
    const slot = state.slots.find((candidate) => candidate.id === attempt.slotId);
    if (slot?.attemptId !== attemptId) {
      if (!["review", "attention"].includes(attempt.stage)) {
        if (attempt.stage === "completed") return { applied: false, item, version: 1 };
        throw new Error("reconciliation-slot-conflict");
      }
    }
    const now = this.#now().toISOString();
    if (item.recommendation === "complete-merged") {
      if (this.#github.completeMergedIssue === undefined) {
        throw new Error("merge-completion-port-unavailable");
      }
      const issue = await this.#github.getIssue(attempt.issueNumber);
      const currentLifecycle = singleLifecycleLabel(issue.labels);
      const from =
        currentLifecycle === "codex-review" || currentLifecycle === "codex-in-progress"
          ? currentLifecycle
          : undefined;
      if (issue.state !== "closed" || from === undefined) {
        throw new Error("merge-completion-state-conflict");
      }
      await this.#github.completeMergedIssue({
        attemptId,
        comment: lifecycleComment({
          attemptId,
          eventId,
          result: "completed",
          stage: "completed",
        }),
        eventId,
        from,
        issueNumber: attempt.issueNumber,
      });
      await this.#releaseWithAudit(attempt, "completed", eventId, now);
      return { applied: true, item, version: 1 };
    }
    if (item.recommendation === "release-review-slot") {
      await this.#releaseWithAudit(attempt, "review", eventId, now);
      return { applied: true, item, version: 1 };
    }
    const issue = await this.#github.getIssue(attempt.issueNumber);
    const currentLifecycle = singleLifecycleLabel(issue.labels);
    const from =
      currentLifecycle === "codex-review" || currentLifecycle === "codex-in-progress"
        ? currentLifecycle
        : undefined;
    if (from === undefined) throw new Error("reconciliation-lifecycle-conflict");
    const errorCode = item.reasons.includes("pull-request-closed-unmerged")
      ? "pull-request-closed-unmerged"
      : "reconciliation-evidence-conflict";
    await this.#github.transitionIssue({
      attemptId,
      comment: lifecycleComment({
        attemptId,
        errorCode,
        eventId,
        result: "attention",
        stage: "attention",
      }),
      eventId,
      from,
      issueNumber: attempt.issueNumber,
      to: "codex-needs-attention",
    });
    if (item.reasons.some((reason) => (LOCAL_HOLD_REASONS as readonly string[]).includes(reason))) {
      await this.#holdAttentionWithAudit(attempt, eventId, now, errorCode);
    } else {
      await this.#releaseWithAudit(attempt, "attention", eventId, now, errorCode);
    }
    return { applied: true, item, version: 1 };
  }

  async #holdAttentionWithAudit(
    attempt: AttemptRecord,
    eventId: string,
    now: string,
    errorCode: string,
  ): Promise<void> {
    await this.#store.update((state) => {
      const current = transitionAttempt(state, attempt.attemptId, "attention", now, {
        errorCode,
      });
      recordAudit(state, {
        at: now,
        attemptId: current.attemptId,
        errorCode,
        eventId,
        issueNumber: current.issueNumber,
        result: "attention",
        slotId: current.slotId,
        stage: "attention",
      });
    });
  }

  async #releaseWithAudit(
    attempt: AttemptRecord,
    terminalStage: "review" | "attention" | "completed",
    eventId: string,
    now: string,
    errorCode?: string,
  ): Promise<void> {
    await this.#store.update((state) => {
      const current = state.attempts.find((candidate) => candidate.attemptId === attempt.attemptId);
      if (current === undefined) throw new Error("attempt-not-found");
      if (terminalStage === "review" && !isCurrentReleasedReview(state, current)) {
        throw new Error("reconciliation-attempt-superseded");
      }
      const slot = state.slots.find((candidate) => candidate.id === current.slotId);
      if (slot?.attemptId !== current.attemptId) {
        if (!["review", "attention", "completed"].includes(current.stage)) {
          throw new Error("reconciliation-slot-conflict");
        }
        current.stage = terminalStage;
        current.updatedAt = now;
        if (errorCode !== undefined) current.errorCode = errorCode;
        recordAudit(state, {
          at: now,
          attemptId: current.attemptId,
          ...(errorCode === undefined ? {} : { errorCode }),
          eventId,
          issueNumber: current.issueNumber,
          result: terminalStage === "attention" ? "attention" : "success",
          slotId: current.slotId,
          stage: terminalStage,
        });
        return;
      }
      releaseAttempt(state, current.attemptId, terminalStage, now, errorCode);
      recordAudit(state, {
        at: now,
        attemptId: current.attemptId,
        ...(errorCode === undefined ? {} : { errorCode }),
        eventId,
        issueNumber: current.issueNumber,
        result: terminalStage === "attention" ? "attention" : "success",
        slotId: current.slotId,
        stage: terminalStage,
      });
    });
  }
}
