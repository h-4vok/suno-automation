import { z } from "zod";

import type { AttemptRecord, LoopConfig, LoopSlotId } from "./schema.js";

const TimestampSchema = z.iso.datetime({ offset: true });
const SafeIdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const GitHubLoginSchema = z
  .string()
  .trim()
  .min(1)
  .max(39)
  .regex(/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i);

export const DispatcherCapabilityEvidenceSchema = z
  .object({
    observedAt: TimestampSchema,
    projects: z.tuple([
      z
        .object({
          available: z.literal(true),
          projectId: SafeIdentifierSchema,
          slotId: z.literal("worker-1"),
        })
        .strict(),
      z
        .object({
          available: z.literal(true),
          projectId: SafeIdentifierSchema,
          slotId: z.literal("worker-2"),
        })
        .strict(),
    ]),
    source: z.literal("codex-desktop"),
    threadControl: z.literal(true),
    version: z.literal(1),
  })
  .strict();
export type DispatcherCapabilityEvidence = z.infer<typeof DispatcherCapabilityEvidenceSchema>;

// Codex Desktop can prove a task previously existed but is now inactive. That is negative
// operational evidence just like absence, while `unknown` remains fail-closed.
const RecoveryStateSchema = z.enum(["active", "absent", "inactive", "unknown"]);

export const LeaseRecoveryEvidenceSchema = z
  .object({
    actor: GitHubLoginSchema,
    attemptId: SafeIdentifierSchema,
    branchOperation: RecoveryStateSchema,
    consistent: z.boolean(),
    linkedPullRequest: RecoveryStateSchema,
    observedAt: TimestampSchema,
    process: RecoveryStateSchema,
    task: RecoveryStateSchema,
    version: z.literal(1),
    worktreeOperation: RecoveryStateSchema,
  })
  .strict();
export type LeaseRecoveryEvidence = z.infer<typeof LeaseRecoveryEvidenceSchema>;

export type LeaseRecoveryDecision =
  "lease-active" | "active-evidence" | "safe-expired" | "ambiguous-evidence";

const EVIDENCE_FRESHNESS_MS = 5 * 60 * 1_000;

function assertFreshEvidence(observedAt: string, now: Date, errorCode: string): number {
  const observedAtMs = Date.parse(observedAt);
  if (
    !Number.isFinite(observedAtMs) ||
    Math.abs(now.getTime() - observedAtMs) > EVIDENCE_FRESHNESS_MS
  ) {
    throw new Error(errorCode);
  }
  return observedAtMs;
}

export function validateDispatcherCapabilities(
  config: LoopConfig,
  rawEvidence: unknown,
  now: Date,
): DispatcherCapabilityEvidence {
  const evidence = DispatcherCapabilityEvidenceSchema.parse(rawEvidence);
  assertFreshEvidence(evidence.observedAt, now, "dispatcher-capability-evidence-stale");
  for (const [index, slot] of config.slots.entries()) {
    const project = evidence.projects[index];
    if (project?.slotId !== slot.id || project.projectId !== slot.projectId) {
      throw new Error("dispatcher-project-capability-conflict");
    }
  }
  return evidence;
}

export function decideLeaseRecovery(
  attempt: AttemptRecord,
  rawEvidence: unknown,
  trustedLogins: readonly string[],
  now: Date,
): LeaseRecoveryDecision {
  const evidence = LeaseRecoveryEvidenceSchema.parse(rawEvidence);
  if (!trustedLogins.some((login) => login.toLowerCase() === evidence.actor.toLowerCase())) {
    throw new Error("untrusted-recovery-actor");
  }
  if (evidence.attemptId !== attempt.attemptId) {
    throw new Error("recovery-attempt-conflict");
  }
  const observedAtMs = assertFreshEvidence(evidence.observedAt, now, "recovery-evidence-stale");
  if (Date.parse(attempt.leaseExpiresAt) > now.getTime()) return "lease-active";
  if (
    observedAtMs < Date.parse(attempt.createdAt) ||
    observedAtMs < Date.parse(attempt.leaseExpiresAt)
  ) {
    throw new Error("recovery-evidence-precedes-attempt-expiry");
  }
  const states = [
    evidence.task,
    evidence.process,
    evidence.worktreeOperation,
    evidence.branchOperation,
    evidence.linkedPullRequest,
  ];
  if (states.includes("active")) return "active-evidence";
  if (!evidence.consistent || states.includes("unknown")) return "ambiguous-evidence";
  return "safe-expired";
}

