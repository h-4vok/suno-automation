import { describe, expect, it } from "vitest";

import { analyzeCandidates, reserveAttempt } from "../src/loop/domain.js";
import type { GitHubLoopPort, IssueTransition, PullRequestSnapshot } from "../src/loop/github.js";
import type { IssueCandidate } from "../src/loop/schema.js";
import { LoopLeaseRecoveryService } from "../src/loop/recovery.js";
import { InMemoryLoopStateStore } from "../src/loop/store.js";
import {
  issueCandidate,
  loopConfig,
  loopNow,
  loopState,
  requiredValue,
} from "./support/loop-fixtures.js";

class RecoveryGitHub implements GitHubLoopPort {
  authenticatedActor = "owner";
  readonly transitions: IssueTransition[] = [];

  authenticatedLogin(): Promise<string> {
    return Promise.resolve(this.authenticatedActor);
  }

  ensureDraftPullRequest(): Promise<PullRequestSnapshot> {
    return Promise.reject(new Error("not-used"));
  }

  getIssue(): Promise<IssueCandidate> {
    return Promise.reject(new Error("not-used"));
  }

  getPullRequest(): Promise<PullRequestSnapshot> {
    return Promise.reject(new Error("not-used"));
  }

  listQueue(): Promise<readonly IssueCandidate[]> {
    return Promise.resolve([]);
  }

  transitionIssue(transition: IssueTransition): Promise<"applied" | "duplicate"> {
    if (this.transitions.some((candidate) => candidate.eventId === transition.eventId)) {
      return Promise.resolve("duplicate");
    }
    this.transitions.push(transition);
    return Promise.resolve("applied");
  }
}

function recoveryStore(leaseExpiresAt = "2026-07-23T11:00:00.000Z") {
  const state = loopState();
  const candidate = requiredValue(
    analyzeCandidates([issueCandidate(42)], state, ["owner"]).eligible[0],
  );
  const attempt = reserveAttempt(state, {
    attemptId: "attempt-42",
    candidate,
    leaseExpiresAt,
    now: "2026-07-23T10:00:00.000Z",
    slotId: "worker-1",
  });
  attempt.stage = "running";
  attempt.threadId = "thread-42";
  state.slots[0].status = "running";
  return new InMemoryLoopStateStore(state);
}

function evidence(overrides: Record<string, unknown> = {}) {
  return {
    actor: "OWNER",
    attemptId: "attempt-42",
    branchOperation: "absent" as const,
    consistent: true,
    linkedPullRequest: "absent" as const,
    observedAt: loopNow,
    process: "absent" as const,
    task: "absent" as const,
    version: 1 as const,
    worktreeOperation: "absent" as const,
    ...overrides,
  };
}

describe("expired lease recovery", () => {
  it("requires claimed actor to equal the authenticated GitHub login", async () => {
    const store = recoveryStore();
    const github = new RecoveryGitHub();
    github.authenticatedActor = "other-owner";
    const service = new LoopLeaseRecoveryService(
      loopConfig(),
      store,
      github,
      () => new Date(loopNow),
    );

    await expect(service.recover("attempt-42", evidence())).rejects.toThrow(
      "recovery-actor-authentication-conflict",
    );
    expect((await store.read()).slots[0].status).toBe("running");
    expect(github.transitions).toHaveLength(0);
  });

  it("rejects an authenticated but untrusted actor", async () => {
    const store = recoveryStore();
    const github = new RecoveryGitHub();
    github.authenticatedActor = "intruder";
    const service = new LoopLeaseRecoveryService(
      loopConfig(),
      store,
      github,
      () => new Date(loopNow),
    );

    await expect(service.recover("attempt-42", evidence({ actor: "INTRUDER" }))).rejects.toThrow(
      "untrusted-recovery-actor",
    );
    expect((await store.read()).slots[0].status).toBe("running");
  });

  it("accepts an allowlisted actor case-insensitively and performs one durable recovery", async () => {
    const store = recoveryStore();
    const github = new RecoveryGitHub();
    const service = new LoopLeaseRecoveryService(
      loopConfig(),
      store,
      github,
      () => new Date(loopNow),
    );

    const first = await service.recover("attempt-42", evidence());
    const duplicate = await service.recover("attempt-42", evidence());

    expect(first.decision).toBe("safe-expired");
    expect(duplicate.attempt.stage).toBe("attention");
    expect((await store.read()).slots[0]).toEqual({ id: "worker-1", status: "free" });
    expect(github.transitions).toHaveLength(1);
  });

  it("treats an exact inactive Codex task as fresh negative recovery evidence", async () => {
    const store = recoveryStore();
    const github = new RecoveryGitHub();
    const service = new LoopLeaseRecoveryService(
      loopConfig(),
      store,
      github,
      () => new Date(loopNow),
    );

    await expect(
      service.recover("attempt-42", evidence({ task: "inactive" })),
    ).resolves.toMatchObject({
      decision: "safe-expired",
    });
  });

  it("preserves live work and non-expired leases without GitHub mutation", async () => {
    const github = new RecoveryGitHub();
    const activeEvidenceStore = recoveryStore();
    const activeEvidenceService = new LoopLeaseRecoveryService(
      loopConfig(),
      activeEvidenceStore,
      github,
      () => new Date(loopNow),
    );
    await expect(
      activeEvidenceService.recover("attempt-42", evidence({ worktreeOperation: "active" })),
    ).rejects.toThrow("recovery-active-evidence");

    const activeLeaseStore = recoveryStore("2026-07-23T13:00:00.000Z");
    const activeLeaseService = new LoopLeaseRecoveryService(
      loopConfig(),
      activeLeaseStore,
      github,
      () => new Date(loopNow),
    );
    await expect(activeLeaseService.recover("attempt-42", evidence())).rejects.toThrow(
      "lease-still-active",
    );
    expect(github.transitions).toHaveLength(0);
  });

  it("moves missing or contradictory evidence to explicit attention", async () => {
    const store = recoveryStore();
    const github = new RecoveryGitHub();
    const service = new LoopLeaseRecoveryService(
      loopConfig(),
      store,
      github,
      () => new Date(loopNow),
    );

    const result = await service.recover(
      "attempt-42",
      evidence({ consistent: false, process: "unknown" }),
    );

    expect(result.decision).toBe("ambiguous-evidence");
    expect(result.attempt).toMatchObject({
      errorCode: "lease-recovery-evidence-ambiguous",
      stage: "attention",
    });
    expect(github.transitions[0]?.to).toBe("codex-needs-attention");
  });
});
