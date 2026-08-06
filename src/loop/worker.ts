import {
  hasDelivered,
  lifecycleComment,
  recordAudit,
  releaseAttempt,
  singleLifecycleLabel,
  transitionAttempt,
} from "./domain.js";
import type { WorkerGitPort } from "./git.js";
import type { GitHubLoopPort } from "./github.js";
import {
  assertDraftPullRequestForAttempt,
  assertPublicationGate,
  reworkPolicyError,
} from "./policy.js";
import {
  ReworkRequestSchema,
  type AttemptRecord,
  type AttemptStage,
  type LoopConfig,
  type LoopSlotConfig,
  type ReworkRequest,
} from "./schema.js";
import type { LoopStateStore } from "./store.js";
import { verifyVerdictSignature } from "./verification.js";

const STAGE_ORDER: readonly AttemptStage[] = [
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
  "review",
  "attention",
  "completed",
];

export interface WorkerServiceOptions {
  readonly now?: () => Date;
}

function recordStageAudit(
  state: Parameters<typeof recordAudit>[0],
  attempt: AttemptRecord,
  stage: AttemptStage,
  at: string,
): void {
  const eventId = `stage-${stage}`;
  if (hasDelivered(state, eventId, attempt.attemptId)) return;
  recordAudit(state, {
    at,
    attemptId: attempt.attemptId,
    eventId,
    issueNumber: attempt.issueNumber,
    result: "success",
    slotId: attempt.slotId,
    stage,
  });
}

export class LoopWorkerService {
  readonly #config: LoopConfig;
  readonly #git: WorkerGitPort;
  readonly #github: GitHubLoopPort;
  readonly #now: () => Date;
  readonly #store: LoopStateStore;

  constructor(
    config: LoopConfig,
    store: LoopStateStore,
    github: GitHubLoopPort,
    git: WorkerGitPort,
    options: WorkerServiceOptions = {},
  ) {
    this.#config = config;
    this.#store = store;
    this.#github = github;
    this.#git = git;
    this.#now = options.now ?? (() => new Date());
  }