export const TaskEvidenceSchema = z
  .object({
    attemptId: SafeIdentifierSchema,
    observedAt: TimestampSchema,
    source: z.literal("codex-desktop"),
    state: z.enum(["active", "absent", "inactive", "unknown"]),
    threadId: SafeIdentifierSchema.optional(),
    version: z.literal(1),
  })
  .strict()
  .superRefine((evidence, context) => {
    if (["active", "inactive"].includes(evidence.state) && evidence.threadId === undefined) {
      context.addIssue({
        code: "custom",
        message: "Existing task evidence requires its exact task identifier.",
        path: ["threadId"],
      });
    }
  });
export const TaskEvidenceSetSchema = z
  .array(TaskEvidenceSchema)
  .max(100)
  .superRefine((evidence, context) => {
    if (evidence.filter((item) => item.state === "active").length > 2) {
      context.addIssue({
        code: "custom",
        message: "At most two active-slot task observations are allowed.",
      });
    }
  });
export type TaskEvidence = z.infer<typeof TaskEvidenceSchema>;

export function taskEvidenceFor(
  attempt: AttemptRecord,
  evidence: readonly TaskEvidence[],
  now: Date,
): TaskEvidence {
  const matches = evidence.filter((candidate) => candidate.attemptId === attempt.attemptId);
  if (matches.length !== 1) {
    return {
      attemptId: attempt.attemptId,
      observedAt: now.toISOString(),
      source: "codex-desktop",
      state: "unknown",
      version: 1,
    };
  }
  const match = matches[0];
  if (match === undefined) {
    return {
      attemptId: attempt.attemptId,
      observedAt: now.toISOString(),
      source: "codex-desktop",
      state: "unknown",
      version: 1,
    };
  }
  const observedAtMs = Date.parse(match.observedAt);
  if (
    !Number.isFinite(observedAtMs) ||
    Math.abs(now.getTime() - observedAtMs) > EVIDENCE_FRESHNESS_MS ||
    (["active", "inactive"].includes(match.state) &&
      (match.threadId === undefined || match.threadId !== attempt.threadId))
  ) {
    return { ...match, state: "unknown" };
  }
  return match;
}

export function occupiedSlotIds(attempts: readonly AttemptRecord[]): readonly LoopSlotId[] {
  return attempts
    .filter((attempt) =>
      [
        "reserved",
        "claimed",
        "launch-pending",
        "running",
        "prepared",
        "implemented",
        "committed",
        "verified",
        "pushed",
        "pr-linked",
      ].includes(attempt.stage),
    )
    .map((attempt) => attempt.slotId);
}

export function assertPublicationGate(attempt: AttemptRecord, signatureValid: boolean): void {
  if (
    !["pushed", "pr-linked"].includes(attempt.stage) ||
    attempt.verification?.status !== "pass" ||
    attempt.verification.attemptId !== attempt.attemptId ||
    attempt.verification.slotId !== attempt.slotId ||
    attempt.verification.commitSha !== attempt.commitSha ||
    !signatureValid
  ) {
    throw new Error("publication-gate-not-satisfied");
  }
}

export function assertDraftPullRequestForAttempt(
  attempt: AttemptRecord,
  pullRequest: {
    readonly baseRef: string;
    readonly draft: boolean;
    readonly headRef: string;
    readonly headRepositoryOwner: string;
    readonly headSha: string;
    readonly isCrossRepository: boolean;
    readonly number: number;
    readonly state: "open" | "closed" | "merged";
  },
  baseRef: string,
  repositoryOwner: string,
): void {
  if (!pullRequest.draft || pullRequest.state !== "open") {
    throw new Error("draft-pull-request-required");
  }
  if (
    attempt.branchName === undefined ||
    pullRequest.baseRef !== baseRef ||
    pullRequest.isCrossRepository ||
    pullRequest.headRepositoryOwner.toLowerCase() !== repositoryOwner.toLowerCase() ||
    pullRequest.headRef !== attempt.branchName ||
    pullRequest.headSha !== attempt.commitSha ||
    (attempt.pullRequest !== undefined && attempt.pullRequest.number !== pullRequest.number)
  ) {
    throw new Error("pull-request-identity-conflict");
  }
}

