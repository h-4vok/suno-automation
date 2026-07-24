import {
  LIFECYCLE_LABELS,
  LoopStateSchema,
  deliveryKey,
  type AttemptRecord,
  type AttemptStage,
  type AuditEvent,
  type IssueCandidate,
  type LoopSlotId,
  type LoopState,
  type ReworkRequest,
  type SlotState,
} from "./schema.js";

export function singleLifecycleLabel(labels: readonly string[]): string | undefined {
  const lifecycles = labels.filter((label) =>
    (LIFECYCLE_LABELS as readonly string[]).includes(label),
  );
  return lifecycles.length === 1 ? lifecycles[0] : undefined;
}

export interface CandidateAnalysis {
  readonly blockers: ReadonlyMap<number, readonly string[]>;
  readonly eligible: readonly RankedCandidate[];
}

interface ReworkCandidate {
  readonly issue: IssueCandidate;
  readonly reason: "rework";
  readonly reworkRequest: ReworkRequest;
  readonly trigger: "rework";
}

interface ImplementationCandidate {
  readonly issue: IssueCandidate;
  readonly reason: Exclude<AttemptRecord["selectionReason"], "rework">;
  readonly reworkRequest?: never;
  readonly trigger: "implementation";
}

export type RankedCandidate = ReworkCandidate | ImplementationCandidate;

function lifecycleLabels(issue: IssueCandidate): readonly string[] {
  return issue.labels.filter((label) => (LIFECYCLE_LABELS as readonly string[]).includes(label));
}

function priority(issue: IssueCandidate): 0 | 1 | 2 | undefined {
  const priorities = issue.labels.flatMap((label) => {
    const match = /^priority:p([0-2])$/.exec(label);
    return match?.[1] === undefined ? [] : [Number(match[1]) as 0 | 1 | 2];
  });
  return priorities.length === 1 ? priorities[0] : undefined;
}

function isTrusted(login: string | undefined, trustedLogins: readonly string[]): boolean {
  return (
    login !== undefined &&
    trustedLogins.some((trusted) => trusted.toLowerCase() === login.toLowerCase())
  );
}

export function analyzeCandidates(
  issues: readonly IssueCandidate[],
  state: LoopState,
  trustedLogins: readonly string[],
): CandidateAnalysis {
  LoopStateSchema.parse(state);
  const blockers = new Map<number, readonly string[]>();
  const activeIssueNumbers = new Set(
    state.slots.flatMap((slot) => {
      if (slot.attemptId === undefined) return [];
      const attempt = state.attempts.find((candidate) => candidate.attemptId === slot.attemptId);
      return attempt === undefined ? [] : [attempt.issueNumber];
    }),
  );
  const eligible: RankedCandidate[] = [];

  for (const issue of issues) {
    const reasons: string[] = [];
    const lifecycles = lifecycleLabels(issue);
    const issuePriority = priority(issue);
    const request = state.reworkRequests
      .filter(
        (candidate) => candidate.issueNumber === issue.number && candidate.status === "queued",
      )
      .sort((left, right) => left.requestedAt.localeCompare(right.requestedAt))[0];

    if (issue.state !== "open") reasons.push("issue-closed");
    if (issue.labels.includes("type:epic")) reasons.push("epic");
    if (issue.labels.includes("manual-validation")) reasons.push("manual-validation");
    if (lifecycles.length !== 1) reasons.push("invalid-lifecycle");
    if (activeIssueNumbers.has(issue.number)) reasons.push("active-claim");
    if (issue.dependencies.some((dependency) => dependency.state !== "closed"))
      reasons.push("unresolved-dependency");

    if (lifecycles[0] === "codex-rework") {
      if (request === undefined) reasons.push("missing-trusted-rework-request");
      if (request !== undefined && !isTrusted(request.requestedBy, trustedLogins)) {
        reasons.push("untrusted-rework-request");
      }
      if (
        issue.linkedPullRequest?.state !== "open" ||
        !issue.linkedPullRequest.draft ||
        issue.linkedPullRequest.isCrossRepository
      ) {
        reasons.push("invalid-rework-pull-request");
      }
    } else if (lifecycles[0] === "codex-ready") {
      if (issuePriority === undefined) reasons.push("invalid-priority");
      if (!isTrusted(issue.promotion?.actor, trustedLogins)) {
        reasons.push("untrusted-promotion");
      }
      if (issue.linkedPullRequest !== undefined) reasons.push("conflicting-pull-request");
    } else {
      reasons.push("not-queued");
    }

    if (reasons.length > 0) {
      blockers.set(issue.number, reasons);
      continue;
    }

    if (lifecycles[0] === "codex-rework" && request !== undefined) {
      eligible.push({
        issue,
        reason: "rework",
        reworkRequest: request,
        trigger: "rework",
      });
    } else if (issuePriority !== undefined) {
      eligible.push({
        issue,
        reason: (["priority-p0", "priority-p1", "priority-p2"] as const)[issuePriority],
        trigger: "implementation",
      });
    }
  }

  eligible.sort((left, right) => {
    if (left.trigger !== right.trigger) return left.trigger === "rework" ? -1 : 1;
    if (left.trigger === "rework" && right.trigger === "rework") {
      const requestedOrder = left.reworkRequest.requestedAt.localeCompare(
        right.reworkRequest.requestedAt,
      );
      return requestedOrder || left.issue.number - right.issue.number;
    }
    const priorityOrder = (priority(left.issue) ?? 3) - (priority(right.issue) ?? 3);
    return (
      priorityOrder ||
      left.issue.createdAt.localeCompare(right.issue.createdAt) ||
      left.issue.number - right.issue.number
    );
  });

  return { blockers, eligible };
}

