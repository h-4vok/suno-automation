import { describe, expect, it } from "vitest";

import {
  assertDraftPullRequestForAttempt,
  assertPublicationGate,
  decideLeaseRecovery,
  occupiedSlotIds,
  reconciliationRecommendation,
  reworkPolicyError,
  taskEvidenceFor,
  validateDispatcherCapabilities,
} from "../src/loop/policy.js";
import type { AttemptRecord, AttemptStage } from "../src/loop/schema.js";
import { loopCapabilities, loopConfig, loopNow, requiredValue } from "./support/loop-fixtures.js";

function attempt(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    attemptId: "attempt-42",
    createdAt: "2026-07-23T10:00:00.000Z",
    issueNumber: 42,
    issueUrl: "https://github.com/owner/suno-automation/issues/42",
    leaseExpiresAt: "2026-07-23T11:00:00.000Z",
    repairPasses: 0,
    selectionReason: "priority-p0",
    slotId: "worker-1",
    stage: "running",
    threadId: "thread-42",
    trigger: "implementation",
    updatedAt: "2026-07-23T10:00:00.000Z",
    ...overrides,
  };
}

function recoveryEvidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    actor: "OWNER",
    attemptId: "attempt-42",
    branchOperation: "absent",
    consistent: true,
    linkedPullRequest: "absent",
    observedAt: loopNow,
    process: "absent",
    task: "absent",
    version: 1,
    worktreeOperation: "absent",
    ...overrides,
  };
}

