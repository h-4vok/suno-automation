import { lifecycleComment, recordAudit, releaseAttempt, transitionAttempt } from "./domain.js";
import type { GitHubLoopPort } from "./github.js";
import {
  decideLeaseRecovery,
  type LeaseRecoveryDecision,
  type LeaseRecoveryEvidence,
} from "./policy.js";
import type { AttemptRecord, LoopConfig } from "./schema.js";
import type { LoopStateStore } from "./store.js";

export class LoopLeaseRecoveryService {
  readonly #config: LoopConfig;
  readonly #github: GitHubLoopPort;
  readonly #now: () => Date;
  readonly #store: LoopStateStore;

  constructor(
    config: LoopConfig,
    store: LoopStateStore,
    github: GitHubLoopPort,
    now: () => Date = () => new Date(),
  ) {
    this.#config = config;
    this.#store = store;
    this.#github = github;
    this.#now = now;
  }

  async recover(
    attemptId: string,
    evidence: LeaseRecoveryEvidence,
  ): Promise<{ readonly attempt: AttemptRecord; readonly decision: LeaseRecoveryDecision }> {
    const state = await this.#store.read();
    const attempt = state.attempts.find((candidate) => candidate.attemptId === attemptId);
    if (attempt === undefined) throw new Error("attempt-not-found");
    if (this.#github.authenticatedLogin === undefined) {
      throw new Error("authenticated-login-port-unavailable");
    }
    const authenticatedLogin = await this.#github.authenticatedLogin();
    if (authenticatedLogin.toLowerCase() !== evidence.actor.toLowerCase()) {
      throw new Error("recovery-actor-authentication-conflict");
    }
    const decision = decideLeaseRecovery(
      attempt,
      evidence,
      this.#config.trustedLogins,
      this.#now(),
    );
    if (decision === "lease-active") throw new Error("lease-still-active");
    if (decision === "active-evidence") throw new Error("recovery-active-evidence");

    const errorCode =
      decision === "safe-expired"
        ? "lease-expired-safely-recovered"
        : "lease-recovery-evidence-ambiguous";
    const now = this.#now().toISOString();
    const eventId = `recovery-${attemptId}`;
    const persisted = await this.#store.update((draft) => {
      const target = draft.attempts.find((candidate) => candidate.attemptId === attemptId);
      if (target === undefined) throw new Error("attempt-not-found");
      const slot = draft.slots.find((candidate) => candidate.id === target.slotId);
      if (target.stage === "attention" && slot?.status === "free") {
        return structuredClone(target);
      }
      transitionAttempt(draft, attemptId, "attention", now, { errorCode });
      recordAudit(draft, {
        at: now,
        attemptId,
        errorCode,
        eventId,
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
        eventId,
        result: "attention",
        stage: "attention",
      }),
      eventId,
      from: "codex-in-progress",
      issueNumber: persisted.issueNumber,
      to: "codex-needs-attention",
    });
    const released = await this.#store.update((draft) => {
      const target = draft.attempts.find((candidate) => candidate.attemptId === attemptId);
      if (target === undefined) throw new Error("attempt-not-found");
      const slot = draft.slots.find((candidate) => candidate.id === target.slotId);
      return structuredClone(
        slot?.status === "free"
          ? target
          : releaseAttempt(draft, attemptId, "attention", now, errorCode),
      );
    });
    return { attempt: released, decision };
  }
}
