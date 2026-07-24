import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  analyzeCandidates as analyzeCandidatesWithTrust,
  createBranchName,
  freeSlots,
  hasDelivered,
  lifecycleComment,
  pruneAudit,
  recordAudit,
  releaseAttempt,
  reserveAttempt,
  transitionAttempt,
} from "../src/loop/domain.js";
import { deliveryKey, LoopStateSchema } from "../src/loop/schema.js";
import { issueCandidate, loopNow, loopState, requiredValue } from "./support/loop-fixtures.js";

const analyzeCandidates = (
  issues: Parameters<typeof analyzeCandidatesWithTrust>[0],
  state: Parameters<typeof analyzeCandidatesWithTrust>[1],
) => analyzeCandidatesWithTrust(issues, state, ["OWNER"]);

describe("dual-worker loop domain", () => {
  it("orders trusted rework before priority and uses deterministic ties", () => {
    const state = loopState();
    state.reworkRequests.push({
      approvedFeedbackIds: ["feedback-1"],
      baseCommit: "abcdef1234567",
      eventId: "rework-event",
      issueNumber: 9,
      prNumber: 12,
      requestedAt: "2026-07-23T11:00:00.000Z",
      requestedBy: "owner",
      status: "queued",
    });
    const analysis = analyzeCandidates(
      [
        issueCandidate(8, { labels: ["codex-ready", "priority:p0"] }),
        issueCandidate(7, {
          createdAt: "2026-07-20T10:00:00.000Z",
          labels: ["codex-ready", "priority:p0"],
        }),
        issueCandidate(9, {
          labels: ["codex-rework", "priority:p2"],
          linkedPullRequest: {
            baseRef: "main",
            draft: true,
            headRef: "codex/9-safe",
            headSha: "abcdef1234567",
            headRepositoryOwner: "owner",
            isCrossRepository: false,
            number: 12,
            state: "open",
            url: "https://github.com/owner/suno-automation/pull/12",
          },
        }),
      ],
      state,
    );

    expect(analysis.eligible.map((candidate) => candidate.issue.number)).toEqual([9, 7, 8]);
    expect(analysis.eligible.map((candidate) => candidate.trigger)).toEqual([
      "rework",
      "implementation",
      "implementation",
    ]);
  });

  it("orders multiple reworks and implementation ties deterministically", () => {
    const state = loopState();
    for (const [issueNumber, requestedAt] of [
      [30, "2026-07-23T11:00:00.000Z"],
      [20, "2026-07-23T11:00:00.000Z"],
      [10, "2026-07-23T10:00:00.000Z"],
    ] as const) {
      state.reworkRequests.push({
        approvedFeedbackIds: [`feedback-${issueNumber.toString()}`],
        baseCommit: "abcdef1234567",
        eventId: `rework-${issueNumber.toString()}`,
        issueNumber,
        prNumber: issueNumber,
        requestedAt,
        requestedBy: "owner",
        status: "queued",
      });
    }
    const rework = (number: number) =>
      issueCandidate(number, {
        labels: ["codex-rework", "priority:p2"],
        linkedPullRequest: {
          baseRef: "main",
          draft: true,
          headRef: `codex/${number.toString()}-safe`,
          headSha: "abcdef1234567",
          headRepositoryOwner: "owner",
          isCrossRepository: false,
          number,
          state: "open",
          url: `https://github.com/owner/suno-automation/pull/${number.toString()}`,
        },
      });
    const analysis = analyzeCandidates(
      [
        issueCandidate(43, {
          createdAt: "2026-07-20T10:00:00.000Z",
          labels: ["codex-ready", "priority:p1"],
        }),
        issueCandidate(42, {
          createdAt: "2026-07-20T10:00:00.000Z",
          labels: ["codex-ready", "priority:p1"],
        }),
        issueCandidate(44, { labels: ["codex-ready", "priority:p0"] }),
        issueCandidate(45, { labels: ["codex-ready", "priority:p2"] }),
        rework(30),
        rework(20),
        rework(10),
      ],
      state,
    );

    expect(analysis.eligible.map((candidate) => candidate.issue.number)).toEqual([
      10, 20, 30, 44, 42, 43, 45,
    ]);
  });

  it("ignores unrelated rework requests for a ready issue", () => {
    const state = loopState();
    state.reworkRequests.push(
      {
        approvedFeedbackIds: ["feedback-other"],
        baseCommit: "abcdef1234567",
        eventId: "rework-other",
        issueNumber: 99,
        prNumber: 99,
        requestedAt: "2026-07-23T09:00:00.000Z",
        requestedBy: "owner",
        status: "queued",
      },
      {
        approvedFeedbackIds: ["feedback-stale"],
        baseCommit: "abcdef1234567",
        eventId: "rework-stale",
        issueNumber: 1,
        prNumber: 1,
        requestedAt: "2026-07-23T10:00:00.000Z",
        requestedBy: "owner",
        status: "queued",
      },
    );

    const candidate = requiredValue(analyzeCandidates([issueCandidate(1)], state).eligible[0]);
    expect(candidate).toMatchObject({
      issue: { number: 1 },
      reason: "priority-p1",
      trigger: "implementation",
    });
    expect(candidate.reworkRequest).toBeUndefined();
  });

  it("blocks manual work, unresolved dependencies, invalid lifecycle, and conflicting PRs", () => {
    const analysis = analyzeCandidates(
      [
        issueCandidate(1, { labels: ["codex-ready", "priority:p0", "manual-validation"] }),
        issueCandidate(2, {
          dependencies: [{ number: 1, state: "unknown" }],
        }),
        issueCandidate(3, {
          labels: ["backlog", "codex-ready", "priority:p0"],
        }),
        issueCandidate(4, {
          linkedPullRequest: {
            baseRef: "main",
            draft: true,
            headRef: "codex/4-old",
            headSha: "abcdef1234567",
            headRepositoryOwner: "owner",
            isCrossRepository: false,
            number: 4,
            state: "open",
            url: "https://github.com/owner/suno-automation/pull/4",
          },
        }),
      ],
      loopState(),
    );

    expect(analysis.eligible).toHaveLength(0);
    expect(analysis.blockers.get(1)).toContain("manual-validation");
    expect(analysis.blockers.get(2)).toContain("unresolved-dependency");
    expect(analysis.blockers.get(3)).toContain("invalid-lifecycle");
    expect(analysis.blockers.get(4)).toContain("conflicting-pull-request");
  });

  it("explains every closed, epic, priority, lifecycle, active, and rework blocker", () => {
    const state = loopState();
    const active = requiredValue(analyzeCandidates([issueCandidate(8)], state).eligible[0]);
    reserveAttempt(state, {
      attemptId: "attempt-8",
      candidate: active,
      leaseExpiresAt: "2026-07-23T14:00:00.000Z",
      now: loopNow,
      slotId: "worker-1",
    });
    const analysis = analyzeCandidates(
      [
        issueCandidate(1, { state: "closed" }),
        issueCandidate(2, { labels: ["codex-ready", "priority:p0", "type:epic"] }),
        issueCandidate(3, { labels: ["codex-ready"] }),
        issueCandidate(4, { labels: ["backlog", "priority:p0"] }),
        issueCandidate(5, { labels: ["codex-rework", "priority:p0"] }),
        issueCandidate(6, {
          labels: ["codex-rework", "priority:p0"],
          linkedPullRequest: {
            baseRef: "main",
            draft: false,
            headRef: "codex/6-safe",
            headSha: "abcdef1234567",
            headRepositoryOwner: "owner",
            isCrossRepository: false,
            number: 6,
            state: "open",
            url: "https://github.com/owner/suno-automation/pull/6",
          },
        }),
        issueCandidate(8),
      ],
      state,
    );

    expect(analysis.blockers.get(1)).toContain("issue-closed");
    expect(analysis.blockers.get(2)).toContain("epic");
    expect(analysis.blockers.get(3)).toContain("invalid-priority");
    expect(analysis.blockers.get(4)).toContain("not-queued");
    expect(analysis.blockers.get(5)).toEqual(
      expect.arrayContaining(["missing-trusted-rework-request", "invalid-rework-pull-request"]),
    );
    expect(analysis.blockers.get(6)).toEqual(
      expect.arrayContaining(["missing-trusted-rework-request", "invalid-rework-pull-request"]),
    );
    expect(analysis.blockers.get(8)).toContain("active-claim");
  });

  it("accepts a queue item only when every dependency is closed", () => {
    const analysis = analyzeCandidates(
      [
        issueCandidate(1, {
          dependencies: [
            { number: 90, state: "closed" },
            { number: 91, state: "closed" },
          ],
        }),
      ],
      loopState(),
    );

    expect(analysis.blockers.has(1)).toBe(false);
    expect(analysis.eligible[0]?.issue.number).toBe(1);
  });

  it("reserves exactly two distinct issues and keeps a third out", () => {
    const state = loopState();
    const candidates = analyzeCandidates(
      [issueCandidate(1), issueCandidate(2), issueCandidate(3)],
      state,
    ).eligible;
    reserveAttempt(state, {
      attemptId: "attempt-1",
      candidate: requiredValue(candidates[0]),
      leaseExpiresAt: "2026-07-23T14:00:00.000Z",
      now: loopNow,
      slotId: "worker-1",
    });
    reserveAttempt(state, {
      attemptId: "attempt-2",
      candidate: requiredValue(candidates[1]),
      leaseExpiresAt: "2026-07-23T14:00:00.000Z",
      now: loopNow,
      slotId: "worker-2",
    });

    expect(freeSlots(state)).toHaveLength(0);
    expect(state.attempts.map((attempt) => attempt.issueNumber)).toEqual([1, 2]);
    expect(() =>
      reserveAttempt(state, {
        attemptId: "attempt-3",
        candidate: requiredValue(candidates[2]),
        leaseExpiresAt: "2026-07-23T14:00:00.000Z",
        now: loopNow,
        slotId: "worker-1",
      }),
    ).toThrow("slot-not-free");
    expect(LoopStateSchema.parse(state)).toEqual(state);
  });

  it("rejects assigning the same issue to both slots", () => {
    const state = loopState();
    const candidate = requiredValue(analyzeCandidates([issueCandidate(1)], state).eligible[0]);
    reserveAttempt(state, {
      attemptId: "attempt-1",
      candidate,
      leaseExpiresAt: "2026-07-23T14:00:00.000Z",
      now: loopNow,
      slotId: "worker-1",
    });

    expect(() =>
      reserveAttempt(state, {
        attemptId: "attempt-2",
        candidate,
        leaseExpiresAt: "2026-07-23T14:00:00.000Z",
        now: loopNow,
        slotId: "worker-2",
      }),
    ).toThrow("issue-already-active");
  });

  it("preserves capacity and ownership invariants across generated reserve/release/retry sequences", () => {
    const command = fc.record({
      issueNumber: fc.integer({ min: 1, max: 5 }),
      kind: fc.constantFrom("reserve", "retry", "release"),
      slotId: fc.constantFrom("worker-1", "worker-2"),
      // A synthetic reserve has no verified commit, so only attention is a
      // valid terminal transition in this state-machine property.
      terminalStage: fc.constant("attention"),
    });

    fc.assert(
      fc.property(fc.array(command, { maxLength: 30 }), (commands) => {
        const state = loopState();
        let nextAttempt = 0;
        for (const item of commands) {
          if (item.kind === "release") {
            const slot = state.slots.find((candidate) => candidate.id === item.slotId);
            if (slot?.attemptId !== undefined) {
              releaseAttempt(
                state,
                slot.attemptId,
                item.terminalStage,
                new Date(Date.parse(loopNow) + nextAttempt * 1_000).toISOString(),
              );
            }
          } else {
            const candidate = requiredValue(
              analyzeCandidates([issueCandidate(item.issueNumber)], loopState()).eligible[0],
            );
            try {
              reserveAttempt(state, {
                attemptId: `${item.kind}-${(++nextAttempt).toString()}`,
                candidate,
                leaseExpiresAt: "2026-07-24T12:00:00.000Z",
                now: new Date(Date.parse(loopNow) + nextAttempt * 1_000).toISOString(),
                slotId: item.slotId,
              });
            } catch (error: unknown) {
              expect(["issue-already-active", "slot-not-free"]).toContain(
                error instanceof Error ? error.message : "",
              );
            }
          }

          const occupied = state.slots.filter((slot) => slot.attemptId !== undefined);
          const activeAttempts = occupied.map((slot) => requiredValue(slot.attemptId));
          const activeIssues = activeAttempts.map(
            (attemptId) =>
              requiredValue(state.attempts.find((attempt) => attempt.attemptId === attemptId))
                .issueNumber,
          );
          expect(occupied.length).toBeLessThanOrEqual(2);
          expect(new Set(activeAttempts).size).toBe(activeAttempts.length);
          expect(new Set(activeIssues).size).toBe(activeIssues.length);
          expect(LoopStateSchema.safeParse(state).success).toBe(true);

          const orphaned = structuredClone(state);
          orphaned.slots[0] = {
            attemptId: "missing-schema-attempt",
            id: "worker-1",
            leaseExpiresAt: "2026-07-24T12:00:00.000Z",
            status: "reserved",
          };
          expect(LoopStateSchema.safeParse(orphaned).success).toBe(false);

          const firstAttempt = state.attempts[0];
          if (firstAttempt !== undefined) {
            const duplicate = structuredClone(state);
            duplicate.attempts.push(structuredClone(firstAttempt));
            expect(LoopStateSchema.safeParse(duplicate).success).toBe(false);
          }
        }
      }),
      { numRuns: 50, seed: 42_005 },
    );
  });

  it("finds an active duplicate after unrelated terminal history", () => {
    const state = loopState();
    const unrelated = requiredValue(analyzeCandidates([issueCandidate(99)], state).eligible[0]);
    reserveAttempt(state, {
      attemptId: "attempt-99",
      candidate: unrelated,
      leaseExpiresAt: "2026-07-23T13:00:00.000Z",
      now: "2026-07-23T09:00:00.000Z",
      slotId: "worker-1",
    });
    releaseAttempt(state, "attempt-99", "attention", "2026-07-23T10:00:00.000Z");
    const active = requiredValue(analyzeCandidates([issueCandidate(1)], state).eligible[0]);
    reserveAttempt(state, {
      attemptId: "attempt-1",
      candidate: active,
      leaseExpiresAt: "2026-07-23T14:00:00.000Z",
      now: loopNow,
      slotId: "worker-1",
    });

    expect(analyzeCandidates([issueCandidate(1)], state).blockers.get(1)).toContain("active-claim");
    expect(() =>
      reserveAttempt(state, {
        attemptId: "attempt-1-duplicate",
        candidate: active,
        leaseExpiresAt: "2026-07-23T14:00:00.000Z",
        now: loopNow,
        slotId: "worker-2",
      }),
    ).toThrow("issue-already-active");
  });

  it("rejects persisted duplicate slot ownership and duplicate active issues", () => {
    const state = loopState();
    const candidates = analyzeCandidates([issueCandidate(1), issueCandidate(2)], state).eligible;
    reserveAttempt(state, {
      attemptId: "attempt-1",
      candidate: requiredValue(candidates[0]),
      leaseExpiresAt: "2026-07-23T14:00:00.000Z",
      now: loopNow,
      slotId: "worker-1",
    });
    reserveAttempt(state, {
      attemptId: "attempt-2",
      candidate: requiredValue(candidates[1]),
      leaseExpiresAt: "2026-07-23T14:00:00.000Z",
      now: loopNow,
      slotId: "worker-2",
    });
    const duplicateSlot = structuredClone(state);
    duplicateSlot.slots[1].attemptId = "attempt-1";
    expect(LoopStateSchema.safeParse(duplicateSlot).success).toBe(false);

    const duplicateIssue = structuredClone(state);
    requiredValue(duplicateIssue.attempts[1]).issueNumber = 1;
    expect(LoopStateSchema.safeParse(duplicateIssue).success).toBe(false);

    const orphanedAttempt = structuredClone(state);
    orphanedAttempt.slots[0] = { id: "worker-1", status: "free" };
    expect(LoopStateSchema.safeParse(orphanedAttempt).success).toBe(false);

    const mismatchedStage = structuredClone(state);
    requiredValue(mismatchedStage.attempts[0]).stage = "review";
    expect(LoopStateSchema.safeParse(mismatchedStage).success).toBe(false);

    const mismatchedLease = structuredClone(state);
    requiredValue(mismatchedLease.slots[0]).leaseExpiresAt = "2026-07-24T14:00:00.000Z";
    expect(LoopStateSchema.safeParse(mismatchedLease).success).toBe(false);

    const duplicateAttemptId = structuredClone(state);
    duplicateAttemptId.attempts.push(structuredClone(requiredValue(state.attempts[0])));
    expect(LoopStateSchema.safeParse(duplicateAttemptId).success).toBe(false);
  });

  it("rejects ambiguous logical audit and rework keys", () => {
    const base = loopState();
    const audit = {
      at: loopNow,
      attemptId: "attempt-1",
      eventId: "event-1",
      issueNumber: 1,
      result: "success" as const,
      slotId: "worker-1" as const,
      stage: "review" as const,
    };
    const maintenance = {
      at: loopNow,
      eventId: "maintenance-1",
      removedAttempts: 0,
      result: "success" as const,
    };
    const reworkAudit = {
      at: loopNow,
      eventId: "rework-1",
      issueNumber: 1,
      result: "rejected" as const,
      safeReason: "safe-reason",
    };
    const reworkRequest = {
      approvedFeedbackIds: ["feedback-1"],
      baseCommit: "abcdef1234567",
      eventId: "rework-1",
      issueNumber: 1,
      prNumber: 1,
      requestedAt: loopNow,
      requestedBy: "owner",
      status: "queued" as const,
    };
    for (const invalid of [
      { ...base, audit: [audit, audit] },
      {
        ...base,
        deliveredEvents: [deliveryKey("event-1", "attempt-1"), deliveryKey("event-1", "attempt-1")],
      },
      { ...base, maintenanceAudit: [maintenance, maintenance] },
      { ...base, reworkAudit: [reworkAudit, reworkAudit] },
      { ...base, reworkRequests: [reworkRequest, reworkRequest] },
    ]) {
      expect(LoopStateSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("uses canonical collision-free delivery keys at the component boundary", () => {
    const eventId = `e${"x".repeat(119)}`;
    const attemptId = `a${"y".repeat(119)}`;
    const key = deliveryKey(eventId, attemptId);

    expect(key).toBe(JSON.stringify([eventId, attemptId]));
    expect(key).toHaveLength(247);
    expect(
      LoopStateSchema.safeParse({
        ...loopState(),
        deliveredEvents: [key],
      }).success,
    ).toBe(true);
    expect(() => deliveryKey("event:attempt", "tail")).not.toThrow();
    expect(deliveryKey("event:attempt", "tail")).not.toBe(deliveryKey("event", "attempt:tail"));
  });

  it("releases review capacity without losing attempt evidence", () => {
    const state = loopState();
    const candidate = requiredValue(analyzeCandidates([issueCandidate(1)], state).eligible[0]);
    reserveAttempt(state, {
      attemptId: "attempt-1",
      candidate,
      leaseExpiresAt: "2026-07-23T14:00:00.000Z",
      now: loopNow,
      slotId: "worker-1",
    });
    releaseAttempt(state, "attempt-1", "review", "2026-07-23T13:00:00.000Z");

    expect(state.slots[0]).toEqual({ id: "worker-1", status: "free" });
    expect(state.attempts[0]?.stage).toBe("review");
  });

  it("transitions optional evidence and rejects missing or mismatched ownership", () => {
    const state = loopState();
    const candidate = requiredValue(analyzeCandidates([issueCandidate(1)], state).eligible[0]);
    reserveAttempt(state, {
      attemptId: "attempt-1",
      candidate,
      leaseExpiresAt: "2026-07-23T14:00:00.000Z",
      now: loopNow,
      slotId: "worker-1",
    });
    const transitioned = transitionAttempt(
      state,
      "attempt-1",
      "attention",
      "2026-07-23T13:00:00.000Z",
      {
        commitSha: "abcdef1234567",
        errorCode: "safe-error",
        threadId: "thread-1",
      },
    );

    expect(transitioned).toMatchObject({
      commitSha: "abcdef1234567",
      errorCode: "safe-error",
      threadId: "thread-1",
    });
    expect(state.slots[0].status).toBe("attention");
    expect(() =>
      transitionAttempt(state, "missing", "running", "2026-07-23T13:00:00.000Z"),
    ).toThrow("attempt-not-found");
    state.slots[0].attemptId = "different";
    expect(() =>
      transitionAttempt(state, "attempt-1", "running", "2026-07-23T13:00:00.000Z"),
    ).toThrow("slot-attempt-mismatch");
    expect(() =>
      releaseAttempt(state, "attempt-1", "attention", "2026-07-23T13:00:00.000Z"),
    ).toThrow("slot-attempt-mismatch");
    expect(() => releaseAttempt(state, "missing", "attention", "2026-07-23T13:00:00.000Z")).toThrow(
      "attempt-not-found",
    );
  });

  it("does not materialize omitted transition evidence", () => {
    const state = loopState();
    const candidate = requiredValue(analyzeCandidates([issueCandidate(1)], state).eligible[0]);
    reserveAttempt(state, {
      attemptId: "attempt-1",
      candidate,
      leaseExpiresAt: "2026-07-23T14:00:00.000Z",
      now: loopNow,
      slotId: "worker-1",
    });

    const attempt = transitionAttempt(state, "attempt-1", "running", "2026-07-23T13:00:00.000Z");

    expect(Object.hasOwn(attempt, "commitSha")).toBe(false);
    expect(Object.hasOwn(attempt, "errorCode")).toBe(false);
    expect(Object.hasOwn(attempt, "threadId")).toBe(false);
  });

  it("claims and completes trusted rework on the existing PR and branch", () => {
    const state = loopState();
    const issue = issueCandidate(9, {
      labels: ["codex-rework", "priority:p2"],
      linkedPullRequest: {
        baseRef: "main",
        draft: true,
        headRef: "codex/9-safe",
        headSha: "abcdef1234567",
        headRepositoryOwner: "owner",
        isCrossRepository: false,
        number: 12,
        state: "open",
        url: "https://github.com/owner/suno-automation/pull/12",
      },
    });
    state.reworkRequests.push({
      approvedFeedbackIds: ["feedback-1"],
      baseCommit: "abcdef1234567",
      eventId: "rework-event",
      issueNumber: 9,
      prNumber: 12,
      requestedAt: "2026-07-23T11:00:00.000Z",
      requestedBy: "owner",
      status: "queued",
    });
    const candidate = requiredValue(analyzeCandidates([issue], state).eligible[0]);
    const first = reserveAttempt(state, {
      attemptId: "attempt-rework-1",
      candidate,
      leaseExpiresAt: "2026-07-23T14:00:00.000Z",
      now: loopNow,
      slotId: "worker-1",
    });

    expect(first).toMatchObject({
      branchName: "codex/9-safe",
      pullRequest: { number: 12 },
      trigger: "rework",
    });
    expect(state.reworkRequests[0]?.status).toBe("claimed");
    first.commitSha = "abcdef1234567";
    first.verification = {
      attemptId: first.attemptId,
      commands: [],
      commitSha: first.commitSha,
      createdAt: loopNow,
      findings: [],
      signature: "0".repeat(64),
      slotId: first.slotId,
      status: "pass",
      version: 1,
    };
    releaseAttempt(state, first.attemptId, "review", "2026-07-23T13:00:00.000Z");
    expect(state.reworkRequests[0]?.status).toBe("completed");

    state.reworkRequests.push({
      ...requiredValue(state.reworkRequests[0]),
      eventId: "rework-event-2",
      requestedAt: "2026-07-23T13:30:00.000Z",
      status: "queued",
    });
    const next = reserveAttempt(state, {
      attemptId: "attempt-rework-2",
      candidate: requiredValue(analyzeCandidates([issue], state).eligible[0]),
      leaseExpiresAt: "2026-07-23T16:00:00.000Z",
      now: "2026-07-23T14:00:00.000Z",
      slotId: "worker-1",
    });
    expect(next.parentAttemptId).toBe("attempt-rework-1");
    state.reworkRequests.push({
      approvedFeedbackIds: ["feedback-unrelated"],
      baseCommit: "abcdef1234567",
      eventId: "rework-unrelated",
      issueNumber: 99,
      prNumber: 99,
      requestedAt: "2026-07-23T14:30:00.000Z",
      requestedBy: "owner",
      status: "claimed",
    });
    releaseAttempt(state, next.attemptId, "attention", "2026-07-23T15:00:00.000Z", "review-failed");
    expect(state.reworkRequests[1]?.status).toBe("rejected");
    expect(state.reworkRequests[2]?.status).toBe("claimed");
    expect(next.errorCode).toBe("review-failed");
  });

  it("deduplicates audit delivery and never prunes draft-review evidence", () => {
    const state = loopState();
    const candidates = analyzeCandidates([issueCandidate(1), issueCandidate(2)], state).eligible;
    for (const [index, candidate] of candidates.entries()) {
      const attemptId = `attempt-${(index + 1).toString()}`;
      const attempt = reserveAttempt(state, {
        attemptId,
        candidate,
        leaseExpiresAt: "2026-04-01T14:00:00.000Z",
        now: "2026-04-01T12:00:00.000Z",
        slotId: index === 0 ? "worker-1" : "worker-2",
      });
      if (index === 0) {
        attempt.pullRequest = {
          draft: true,
          number: 1,
          url: "https://github.com/owner/suno-automation/pull/1",
        };
        releaseAttempt(state, attemptId, "review", "2026-04-01T13:00:00.000Z");
      }
    }
    const event = {
      at: "2026-04-01T13:00:00.000Z",
      attemptId: "attempt-1",
      eventId: "review-attempt-1",
      issueNumber: 1,
      result: "success" as const,
      slotId: "worker-1" as const,
      stage: "review" as const,
    };
    recordAudit(state, event);
    recordAudit(state, { ...event, result: "failure" });

    expect(state.audit).toHaveLength(1);
    expect(state.audit[0]?.result).toBe("failure");
    expect(hasDelivered(state, event.eventId, event.attemptId)).toBe(true);
    expect(hasDelivered(state, "unknown-event", event.attemptId)).toBe(false);
    expect(
      pruneAudit(state, new Date("2026-07-23T12:00:00.000Z"), {
        completedAttempts: 500,
        days: 90,
      }),
    ).toBe(0);
    expect(state.attempts.map((attempt) => attempt.attemptId)).toEqual(["attempt-1", "attempt-2"]);
  });

  it("does not overwrite unrelated audit or delivery evidence", () => {
    const state = loopState();
    const first = {
      at: loopNow,
      attemptId: "attempt-1",
      eventId: "event-1",
      issueNumber: 1,
      result: "success" as const,
      slotId: "worker-1" as const,
      stage: "claimed" as const,
    };
    const second = {
      ...first,
      attemptId: "attempt-2",
      eventId: "event-2",
      issueNumber: 2,
      slotId: "worker-2" as const,
    };

    recordAudit(state, first);
    recordAudit(state, second);

    expect(state.audit).toEqual([first, second]);
    expect(state.deliveredEvents).toEqual([
      deliveryKey("event-1", "attempt-1"),
      deliveryKey("event-2", "attempt-2"),
    ]);
  });

  it("retains every draft review and every active attempt regardless of terminal retention", () => {
    const state = loopState();
    const candidates = analyzeCandidates(
      [issueCandidate(1), issueCandidate(2), issueCandidate(3)],
      state,
    ).eligible;
    for (const [index, timestamp] of [
      "2026-07-22T12:00:00.000Z",
      "2026-07-21T12:00:00.000Z",
    ].entries()) {
      const attempt = reserveAttempt(state, {
        attemptId: `terminal-${(index + 1).toString()}`,
        candidate: requiredValue(candidates[index]),
        leaseExpiresAt: "2026-07-23T14:00:00.000Z",
        now: timestamp,
        slotId: "worker-1",
      });
      attempt.pullRequest = {
        draft: true,
        number: index + 1,
        url: `https://github.com/owner/suno-automation/pull/${(index + 1).toString()}`,
      };
      releaseAttempt(state, attempt.attemptId, "review", timestamp);
      recordAudit(state, {
        at: timestamp,
        attemptId: attempt.attemptId,
        eventId: `event-${(index + 1).toString()}`,
        issueNumber: attempt.issueNumber,
        result: "success",
        slotId: "worker-1",
        stage: "review",
      });
    }
    reserveAttempt(state, {
      attemptId: "active-3",
      candidate: requiredValue(candidates[2]),
      leaseExpiresAt: "2026-07-24T14:00:00.000Z",
      now: loopNow,
      slotId: "worker-2",
    });
    recordAudit(state, {
      at: loopNow,
      attemptId: "active-3",
      eventId: "event-active",
      issueNumber: 3,
      result: "pending",
      slotId: "worker-2",
      stage: "reserved",
    });

    expect(
      pruneAudit(state, new Date("2026-07-23T12:00:00.000Z"), {
        completedAttempts: 1,
        days: 10,
      }),
    ).toBe(0);
    expect(state.attempts.map((attempt) => attempt.attemptId)).toEqual([
      "terminal-1",
      "terminal-2",
      "active-3",
    ]);
    expect(state.audit.map((event) => event.eventId)).toEqual([
      "event-1",
      "event-2",
      "event-active",
    ]);
    expect(state.deliveredEvents).toEqual([
      deliveryKey("event-1", "terminal-1"),
      deliveryKey("event-2", "terminal-2"),
      deliveryKey("event-active", "active-3"),
    ]);
  });

  it("never prunes released attention or an old draft review", () => {
    const state = loopState();
    const candidates = analyzeCandidates([issueCandidate(1), issueCandidate(2)], state).eligible;
    const attention = reserveAttempt(state, {
      attemptId: "attention-old",
      candidate: requiredValue(candidates[0]),
      leaseExpiresAt: "2026-01-01T14:00:00.000Z",
      now: "2026-01-01T12:00:00.000Z",
      slotId: "worker-1",
    });
    releaseAttempt(state, attention.attemptId, "attention", "2026-01-01T13:00:00.000Z");
    const terminal = reserveAttempt(state, {
      attemptId: "review-old",
      candidate: requiredValue(candidates[1]),
      leaseExpiresAt: "2026-01-01T14:00:00.000Z",
      now: "2026-01-01T12:00:00.000Z",
      slotId: "worker-1",
    });
    terminal.pullRequest = {
      draft: true,
      number: 2,
      url: "https://github.com/owner/suno-automation/pull/2",
    };
    releaseAttempt(state, terminal.attemptId, "review", "2026-01-01T13:00:00.000Z");

    expect(
      pruneAudit(state, new Date(loopNow), {
        completedAttempts: 1,
        days: 1,
      }),
    ).toBe(0);
    expect(state.attempts.map((attempt) => attempt.attemptId)).toEqual([
      "attention-old",
      "review-old",
    ]);
    expect(state.slots.every((slot) => slot.status === "free")).toBe(true);
  });

  it("bounds terminal rework and maintenance audit while retaining active references", () => {
    const state = loopState();
    state.reworkRequests.push(
      {
        approvedFeedbackIds: ["feedback-active"],
        baseCommit: "abcdef1234567",
        eventId: "active-old",
        issueNumber: 10,
        prNumber: 10,
        requestedAt: "2026-01-01T12:00:00.000Z",
        requestedBy: "owner",
        status: "queued",
      },
      ...["old-terminal", "recent-terminal", "newest-terminal"].map((eventId, index) => ({
        approvedFeedbackIds: [`feedback-${index.toString()}`],
        baseCommit: "abcdef1234567",
        eventId,
        issueNumber: 20 + index,
        prNumber: 20 + index,
        requestedAt:
          ["2026-01-01T12:00:00.000Z", "2026-07-22T10:00:00.000Z", "2026-07-22T11:00:00.000Z"][
            index
          ] ?? loopNow,
        requestedBy: "owner",
        status: "completed" as const,
      })),
    );
    state.reworkAudit.push(
      {
        at: "2026-01-01T12:00:00.000Z",
        eventId: "active-old",
        issueNumber: 10,
        result: "queued",
      },
      {
        at: "2026-01-01T12:00:00.000Z",
        eventId: "old-rejected",
        issueNumber: 99,
        result: "rejected",
        safeReason: "safe-reason",
      },
      {
        at: "2026-07-22T12:00:00.000Z",
        eventId: "recent-rejected",
        issueNumber: 98,
        result: "rejected",
        safeReason: "safe-reason",
      },
    );
    state.maintenanceAudit.push(
      {
        at: "2026-01-01T12:00:00.000Z",
        eventId: "maintenance-old",
        removedAttempts: 0,
        result: "success",
      },
      {
        at: "2026-07-22T10:00:00.000Z",
        eventId: "maintenance-recent",
        removedAttempts: 0,
        result: "success",
      },
      {
        at: "2026-07-22T11:00:00.000Z",
        eventId: "maintenance-newest",
        removedAttempts: 0,
        result: "success",
      },
    );

    pruneAudit(state, new Date(loopNow), { completedAttempts: 1, days: 90 });

    expect(state.reworkRequests.map((request) => request.eventId)).toEqual([
      "active-old",
      "newest-terminal",
    ]);
    expect(state.reworkAudit.map((event) => event.eventId)).toEqual([
      "active-old",
      "recent-rejected",
    ]);
    expect(state.maintenanceAudit.map((event) => event.eventId)).toEqual(["maintenance-newest"]);
  });

  it("retains only the three durable queued rework counters per issue after retention", () => {
    const state = loopState();
    for (let index = 1; index <= 4; index += 1) {
      state.reworkAudit.push({
        at: `2026-0${index.toString()}-01T12:00:00.000Z`,
        eventId: `rework-counter-${index.toString()}`,
        issueNumber: 42,
        result: "queued",
      });
    }

    pruneAudit(state, new Date(loopNow), { completedAttempts: 1, days: 1 });

    expect(state.reworkAudit.filter((event) => event.issueNumber === 42)).toHaveLength(3);
    expect(state.reworkAudit.map((event) => event.eventId)).not.toContain("rework-counter-1");
  });

  it("creates bounded deterministic branch names", () => {
    const branch = createBranchName(42);
    expect(branch).toMatch(/^codex\/42-[a-z0-9-]+$/);
    expect(branch.length).toBeLessThan(60);
    expect(branch).toBe("codex/42-implementation");
    expect(createBranchName(7)).toBe("codex/7-implementation");
  });

  it("renders lifecycle acknowledgements with optional safe errors", () => {
    expect(
      lifecycleComment({
        attemptId: "attempt-1",
        eventId: "event-1",
        result: "claimed",
        stage: "claimed",
      }),
    ).not.toContain("error=");
    expect(
      lifecycleComment({
        attemptId: "attempt-1",
        errorCode: "safe-error",
        eventId: "event-2",
        result: "attention",
        stage: "attention",
      }),
    ).toContain("error=safe-error");
  });
});