describe("Codex loop typed policy evidence", () => {
  it("accepts only fresh exact Desktop project capabilities", () => {
    const config = loopConfig();
    expect(validateDispatcherCapabilities(config, loopCapabilities(), new Date(loopNow))).toEqual(
      loopCapabilities(),
    );
    for (const observedAt of ["2026-07-23T11:54:59.999Z", "2026-07-23T12:05:00.001Z"]) {
      expect(() =>
        validateDispatcherCapabilities(
          config,
          { ...loopCapabilities(), observedAt },
          new Date(loopNow),
        ),
      ).toThrow("dispatcher-capability-evidence-stale");
    }
    const conflicting = structuredClone(loopCapabilities());
    conflicting.projects[0].projectId = "wrong-project";
    expect(() => validateDispatcherCapabilities(config, conflicting, new Date(loopNow))).toThrow(
      "dispatcher-project-capability-conflict",
    );
  });

  it("requires recovery evidence to be fresh and observed after an expired lease", () => {
    const expired = attempt();
    expect(decideLeaseRecovery(expired, recoveryEvidence(), ["owner"], new Date(loopNow))).toBe(
      "safe-expired",
    );
    expect(() =>
      decideLeaseRecovery(
        expired,
        recoveryEvidence({ observedAt: "2026-07-23T10:59:59.999Z" }),
        ["owner"],
        new Date("2026-07-23T11:01:00.000Z"),
      ),
    ).toThrow("recovery-evidence-precedes-attempt-expiry");
    expect(() =>
      decideLeaseRecovery(
        expired,
        recoveryEvidence({ observedAt: "2026-07-23T11:50:00.000Z" }),
        ["owner"],
        new Date(loopNow),
      ),
    ).toThrow("recovery-evidence-stale");
  });

  it("preserves active leases and any positive evidence while failing ambiguity closed", () => {
    const active = attempt({ leaseExpiresAt: "2026-07-23T13:00:00.000Z" });
    expect(decideLeaseRecovery(active, recoveryEvidence(), ["owner"], new Date(loopNow))).toBe(
      "lease-active",
    );
    expect(
      decideLeaseRecovery(
        attempt(),
        recoveryEvidence({ process: "active" }),
        ["owner"],
        new Date(loopNow),
      ),
    ).toBe("active-evidence");
    expect(
      decideLeaseRecovery(
        attempt(),
        recoveryEvidence({ task: "unknown" }),
        ["owner"],
        new Date(loopNow),
      ),
    ).toBe("ambiguous-evidence");
  });

  it("keeps every pre-terminal stage capacity-occupied", () => {
    const occupied: readonly AttemptStage[] = [
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
    ];
    for (const stage of occupied) {
      expect(occupiedSlotIds([attempt({ stage })])).toEqual(["worker-1"]);
    }
    for (const stage of ["review", "attention", "completed"] as const) {
      expect(occupiedSlotIds([attempt({ stage })])).toEqual([]);
    }
  });

  it("treats stale, duplicate, or thread-mismatched task evidence as unknown", () => {
    const current = new Date(loopNow);
    const valid = {
      attemptId: "attempt-42",
      observedAt: loopNow,
      source: "codex-desktop" as const,
      state: "active" as const,
      threadId: "thread-42",
      version: 1 as const,
    };
    expect(taskEvidenceFor(attempt(), [valid], current).state).toBe("active");
    expect(taskEvidenceFor(attempt(), [{ ...valid, threadId: "other" }], current).state).toBe(
      "unknown",
    );
    expect(
      taskEvidenceFor(attempt(), [{ ...valid, observedAt: "2026-07-23T11:54:59.999Z" }], current)
        .state,
    ).toBe("unknown");
    expect(taskEvidenceFor(attempt(), [valid, valid], current).state).toBe("unknown");
  });

  it("binds publication to one verified attempt branch and open draft PR", () => {
    const publishable = attempt({
      branchName: "codex/42-safe",
      commitSha: "abcdef1234567",
      pullRequest: {
        draft: true,
        number: 88,
        url: "https://github.com/owner/suno-automation/pull/88",
      },
      stage: "pr-linked",
      verification: {
        attemptId: "attempt-42",
        commands: [],
        commitSha: "abcdef1234567",
        createdAt: loopNow,
        findings: [],
        signature: "0".repeat(64),
        slotId: "worker-1",
        status: "pass",
        version: 1,
      },
    });
    expect(() => assertPublicationGate(publishable, true)).not.toThrow();
    expect(() => assertPublicationGate({ ...publishable, stage: "verified" }, true)).toThrow(
      "publication-gate-not-satisfied",
    );
    expect(() => assertPublicationGate(publishable, false)).toThrow(
      "publication-gate-not-satisfied",
    );
    expect(() =>
      assertDraftPullRequestForAttempt(
        publishable,
        {
          baseRef: "main",
          draft: true,
          headRef: "codex/42-safe",
          headRepositoryOwner: "owner",
          headSha: "abcdef1234567",
          isCrossRepository: false,
          number: 88,
          state: "open",
        },
        "main",
        "owner",
      ),
    ).not.toThrow();
    for (const pullRequest of [
      {
        baseRef: "main",
        draft: false,
        headRef: "codex/42-safe",
        headRepositoryOwner: "owner",
        headSha: "abcdef1234567",
        isCrossRepository: false,
        number: 88,
        state: "open" as const,
      },
      {
        baseRef: "main",
        draft: true,
        headRef: "codex/other",
        headRepositoryOwner: "owner",
        headSha: "abcdef1234567",
        isCrossRepository: false,
        number: 88,
        state: "open" as const,
      },
      {
        baseRef: "main",
        draft: true,
        headRef: "codex/42-safe",
        headRepositoryOwner: "owner",
        headSha: "abcdef1234567",
        isCrossRepository: false,
        number: 89,
        state: "open" as const,
      },
      {
        baseRef: "main",
        draft: true,
        headRef: "codex/42-safe",
        headRepositoryOwner: "owner",
        // A force-push after verification must never be published as the verified commit.
        headSha: "fedcba7654321",
        isCrossRepository: false,
        number: 88,
        state: "open" as const,
      },
    ]) {
      expect(() =>
        assertDraftPullRequestForAttempt(publishable, pullRequest, "main", "owner"),
      ).toThrow();
    }
  });

  it("decides trusted rework from current PR, base, age, resolution, and attempt budget", () => {
    const valid = {
      approvedFeedbackIds: ["feedback-1"],
      baseCommit: "abcdef1234567",
      feedback: [
        {
          createdAt: "2026-07-23T11:30:00.000Z",
          id: "feedback-1",
          resolved: false,
        },
      ],
      headCommitAt: "2026-07-23T11:00:00.000Z",
      headSha: "abcdef1234567",
      issue: {
        draft: true,
        lifecycle: "codex-review",
        linkedPullRequestNumber: 88,
        linkedPullRequestState: "open" as const,
        state: "open" as const,
      },
      priorReworks: 0,
      prNumber: 88,
      requestActor: "OWNER",
      trustedLogins: ["owner"],
    };
    expect(reworkPolicyError(valid)).toBeUndefined();
    expect(reworkPolicyError({ ...valid, requestActor: "intruder" })).toBe(
      "untrusted-rework-actor",
    );
    expect(
      reworkPolicyError({
        ...valid,
        issue: { ...valid.issue, lifecycle: "codex-in-progress" },
      }),
    ).toBe("rework-state-conflict");
    expect(reworkPolicyError({ ...valid, priorReworks: 3 })).toBe("rework-attempt-limit");
    expect(
      reworkPolicyError({
        ...valid,
        feedback: [{ ...requiredValue(valid.feedback[0]), resolved: true }],
      }),
    ).toBe("rework-feedback-conflict");
    expect(
      reworkPolicyError({
        ...valid,
        feedback: [
          {
            ...requiredValue(valid.feedback[0]),
            createdAt: valid.headCommitAt,
          },
        ],
      }),
    ).toBe("rework-feedback-conflict");
  });

  it.each([
    {
      expected: "complete-merged",
      input: {
        issueState: "closed",
        localBranch: "parked",
        pullRequest: { draft: false, state: "merged" },
        taskState: "absent",
      },
    },
    {
      expected: "move-to-attention",
      input: {
        issueState: "closed",
        localBranch: "parked",
        localUnsafe: true,
        pullRequest: { draft: false, state: "merged" },
        taskState: "absent",
      },
    },
    {
      expected: "move-to-attention",
      input: {
        issueState: "closed",
        localBranch: "attempt",
        pullRequest: { draft: false, state: "merged" },
        taskState: "absent",
      },
    },
    {
      expected: "release-review-slot",
      input: {
        lifecycle: "codex-review",
        localBranch: "parked",
        pullRequest: { draft: true, state: "open" },
        taskState: "absent",
      },
    },
    {
      expected: "finalize-review",
      input: {
        lifecycle: "codex-review",
        localBranch: "attempt",
        pullRequest: { draft: true, state: "open" },
        taskState: "absent",
      },
    },
    {
      expected: "leave-running",
      input: { localBranch: "attempt", taskState: "active" },
    },
    {
      expected: "resume-thread",
      input: {
        attemptStage: "launch-pending",
        localBranch: "attempt",
        taskState: "absent",
        threadRecorded: false,
      },
    },
    {
      expected: "move-to-attention",
      input: {
        attemptStage: "running",
        localBranch: "attempt",
        taskState: "absent",
        threadRecorded: true,
      },
    },
    {
      expected: "move-to-attention",
      input: { localBranch: "attempt", taskState: "unknown" },
    },
  ] as const)("routes reconciliation to $expected", ({ expected, input }) => {
    expect(
      reconciliationRecommendation({
        attemptStage: "running",
        issueState: "open",
        lifecycle: "codex-in-progress",
        localUnsafe: false,
        pullRequest: undefined,
        stale: false,
        threadRecorded: false,
        ...input,
      }),
    ).toBe(expected);
  });
});
