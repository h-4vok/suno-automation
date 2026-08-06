import { randomUUID } from "node:crypto";

import {
  analyzeCandidates,
  freeSlots,
  hasDelivered,
  lifecycleComment,
  pruneAudit,
  recordAudit,
  releaseAttempt,
  reserveAttempt,
  transitionAttempt,
  type RankedCandidate,
} from "./domain.js";
import type { GitHubLoopPort } from "./github.js";
import { validateDispatcherCapabilities, type DispatcherCapabilityEvidence } from "./policy.js";
import type { LoopConfig, LoopSlotConfig, LoopSlotId, LoopState } from "./schema.js";
import type { DispatcherMutex, LoopStateStore } from "./store.js";

export interface SlotSafetyEvidence {
  readonly canonicalPath?: string;
  readonly reason?: string;
  readonly safe: boolean;
}

export interface SlotSafetyPort {
  inspect(slot: LoopSlotConfig, baseBranch: string): Promise<SlotSafetyEvidence>;
  refresh?(slot: LoopSlotConfig, baseBranch: string): Promise<SlotSafetyEvidence>;
}

export interface LaunchAssignment {
  readonly attemptId: string;
  readonly issueNumber: number;
  readonly issueUrl: string;
  readonly projectId: string;
  readonly slotId: LoopSlotId;
  readonly trigger: "implementation" | "rework";
  readonly workerPrompt: string;
}

export interface DispatchReport {
  readonly assignments: readonly LaunchAssignment[];
  readonly blockers: Readonly<Record<string, readonly string[]>>;
  readonly dryRun: boolean;
  readonly queueOrder: readonly number[];
  readonly slots: readonly {
    readonly id: LoopSlotId;
    readonly reason?: string;
    readonly status: "free" | "occupied" | "unsafe";
  }[];
  readonly version: 1;
}

export interface CodexThreadPort {
  findByAttempt(attemptId: string): Promise<string | undefined>;
  launch(assignment: LaunchAssignment): Promise<string>;
}

export interface DispatcherOptions {
  readonly attemptId?: () => string;
  readonly now?: () => Date;
}

function assignmentFor(
  config: LoopConfig,
  attempt: LoopState["attempts"][number],
): LaunchAssignment {
  const slot = config.slots.find((candidate) => candidate.id === attempt.slotId);
  if (slot === undefined) throw new Error("slot-config-missing");
  return {
    attemptId: attempt.attemptId,
    issueNumber: attempt.issueNumber,
    issueUrl: attempt.issueUrl,
    projectId: slot.projectId,
    slotId: attempt.slotId,
    trigger: attempt.trigger,
    workerPrompt: `$codex-loop-worker issue=${attempt.issueNumber.toString()} issueUrl=${attempt.issueUrl} attempt=${attempt.attemptId} slot=${attempt.slotId}`,
  };
}

function reworkRequestMatchesPullRequest(
  candidate: Extract<RankedCandidate, { readonly trigger: "rework" }>,
  baseBranch: string,
): boolean {
  const pullRequest = candidate.issue.linkedPullRequest;
  if (pullRequest === undefined) return false;
  return (
    pullRequest.number === candidate.reworkRequest.prNumber &&
    pullRequest.baseRef === baseBranch &&
    pullRequest.headSha === candidate.reworkRequest.baseCommit
  );
}

export class DualWorkerDispatcher {
  readonly #attemptId: () => string;
  readonly #config: LoopConfig;
  readonly #github: GitHubLoopPort;
  readonly #mutex: DispatcherMutex;
  readonly #now: () => Date;
  readonly #slots: SlotSafetyPort;
  readonly #store: LoopStateStore;

  constructor(
    config: LoopConfig,
    store: LoopStateStore,
    mutex: DispatcherMutex,
    github: GitHubLoopPort,
    slots: SlotSafetyPort,
    options: DispatcherOptions = {},
  ) {
    this.#config = config;
    this.#store = store;
    this.#mutex = mutex;
    this.#github = github;
    this.#slots = slots;
    this.#attemptId = options.attemptId ?? (() => randomUUID());
    this.#now = options.now ?? (() => new Date());
  }