  async prepare(attemptId: string): Promise<AttemptRecord> {
    const state = await this.#store.read();
    const attempt = state.attempts.find((candidate) => candidate.attemptId === attemptId);
    if (attempt === undefined) throw new Error("attempt-not-found");
    const reworkRequest =
      attempt.trigger === "rework" && attempt.reworkEventId !== undefined
        ? state.reworkRequests.find((request) => request.eventId === attempt.reworkEventId)
        : undefined;
    if (
      STAGE_ORDER.indexOf(attempt.stage) >= STAGE_ORDER.indexOf("prepared") &&
      !["attention", "completed"].includes(attempt.stage)
    ) {
      return attempt;
    }
    if (attempt.stage !== "running") throw new Error("attempt-not-running");
    if (Date.parse(attempt.leaseExpiresAt) <= this.#now().getTime()) {
      throw new Error("lease-expired");
    }
    const issue = await this.#github.getIssue(attempt.issueNumber);
    if (
      issue.state !== "open" ||
      singleLifecycleLabel(issue.labels) !== "codex-in-progress" ||
      issue.dependencies.some((dependency) => dependency.state !== "closed")
    ) {
      throw new Error("issue-revalidation-failed");
    }
    if (attempt.trigger === "implementation" && issue.linkedPullRequest !== undefined) {
      throw new Error("unexpected-linked-pull-request");
    }
    if (attempt.trigger === "rework") {
      const pullRequest = issue.linkedPullRequest;
      if (pullRequest === undefined) throw new Error("rework-pull-request-conflict");
      if (reworkRequest === undefined) throw new Error("rework-pull-request-conflict");
      if (
        attempt.pullRequest === undefined ||
        attempt.reworkEventId === undefined ||
        attempt.commitSha === undefined ||
        reworkRequest.baseCommit !== pullRequest.headSha ||
        attempt.commitSha !== pullRequest.headSha ||
        pullRequest.number !== attempt.pullRequest.number ||
        pullRequest.state !== "open" ||
        !pullRequest.draft ||
        pullRequest.baseRef !== this.#config.repository.baseBranch ||
        pullRequest.isCrossRepository ||
        pullRequest.headRepositoryOwner.toLowerCase() !==
          this.#config.repository.owner.toLowerCase() ||
        pullRequest.headRef !== attempt.branchName
      ) {
        throw new Error("rework-pull-request-conflict");
      }
    }
    const slot = this.#slot(attempt);
    await this.#git.prepare(slot, this.#config.repository.baseBranch, attempt);
    const now = this.#now().toISOString();
    return this.#store.update((draft) => {
      const prepared = transitionAttempt(draft, attemptId, "prepared", now);
      recordStageAudit(draft, prepared, "prepared", now);
      return structuredClone(prepared);
    });
  }

  async checkpoint(
    attemptId: string,
    stage: "implemented" | "committed",
    commitSha?: string,
  ): Promise<AttemptRecord> {
    const now = this.#now().toISOString();
    return this.#store.update((state) => {
      const attempt = state.attempts.find((candidate) => candidate.attemptId === attemptId);
      if (attempt === undefined) throw new Error("attempt-not-found");
      const currentIndex = STAGE_ORDER.indexOf(attempt.stage);
      const targetIndex = STAGE_ORDER.indexOf(stage);
      if (stage === "implemented" && currentIndex >= targetIndex) {
        recordStageAudit(state, attempt, stage, now);
        return structuredClone(attempt);
      }
      if (stage === "committed" && currentIndex >= targetIndex) {
        if (commitSha === undefined) throw new Error("commit-sha-required");
        if (attempt.commitSha !== commitSha) throw new Error("commit-sha-conflict");
        recordStageAudit(state, attempt, stage, now);
        return structuredClone(attempt);
      }
      if (
        (stage === "implemented" && attempt.stage !== "prepared") ||
        (stage === "committed" && !["implemented", "committed"].includes(attempt.stage))
      ) {
        throw new Error("invalid-worker-stage");
      }
      if (stage === "committed" && commitSha === undefined) {
        throw new Error("commit-sha-required");
      }
      const checkpointed = transitionAttempt(state, attemptId, stage, now, {
        ...(commitSha === undefined ? {} : { commitSha }),
      });
      recordStageAudit(state, checkpointed, stage, now);
      return structuredClone(checkpointed);
    });
  }

  async push(attemptId: string, verificationKey: string): Promise<AttemptRecord> {
    const state = await this.#store.read();
    const attempt = state.attempts.find((candidate) => candidate.attemptId === attemptId);
    if (attempt === undefined) throw new Error("attempt-not-found");
    if (attempt.stage === "pushed" || attempt.stage === "pr-linked") return attempt;
    if (
      attempt.stage !== "verified" ||
      attempt.verification?.status !== "pass" ||
      attempt.verification.attemptId !== attempt.attemptId ||
      attempt.verification.slotId !== attempt.slotId ||
      !verifyVerdictSignature(attempt.verification, verificationKey) ||
      attempt.commitSha !== attempt.verification.commitSha
    ) {
      throw new Error("verified-commit-required");
    }
    const evidence = await this.#git.push(this.#slot(attempt), attempt);
    if (evidence.commitSha !== attempt.commitSha) throw new Error("pushed-commit-mismatch");
    const now = this.#now().toISOString();
    return this.#store.update((draft) => {
      const pushed = transitionAttempt(draft, attemptId, "pushed", now, {
        commitSha: evidence.commitSha,
      });
      recordStageAudit(draft, pushed, "pushed", now);
      return structuredClone(pushed);
    });
  }

  async finalizeReview(attemptId: string, verificationKey: string): Promise<AttemptRecord> {
    let state = await this.#store.read();
    let attempt = state.attempts.find((candidate) => candidate.attemptId === attemptId);
    if (attempt === undefined) throw new Error("attempt-not-found");
    if (attempt.stage === "review") return attempt;
    assertPublicationGate(
      attempt,
      attempt.verification === undefined
        ? false
        : verifyVerdictSignature(attempt.verification, verificationKey),
    );
    if (attempt.commitSha === undefined || attempt.commitSha !== attempt.verification?.commitSha) {
      throw new Error("publication-gate-not-satisfied");
    }
    const slot = this.#slot(attempt);
    const pullRequest =
      attempt.stage === "pushed"
        ? await this.#createOrReusePullRequest(attemptId, slot, attempt)
        : await this.#revalidateLinkedPullRequest(attempt);
    assertDraftPullRequestForAttempt(
      attempt,
      pullRequest,
      this.#config.repository.baseBranch,
      this.#config.repository.owner,
    );
    const now = this.#now().toISOString();
    if (attempt.stage === "pushed") {
      await this.#store.update((draft) => {
        const target = transitionAttempt(draft, attemptId, "pr-linked", now);
        target.pullRequest = {
          draft: true,
          number: pullRequest.number,
          url: pullRequest.url,
        };
        recordStageAudit(draft, target, "pr-linked", now);
      });
    }
    state = await this.#store.read();
    attempt = state.attempts.find((candidate) => candidate.attemptId === attemptId);
    if (attempt === undefined) throw new Error("attempt-not-found");
    const eventId = `review-${attemptId}`;
    if (!hasDelivered(state, eventId, attemptId)) {
      await this.#github.transitionIssue({
        attemptId,
        comment: lifecycleComment({
          attemptId,
          eventId,
          result: "review",
          stage: "review",
        }),
        eventId,
        from: "codex-in-progress",
        issueNumber: attempt.issueNumber,
        to: "codex-review",
      });
      await this.#store.update((draft) => {
        if (hasDelivered(draft, eventId, attemptId)) return;
        recordAudit(draft, {
          at: now,
          attemptId,
          eventId,
          issueNumber: attempt.issueNumber,
          result: "pending",
          slotId: attempt.slotId,
          stage: "pr-linked",
        });
      });
    }
    await this.#git.park(slot, this.#config.repository.baseBranch, attempt);
    return this.#store.update((draft) => {
      const released = releaseAttempt(draft, attemptId, "review", now);
      recordAudit(draft, {
        at: now,
        attemptId,
        eventId,
        issueNumber: released.issueNumber,
        result: "success",
        slotId: released.slotId,
        stage: "review",
      });
      return structuredClone(released);
    });
  }

  async finalizeAttention(attemptId: string, errorCode: string): Promise<AttemptRecord> {
    const now = this.#now().toISOString();
    const local = await this.#store.update((state) => {
      const existing = state.attempts.find((candidate) => candidate.attemptId === attemptId);
      if (existing === undefined) throw new Error("attempt-not-found");
      if (
        existing.stage === "attention" &&
        existing.errorCode !== undefined &&
        existing.errorCode !== errorCode
      ) {
        throw new Error("attention-error-conflict");
      }
      const slot = state.slots.find((candidate) => candidate.id === existing.slotId);
      if (
        existing.stage === "attention" &&
        slot?.status === "free" &&
        slot.attemptId === undefined
      ) {
        return { attempt: structuredClone(existing), released: true };
      }
      const target = transitionAttempt(state, attemptId, "attention", now, { errorCode });
      recordAudit(state, {
        at: now,
        attemptId,
        errorCode,
        eventId: `attention-${attemptId}`,
        issueNumber: target.issueNumber,
        result: "attention",
        slotId: target.slotId,
        stage: "attention",
      });
      return { attempt: structuredClone(target), released: false };
    });
    if (local.released) return local.attempt;
    const attempt = local.attempt;
    const eventId = `attention-${attemptId}`;
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
      from: "codex-in-progress",
      issueNumber: attempt.issueNumber,
      to: "codex-needs-attention",
    });
    return this.#store.update((state) =>
      structuredClone(releaseAttempt(state, attemptId, "attention", now, errorCode)),
    );
  }

  #slot(attempt: AttemptRecord) {
    const slot = this.#config.slots.find((candidate) => candidate.id === attempt.slotId);
    if (slot === undefined) throw new Error("slot-config-missing");
    return slot;
  }

  async #createOrReusePullRequest(attemptId: string, slot: LoopSlotConfig, attempt: AttemptRecord) {
    if (attempt.verification === undefined) throw new Error("verification-missing");
    const evidence = await this.#git.publicationEvidence(slot, attempt);
    if (evidence.commitSha !== attempt.verification.commitSha) {
      throw new Error("published-commit-verdict-mismatch");
    }
    return this.#github.ensureDraftPullRequest({
      attemptId,
      baseRef: this.#config.repository.baseBranch,
      body: this.#pullRequestBody(attempt),
      expectedHeadSha: attempt.verification.commitSha,
      headRef: evidence.branchName,
      issueNumber: attempt.issueNumber,
      title: `[#${attempt.issueNumber.toString()}] Automated issue implementation`,
    });
  }

  async #revalidateLinkedPullRequest(attempt: AttemptRecord) {
    if (attempt.pullRequest === undefined || attempt.branchName === undefined) {
      throw new Error("linked-pull-request-missing");
    }
    const pullRequest = await this.#github.getPullRequest(attempt.pullRequest.number);
    if (
      pullRequest.number !== attempt.pullRequest.number ||
      pullRequest.baseRef !== this.#config.repository.baseBranch ||
      pullRequest.isCrossRepository ||
      pullRequest.headRepositoryOwner.toLowerCase() !==
        this.#config.repository.owner.toLowerCase() ||
      pullRequest.headRef !== attempt.branchName ||
      pullRequest.headSha !== attempt.commitSha
    ) {
      throw new Error("pull-request-identity-conflict");
    }
    return pullRequest;
  }

  #pullRequestBody(attempt: AttemptRecord): string {
    if (attempt.verification === undefined) throw new Error("verification-missing");
    const commands = attempt.verification.commands
      .map((command) => `- ${command.name}: ${command.status}`)
      .join("\n");
    return `## Summary

Closes #${attempt.issueNumber.toString()}.

Implements only that bounded contract.

## Verification

${commands}

Commit: \`${attempt.verification.commitSha}\`

## Safety

- No live Suno access or credit-consuming action was performed.
- This pull request is draft-only and requires human review.

Attempt: \`${attempt.attemptId}\`
`;
  }
}