export interface ReworkPolicyInput {
  readonly approvedFeedbackIds: readonly string[];
  readonly baseCommit: string;
  readonly feedback: readonly {
    readonly createdAt: string;
    readonly id: string;
    readonly resolved: boolean;
  }[];
  readonly headCommitAt: string;
  readonly headSha: string;
  readonly issue: {
    readonly draft: boolean;
    readonly lifecycle: string | undefined;
    readonly linkedPullRequestNumber: number | undefined;
    readonly linkedPullRequestState: "open" | "closed" | "merged" | undefined;
    readonly state: "open" | "closed";
  };
  readonly priorReworks: number;
  readonly prNumber: number;
  readonly requestActor: string;
  readonly trustedLogins: readonly string[];
}

export function reworkPolicyError(input: ReworkPolicyInput): string | undefined {
  if (
    !input.trustedLogins.some((login) => login.toLowerCase() === input.requestActor.toLowerCase())
  ) {
    return "untrusted-rework-actor";
  }
  if (
    input.issue.state !== "open" ||
    input.issue.lifecycle !== "codex-review" ||
    input.issue.linkedPullRequestNumber !== input.prNumber ||
    input.issue.linkedPullRequestState !== "open" ||
    !input.issue.draft
  ) {
    return "rework-state-conflict";
  }
  if (input.priorReworks >= 3) return "rework-attempt-limit";
  const headCommitAt = Date.parse(input.headCommitAt);
  if (
    !/^[a-f\d]{7,64}$/i.test(input.headSha) ||
    !/^[a-f\d]{7,64}$/i.test(input.baseCommit) ||
    !Number.isFinite(headCommitAt) ||
    input.feedback.some((feedback) => !Number.isFinite(Date.parse(feedback.createdAt)))
  ) {
    return "rework-feedback-conflict";
  }
  const feedbackById = new Map(input.feedback.map((feedback) => [feedback.id, feedback]));
  if (
    input.headSha !== input.baseCommit ||
    input.feedback.length !== input.approvedFeedbackIds.length ||
    input.approvedFeedbackIds.some((id) => {
      const feedback = feedbackById.get(id);
      return (
        feedback === undefined ||
        feedback.resolved ||
        Date.parse(feedback.createdAt) <= headCommitAt
      );
    })
  ) {
    return "rework-feedback-conflict";
  }
  return undefined;
}

export type ReconciliationRecommendation =
  | "leave-running"
  | "resume-thread"
  | "finalize-review"
  | "release-review-slot"
  | "complete-merged"
  | "move-to-attention";

export interface ReconciliationPolicyInput {
  readonly attemptStage: AttemptRecord["stage"];
  readonly issueState: "open" | "closed";
  readonly lifecycle: string | undefined;
  readonly localBranch: "attempt" | "parked" | "other";
  readonly localUnsafe: boolean;
  readonly pullRequest:
    | {
        readonly draft: boolean;
        readonly state: "open" | "closed" | "merged";
      }
    | undefined;
  readonly stale: boolean;
  readonly taskState: "active" | "absent" | "inactive" | "unknown";
  readonly threadRecorded: boolean;
}

export function reconciliationRecommendation(
  input: ReconciliationPolicyInput,
): ReconciliationRecommendation {
  const pr = input.pullRequest;
  if (pr?.state === "merged" && input.issueState === "closed") {
    if (input.taskState === "active") return "leave-running";
    if (input.localUnsafe || input.taskState === "unknown" || input.localBranch !== "parked") {
      return "move-to-attention";
    }
    return "complete-merged";
  }
  if (pr?.state === "closed") return "move-to-attention";
  if (input.lifecycle === "codex-review" && pr?.state === "open" && pr.draft) {
    if (input.localUnsafe || input.taskState === "unknown") return "move-to-attention";
    if (input.taskState === "active") return "leave-running";
    if (input.localBranch === "parked") return "release-review-slot";
    return input.localBranch === "attempt" ? "finalize-review" : "move-to-attention";
  }
  if (input.attemptStage === "pr-linked" && pr?.state === "open" && pr.draft) {
    if (input.localUnsafe || input.taskState === "unknown") return "move-to-attention";
    if (input.taskState === "active") return "leave-running";
    return input.localBranch === "attempt" ? "finalize-review" : "move-to-attention";
  }
  if (
    input.issueState === "closed" ||
    input.localUnsafe ||
    (input.stale && input.taskState !== "active") ||
    input.taskState === "unknown"
  ) {
    return "move-to-attention";
  }
  if (input.taskState === "active") return "leave-running";
  if (
    input.taskState === "absent" &&
    input.attemptStage === "launch-pending" &&
    !input.threadRecorded
  ) {
    return "resume-thread";
  }
  return "move-to-attention";
}