  async dispatch(
    dryRun = false,
    capabilityEvidence?: DispatcherCapabilityEvidence,
  ): Promise<DispatchReport> {
    if (!dryRun) {
      validateDispatcherCapabilities(this.#config, capabilityEvidence, this.#now());
    }
    return this.#mutex.runExclusive(async () => {
      const issues = await this.#github.listQueue();
      if (!dryRun) {
        const now = this.#now();
        await this.#store.update((draft) => {
          const eventId = `retention-${now.toISOString()}`;
          if (draft.maintenanceAudit.some((event) => event.eventId === eventId)) return;
          const event = {
            at: now.toISOString(),
            eventId,
            removedAttempts: 0,
            result: "success" as const,
          };
          draft.maintenanceAudit.push(event);
          const removedAttempts = pruneAudit(draft, now, this.#config.retention);
          const retained = draft.maintenanceAudit.find(
            (candidate) => candidate.eventId === eventId,
          );
          if (retained === undefined) throw new Error("retention-audit-not-retained");
          retained.removedAttempts = removedAttempts;
        });
      }
      const state = await this.#store.read();
      const analysis = analyzeCandidates(issues, state, this.#config.trustedLogins);
      const initialSafety = await Promise.all(
        this.#config.slots.map(async (slot) => ({
          evidence: await this.#slots.inspect(slot, this.#config.repository.baseBranch),
          slot,
        })),
      );
      const safety = dryRun
        ? initialSafety
        : await Promise.all(
            initialSafety.map(async ({ evidence, slot }) => ({
              evidence:
                evidence.reason === "worktree-base-stale" && this.#slots.refresh !== undefined
                  ? await this.#slots.refresh(slot, this.#config.repository.baseBranch)
                  : evidence,
              slot,
            })),
          );
      const identityKey = (path: string) =>
        /^[a-zA-Z]:[\\/]/.test(path) ? path.replaceAll("/", "\\").toLowerCase() : path;
      const identityCounts = new Map<string, number>();
      for (const { evidence } of safety) {
        if (evidence.canonicalPath === undefined) continue;
        const key = identityKey(evidence.canonicalPath);
        identityCounts.set(key, (identityCounts.get(key) ?? 0) + 1);
      }
      const inspected = safety.map(({ evidence, slot }) => {
        if (evidence.canonicalPath === undefined) {
          return {
            evidence: {
              reason: evidence.reason ?? "worktree-identity-unknown",
              safe: false,
            },
            slot,
          };
        }
        if ((identityCounts.get(identityKey(evidence.canonicalPath)) ?? 0) > 1) {
          return {
            evidence: {
              canonicalPath: evidence.canonicalPath,
              reason: "worktree-identity-conflict",
              safe: false,
            },
            slot,
          };
        }
        return { evidence, slot };
      });
      const safeSlotIds = inspected
        .filter(({ evidence }) => evidence.safe)
        .map(({ slot }) => slot.id);
      const slotSummary = inspected.map(({ evidence, slot }) => {
        const local = state.slots.find((candidate) => candidate.id === slot.id);
        if (local === undefined) throw new Error("slot-state-missing");
        if (local.status !== "free") {
          return { id: slot.id, status: "occupied" as const };
        }
        return evidence.safe
          ? { id: slot.id, status: "free" as const }
          : {
              id: slot.id,
              reason: evidence.reason ?? "unknown-slot-state",
              status: "unsafe" as const,
            };
      });
      const safeFreeSlotIds = slotSummary
        .filter((slot) => slot.status === "free")
        .map((slot) => slot.id);

      const pending = state.attempts
        .filter(
          (attempt) =>
            attempt.threadId === undefined &&
            ["reserved", "claimed", "launch-pending"].includes(attempt.stage) &&
            Date.parse(attempt.leaseExpiresAt) > this.#now().getTime() &&
            state.slots.some(
              (slot) =>
                slot.id === attempt.slotId &&
                slot.status === "reserved" &&
                slot.attemptId === attempt.attemptId &&
                slot.leaseExpiresAt === attempt.leaseExpiresAt,
            ) &&
            safeSlotIds.includes(attempt.slotId),
        )
        .slice(0, 2);
      if (dryRun) {
        const intended = analysis.eligible.slice(0, safeFreeSlotIds.length);
        return {
          assignments: intended.map((candidate, index) => {
            const slotId = safeFreeSlotIds[index];
            if (slotId === undefined) throw new Error("dry-run-slot-missing");
            return this.#dryRunAssignment(candidate, slotId);
          }),
          blockers: Object.fromEntries(
            [...analysis.blockers].map(([number, reasons]) => [number.toString(), reasons]),
          ),
          dryRun: true,
          queueOrder: analysis.eligible.map((candidate) => candidate.issue.number),
          slots: slotSummary,
          version: 1,
        };
      }

      const assignments: LaunchAssignment[] = [];
      for (const attempt of pending) {
        const resumed =
          attempt.stage === "launch-pending" ? attempt : await this.#advanceClaim(attempt);
        if (resumed !== undefined) assignments.push(assignmentFor(this.#config, resumed));
      }
      const available = freeSlots(state)
        .filter((slot) => safeFreeSlotIds.includes(slot.id))
        .slice(0, Math.max(0, 2 - assignments.length));
      for (const [index, slot] of available.entries()) {
        const candidate = analysis.eligible[index];
        if (candidate === undefined) break;
        const assignment = await this.#claim(candidate, slot.id);
        if (assignment !== undefined) assignments.push(assignment);
      }

      return {
        assignments,
        blockers: Object.fromEntries(
          [...analysis.blockers].map(([number, reasons]) => [number.toString(), reasons]),
        ),
        dryRun: false,
        queueOrder: analysis.eligible.map((candidate) => candidate.issue.number),
        slots: slotSummary,
        version: 1,
      };
    });
  }

  async acknowledgeThread(attemptId: string, threadId: string): Promise<void> {
    const now = this.#now().toISOString();
    await this.#store.update((state) => {
      const attempt = state.attempts.find((candidate) => candidate.attemptId === attemptId);
      if (attempt === undefined) throw new Error("attempt-not-found");
      if (attempt.threadId !== undefined) {
        if (attempt.threadId !== threadId) throw new Error("thread-ack-conflict");
        return;
      }
      const slot = state.slots.find((candidate) => candidate.id === attempt.slotId);
      if (
        !["claimed", "launch-pending"].includes(attempt.stage) ||
        slot?.status !== "reserved" ||
        slot.attemptId !== attemptId
      ) {
        throw new Error("thread-ack-stage-conflict");
      }
      transitionAttempt(state, attemptId, "running", now, { threadId });
      recordAudit(state, {
        at: now,
        attemptId,
        eventId: `thread-ack-${attemptId}`,
        issueNumber: attempt.issueNumber,
        result: "success",
        slotId: attempt.slotId,
        stage: "running",
      });
    });
  }

  async failLaunch(attemptId: string, errorCode = "thread-launch-failed"): Promise<void> {
    const now = this.#now().toISOString();
    const attempt = await this.#store.update((state) => {
      const target = state.attempts.find((candidate) => candidate.attemptId === attemptId);
      if (target === undefined) throw new Error("attempt-not-found");
      if (
        target.stage === "attention" &&
        target.errorCode !== undefined &&
        target.errorCode !== errorCode
      ) {
        throw new Error("launch-error-conflict");
      }
      const slot = state.slots.find((candidate) => candidate.id === target.slotId);
      if (target.stage === "attention" && slot?.status === "free" && slot.attemptId === undefined) {
        return structuredClone(target);
      }
      if (
        target.stage !== "attention" &&
        (!["claimed", "launch-pending"].includes(target.stage) ||
          slot?.status !== "reserved" ||
          slot.attemptId !== attemptId)
      ) {
        throw new Error("thread-fail-stage-conflict");
      }
      transitionAttempt(state, attemptId, "attention", now, { errorCode });
      recordAudit(state, {
        at: now,
        attemptId,
        errorCode,
        eventId: `launch-attention-${attemptId}`,
        issueNumber: target.issueNumber,
        result: "attention",
        slotId: target.slotId,
        stage: "attention",
      });
      return structuredClone(target);
    });
    await this.#github.transitionIssue({
      attemptId,
      comment: lifecycleComment({
        attemptId,
        errorCode,
        eventId: `launch-attention-${attemptId}`,
        result: "attention",
        stage: "attention",
      }),
      eventId: `launch-attention-${attemptId}`,
      from: "codex-in-progress",
      issueNumber: attempt.issueNumber,
      to: "codex-needs-attention",
    });
    await this.#store.update((state) => {
      const target = state.attempts.find((candidate) => candidate.attemptId === attemptId);
      if (target === undefined) throw new Error("attempt-not-found");
      const slot = state.slots.find((candidate) => candidate.id === target.slotId);
      if (slot?.status === "free" && slot.attemptId === undefined) return;
      releaseAttempt(state, attemptId, "attention", now, errorCode);
    });
  }

  async #claim(
    candidate: RankedCandidate,
    slotId: LoopSlotId,
  ): Promise<LaunchAssignment | undefined> {
    const revalidated = await this.#github.getIssue(candidate.issue.number);
    const latest = analyzeCandidates(
      [revalidated],
      await this.#store.read(),
      this.#config.trustedLogins,
    ).eligible[0];
    if (latest?.trigger !== candidate.trigger) return undefined;
    if (
      latest.trigger === "rework" &&
      !reworkRequestMatchesPullRequest(latest, this.#config.repository.baseBranch)
    ) {
      // The queued authorization binds to the exact PR head.  A changed PR can
      // contain unreviewed work, so do not reserve a worker or alter its lifecycle.
      // A later explicit rework request must authorize the new head.
      return undefined;
    }

    const attemptId = this.#attemptId();
    const now = this.#now();
    const nowIso = now.toISOString();
    const leaseExpiresAt = new Date(
      now.getTime() + this.#config.dispatcher.leaseSeconds * 1_000,
    ).toISOString();
    const attempt = await this.#store.update((state) =>
      structuredClone(
        reserveAttempt(state, {
          attemptId,
          candidate: latest,
          leaseExpiresAt,
          now: nowIso,
          slotId,
        }),
      ),
    );
    const advanced = await this.#advanceClaim(attempt);
    return advanced === undefined ? undefined : assignmentFor(this.#config, advanced);
  }

  async #advanceClaim(attempt: LoopState["attempts"][number]) {
    const eventId = `claim-${attempt.attemptId}`;
    const now = this.#now().toISOString();
    try {
      await this.#github.transitionIssue({
        attemptId: attempt.attemptId,
        comment: lifecycleComment({
          attemptId: attempt.attemptId,
          eventId,
          result: "claimed",
          stage: "claimed",
        }),
        eventId,
        from: attempt.trigger === "rework" ? "codex-rework" : "codex-ready",
        issueNumber: attempt.issueNumber,
        to: "codex-in-progress",
      });
    } catch {
      await this.#store.update((state) => {
        const current = transitionAttempt(state, attempt.attemptId, "attention", now, {
          errorCode: "claim-github-ambiguous",
        });
        recordAudit(state, {
          at: now,
          attemptId: current.attemptId,
          errorCode: "claim-github-ambiguous",
          eventId: `claim-failed-${current.attemptId}`,
          issueNumber: current.issueNumber,
          result: "attention",
          slotId: current.slotId,
          stage: "attention",
        });
        // A lifecycle mutation may have applied before its acknowledgement failed.  Keep the
        // reservation as attention: reusing this slot could create a second executor for an
        // issue GitHub already considers in progress.
      });
      return undefined;
    }
    return this.#store.update((state) => {
      const target = transitionAttempt(state, attempt.attemptId, "launch-pending", now);
      if (!hasDelivered(state, eventId, attempt.attemptId)) {
        recordAudit(state, {
          at: now,
          attemptId: attempt.attemptId,
          eventId,
          issueNumber: target.issueNumber,
          result: "success",
          slotId: target.slotId,
          stage: "claimed",
        });
      }
      return structuredClone(target);
    });
  }

  #dryRunAssignment(candidate: RankedCandidate, slotId: LoopSlotId): LaunchAssignment {
    const slot = this.#config.slots.find((item) => item.id === slotId);
    if (slot === undefined) throw new Error("slot-config-missing");
    return {
      attemptId: "dry-run",
      issueNumber: candidate.issue.number,
      issueUrl: candidate.issue.url,
      projectId: slot.projectId,
      slotId,
      trigger: candidate.trigger,
      workerPrompt: `$codex-loop-worker issue=${candidate.issue.number.toString()} issueUrl=${candidate.issue.url} attempt=dry-run slot=${slotId}`,
    };
  }
}

export async function launchAssignments(
  dispatcher: DualWorkerDispatcher,
  report: DispatchReport,
  threads: CodexThreadPort,
): Promise<void> {
  for (const assignment of report.assignments) {
    const existing = await threads.findByAttempt(assignment.attemptId);
    const threadId = existing ?? (await threads.launch(assignment));
    await dispatcher.acknowledgeThread(assignment.attemptId, threadId);
  }
}