export function freeSlots(state: LoopState): readonly SlotState[] {
  return state.slots.filter((slot) => slot.status === "free");
}

export function createBranchName(issueNumber: number): string {
  return `codex/${issueNumber.toString()}-implementation`;
}

export interface ReserveAttemptInput {
  readonly attemptId: string;
  readonly candidate: RankedCandidate;
  readonly leaseExpiresAt: string;
  readonly now: string;
  readonly slotId: LoopSlotId;
}

export function reserveAttempt(state: LoopState, input: ReserveAttemptInput): AttemptRecord {
  const slot = state.slots.find((candidate) => candidate.id === input.slotId);
  if (slot?.status !== "free") throw new Error("slot-not-free");
  if (
    state.slots.some((candidate) => {
      if (candidate.attemptId === undefined) return false;
      return state.attempts.some(
        (attempt) =>
          attempt.attemptId === candidate.attemptId &&
          attempt.issueNumber === input.candidate.issue.number,
      );
    })
  ) {
    throw new Error("issue-already-active");
  }

  const parentAttempt = state.attempts
    .filter((attempt) => attempt.issueNumber === input.candidate.issue.number)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  const attempt: AttemptRecord = {
    attemptId: input.attemptId,
    branchName:
      input.candidate.trigger === "rework"
        ? input.candidate.issue.linkedPullRequest?.headRef
        : createBranchName(input.candidate.issue.number),
    createdAt: input.now,
    issueNumber: input.candidate.issue.number,
    issueUrl: input.candidate.issue.url,
    leaseExpiresAt: input.leaseExpiresAt,
    ...(parentAttempt === undefined ? {} : { parentAttemptId: parentAttempt.attemptId }),
    ...(input.candidate.trigger === "rework" && input.candidate.issue.linkedPullRequest
      ? {
          commitSha: input.candidate.issue.linkedPullRequest.headSha,
          pullRequest: {
            draft: true as const,
            number: input.candidate.issue.linkedPullRequest.number,
            url: input.candidate.issue.linkedPullRequest.url,
          },
        }
      : {}),
    repairPasses: 0,
    ...(input.candidate.reworkRequest === undefined
      ? {}
      : { reworkEventId: input.candidate.reworkRequest.eventId }),
    selectionReason: input.candidate.reason,
    slotId: input.slotId,
    stage: "reserved",
    trigger: input.candidate.trigger,
    updatedAt: input.now,
  };
  for (const prior of state.attempts) {
    if (
      prior.issueNumber === attempt.issueNumber &&
      prior.stage === "attention" &&
      prior.supersededByAttemptId === undefined
    ) {
      prior.supersededByAttemptId = attempt.attemptId;
      prior.updatedAt = input.now;
    }
  }
  state.attempts.push(attempt);
  Object.assign(slot, {
    attemptId: attempt.attemptId,
    leaseExpiresAt: input.leaseExpiresAt,
    status: "reserved",
  });
  if (input.candidate.reworkRequest) {
    input.candidate.reworkRequest.status = "claimed";
  }
  return attempt;
}