export interface QueueReworkInput {
  readonly approvedFeedbackIds: readonly string[];
  readonly baseCommit: string;
  readonly eventId: string;
  readonly issueNumber: number;
  readonly prNumber: number;
}

const QueueReworkInputSchema = ReworkRequestSchema.pick({
  approvedFeedbackIds: true,
  baseCommit: true,
  eventId: true,
  issueNumber: true,
  prNumber: true,
});

export async function queueTrustedRework(
  config: LoopConfig,
  store: LoopStateStore,
  github: GitHubLoopPort,
  input: QueueReworkInput,
): Promise<ReworkRequest> {
  input = QueueReworkInputSchema.parse(input);
  const existingState = await store.read();
  const existing = existingState.reworkRequests.find(
    (request) => request.eventId === input.eventId,
  );
  if (existing !== undefined) {
    if (
      existing.baseCommit !== input.baseCommit ||
      existing.issueNumber !== input.issueNumber ||
      existing.prNumber !== input.prNumber ||
      existing.approvedFeedbackIds.length !== input.approvedFeedbackIds.length ||
      existing.approvedFeedbackIds.some(
        (feedbackId, index) => feedbackId !== input.approvedFeedbackIds[index],
      )
    ) {
      throw new Error("rework-event-conflict");
    }
    if (existing.status === "queued") {
      await github.transitionIssue({
        attemptId: existing.eventId,
        comment: lifecycleComment({
          attemptId: existing.eventId,
          eventId: existing.eventId,
          result: "rework-queued",
          stage: "review",
        }),
        eventId: existing.eventId,
        from: "codex-review",
        issueNumber: existing.issueNumber,
        to: "codex-rework",
      });
    }
    return existing;
  }
  if (existingState.reworkAudit.some((event) => event.eventId === input.eventId)) {
    throw new Error("rework-event-conflict");
  }
  if (github.getReworkAuthorization === undefined) {
    throw new Error("rework-evidence-port-unavailable");
  }
  if (new Set(input.approvedFeedbackIds).size !== input.approvedFeedbackIds.length) {
    throw new Error("duplicate-feedback-id");
  }
  const authorization = await github.getReworkAuthorization(input);
  const issue = await github.getIssue(input.issueNumber);
  const lifecycle = singleLifecycleLabel(issue.labels);
  const priorReworks = existingState.attempts.filter(
    (attempt) => attempt.issueNumber === input.issueNumber && attempt.trigger === "rework",
  );
  const priorReworkEvents = new Set([
    ...priorReworks.map((attempt) => attempt.reworkEventId ?? attempt.attemptId),
    ...existingState.reworkRequests
      .filter((request) => request.issueNumber === input.issueNumber)
      .map((request) => request.eventId),
    ...existingState.reworkAudit
      .filter((event) => event.issueNumber === input.issueNumber && event.result === "queued")
      .map((event) => event.eventId),
  ]);
  const policyError = reworkPolicyError({
    approvedFeedbackIds: input.approvedFeedbackIds,
    baseCommit: input.baseCommit,
    feedback: authorization.feedback,
    headCommitAt: authorization.headCommitAt,
    headSha: authorization.headSha,
    issue: {
      draft: issue.linkedPullRequest?.draft ?? false,
      lifecycle,
      linkedPullRequestNumber: issue.linkedPullRequest?.number,
      linkedPullRequestState: issue.linkedPullRequest?.state,
      state: issue.state,
    },
    priorReworks: priorReworkEvents.size,
    prNumber: input.prNumber,
    requestActor: authorization.requestActor,
    trustedLogins: config.trustedLogins,
  });
  if (policyError !== undefined) {
    await recordReworkDecision(store, input, authorization.requestedAt, policyError);
    if (["rework-attempt-limit", "rework-feedback-conflict"].includes(policyError)) {
      await moveReworkToAttention(github, input, policyError);
    }
    throw new Error(policyError);
  }
  const request = ReworkRequestSchema.parse({
    ...input,
    requestedAt: authorization.requestedAt,
    requestedBy: authorization.requestActor,
    status: "queued",
  });
  await store.update((state) => {
    if (!state.reworkRequests.some((candidate) => candidate.eventId === request.eventId)) {
      state.reworkRequests.push(request);
    }
    if (!state.reworkAudit.some((candidate) => candidate.eventId === request.eventId)) {
      state.reworkAudit.push({
        at: request.requestedAt,
        eventId: request.eventId,
        issueNumber: request.issueNumber,
        result: "queued",
      });
    }
  });
  await github.transitionIssue({
    attemptId: request.eventId,
    comment: lifecycleComment({
      attemptId: request.eventId,
      eventId: request.eventId,
      result: "rework-queued",
      stage: "review",
    }),
    eventId: request.eventId,
    from: "codex-review",
    issueNumber: request.issueNumber,
    to: "codex-rework",
  });
  return request;
}

async function recordReworkDecision(
  store: LoopStateStore,
  input: QueueReworkInput,
  at: string,
  safeReason: string,
): Promise<void> {
  await store.update((state) => {
    if (!state.reworkAudit.some((candidate) => candidate.eventId === input.eventId)) {
      state.reworkAudit.push({
        at,
        eventId: input.eventId,
        issueNumber: input.issueNumber,
        result: "rejected",
        safeReason,
      });
    }
  });
}

async function moveReworkToAttention(
  github: GitHubLoopPort,
  input: QueueReworkInput,
  errorCode: string,
): Promise<void> {
  await github.transitionIssue({
    attemptId: input.eventId,
    comment: lifecycleComment({
      attemptId: input.eventId,
      errorCode,
      eventId: input.eventId,
      result: "attention",
      stage: "attention",
    }),
    eventId: input.eventId,
    from: "codex-review",
    issueNumber: input.issueNumber,
    to: "codex-needs-attention",
  });
}