export function transitionAttempt(
  state: LoopState,
  attemptId: string,
  stage: AttemptStage,
  now: string,
  details: {
    readonly commitSha?: string;
    readonly errorCode?: string;
    readonly threadId?: string;
  } = {},
): AttemptRecord {
  const attempt = state.attempts.find((candidate) => candidate.attemptId === attemptId);
  if (attempt === undefined) throw new Error("attempt-not-found");
  attempt.stage = stage;
  attempt.updatedAt = now;
  if (details.commitSha !== undefined) attempt.commitSha = details.commitSha;
  if (details.errorCode !== undefined) attempt.errorCode = details.errorCode;
  if (details.threadId !== undefined) attempt.threadId = details.threadId;
  const slot = state.slots.find((candidate) => candidate.id === attempt.slotId);
  if (slot?.attemptId !== attemptId) throw new Error("slot-attempt-mismatch");
  if (stage === "running") slot.status = "running";
  if (stage === "attention") slot.status = "attention";
  return attempt;
}

export function releaseAttempt(
  state: LoopState,
  attemptId: string,
  terminalStage: "review" | "attention" | "completed",
  now: string,
  errorCode?: string,
): AttemptRecord {
  const attempt = state.attempts.find((candidate) => candidate.attemptId === attemptId);
  if (attempt === undefined) throw new Error("attempt-not-found");
  const slot = state.slots.find((candidate) => candidate.id === attempt.slotId);
  if (slot?.attemptId !== attemptId) throw new Error("slot-attempt-mismatch");
  attempt.stage = terminalStage;
  attempt.updatedAt = now;
  if (errorCode !== undefined) attempt.errorCode = errorCode;
  Object.assign(slot, { status: "free" });
  delete slot.attemptId;
  delete slot.leaseExpiresAt;
  if (attempt.trigger === "rework") {
    const request = state.reworkRequests
      .filter(
        (candidate) =>
          candidate.issueNumber === attempt.issueNumber && candidate.status === "claimed",
      )
      .sort((left, right) => right.requestedAt.localeCompare(left.requestedAt))[0];
    if (request) request.status = terminalStage === "review" ? "completed" : "rejected";
  }
  return attempt;
}

export function recordAudit(state: LoopState, event: AuditEvent): void {
  const key = deliveryKey(event.eventId, event.attemptId);
  const existing = state.audit.findIndex(
    (candidate) => candidate.eventId === event.eventId && candidate.attemptId === event.attemptId,
  );
  if (existing === -1) state.audit.push(event);
  else state.audit[existing] = event;
  if (!state.deliveredEvents.includes(key)) state.deliveredEvents.push(key);
}

export function hasDelivered(state: LoopState, eventId: string, attemptId: string): boolean {
  return state.deliveredEvents.includes(deliveryKey(eventId, attemptId));
}

export function lifecycleComment(input: {
  readonly attemptId: string;
  readonly errorCode?: string;
  readonly eventId: string;
  readonly result: "claimed" | "review" | "attention" | "rework-queued" | "completed";
  readonly stage: AttemptStage;
}): string {
  return `codex-lifecycle event=${input.eventId} attempt=${input.attemptId} result=${input.result} stage=${input.stage}${input.errorCode === undefined ? "" : ` error=${input.errorCode}`}`;
}

export function pruneAudit(
  state: LoopState,
  now: Date,
  retention: { readonly completedAttempts: number; readonly days: number },
): number {
  const cutoff = now.getTime() - retention.days * 24 * 60 * 60 * 1_000;
  const protectedAttempts = new Set([
    ...state.slots.flatMap((slot) => (slot.attemptId === undefined ? [] : [slot.attemptId])),
    ...state.attempts
      .filter(
        (attempt) =>
          // A released review attempt is retained only while it still represents an
          // actionable draft PR.  Retaining every historical review forever defeats
          // the bounded-retention contract.
          (attempt.stage === "review" && attempt.pullRequest?.draft === true) ||
          (attempt.stage === "attention" && attempt.supersededByAttemptId === undefined),
      )
      .map((attempt) => attempt.attemptId),
  ]);
  const completed = state.attempts
    .filter((attempt) => !protectedAttempts.has(attempt.attemptId))
    .sort(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) ||
        left.attemptId.localeCompare(right.attemptId),
    );
  const retainedCompleted = new Set(
    completed
      .filter(
        (attempt, index) =>
          index < retention.completedAttempts && Date.parse(attempt.updatedAt) >= cutoff,
      )
      .map((attempt) => attempt.attemptId),
  );
  const before = state.attempts.length;
  const retainedIds = new Set([...protectedAttempts, ...retainedCompleted]);
  state.attempts = state.attempts.filter((attempt) => retainedIds.has(attempt.attemptId));
  state.audit = state.audit.filter((event) => retainedIds.has(event.attemptId));
  state.deliveredEvents = state.deliveredEvents.filter((key) => {
    const parsed = JSON.parse(key) as [string, string];
    return retainedIds.has(parsed[1]);
  });

  const referencedReworkEvents = new Set(
    state.attempts.flatMap((attempt) =>
      attempt.reworkEventId === undefined ? [] : [attempt.reworkEventId],
    ),
  );
  const activeReworkEvents = new Set(
    state.reworkRequests
      .filter((request) => ["queued", "claimed"].includes(request.status))
      .map((request) => request.eventId),
  );
  const retainedTerminalReworkEvents = new Set(
    state.reworkRequests
      .filter(
        (request) =>
          !["queued", "claimed"].includes(request.status) &&
          !referencedReworkEvents.has(request.eventId) &&
          Date.parse(request.requestedAt) >= cutoff,
      )
      .sort(
        (left, right) =>
          right.requestedAt.localeCompare(left.requestedAt) ||
          left.eventId.localeCompare(right.eventId),
      )
      .slice(0, retention.completedAttempts)
      .map((request) => request.eventId),
  );
  state.reworkRequests = state.reworkRequests.filter(
    (request) =>
      activeReworkEvents.has(request.eventId) ||
      referencedReworkEvents.has(request.eventId) ||
      retainedTerminalReworkEvents.has(request.eventId),
  );

  const retainedRequestEvents = new Set(state.reworkRequests.map((request) => request.eventId));
  // A queued decision is the durable, privacy-safe counter for a consumed rework
  // pass. Keep at most the policy limit per issue even after the full request and
  // attempt records age out, otherwise retention could silently reset the 3-pass cap.
  const reworkCounterCounts = new Map<number, number>();
  const retainedReworkCounters = new Set<string>();
  for (const event of [...state.reworkAudit]
    .filter((candidate) => candidate.result === "queued")
    .sort(
      (left, right) =>
        left.issueNumber - right.issueNumber ||
        right.at.localeCompare(left.at) ||
        left.eventId.localeCompare(right.eventId),
    )) {
    const count = reworkCounterCounts.get(event.issueNumber) ?? 0;
    if (count >= 3) continue;
    reworkCounterCounts.set(event.issueNumber, count + 1);
    retainedReworkCounters.add(event.eventId);
  }
  const retainedStandaloneReworkAudit = new Set(
    state.reworkAudit
      .filter(
        (event) =>
          !retainedRequestEvents.has(event.eventId) &&
          !referencedReworkEvents.has(event.eventId) &&
          Date.parse(event.at) >= cutoff,
      )
      .sort(
        (left, right) =>
          right.at.localeCompare(left.at) || left.eventId.localeCompare(right.eventId),
      )
      .slice(0, retention.completedAttempts)
      .map((event) => event.eventId),
  );
  state.reworkAudit = state.reworkAudit.filter(
    (event) =>
      retainedRequestEvents.has(event.eventId) ||
      referencedReworkEvents.has(event.eventId) ||
      retainedReworkCounters.has(event.eventId) ||
      retainedStandaloneReworkAudit.has(event.eventId),
  );

  const retainedMaintenanceEvents = new Set(
    state.maintenanceAudit
      .filter((event) => Date.parse(event.at) >= cutoff)
      .sort(
        (left, right) =>
          right.at.localeCompare(left.at) || left.eventId.localeCompare(right.eventId),
      )
      .slice(0, retention.completedAttempts)
      .map((event) => event.eventId),
  );
  state.maintenanceAudit = state.maintenanceAudit.filter((event) =>
    retainedMaintenanceEvents.has(event.eventId),
  );
  return before - state.attempts.length;
}
