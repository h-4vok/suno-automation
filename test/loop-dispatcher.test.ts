import { describe, expect, it, vi } from "vitest";
import {
  DualWorkerDispatcher,
  launchAssignments,
  type CodexThreadPort,
  type SlotSafetyPort,
} from "../src/loop/dispatcher.js";
import type { GitHubLoopPort, IssueTransition, PullRequestSnapshot } from "../src/loop/github.js";
import type { IssueCandidate } from "../src/loop/schema.js";
import {
  InMemoryDispatcherMutex,
  InMemoryLoopStateStore,
  MutexBusyError,
} from "../src/loop/store.js";
import { issueCandidate, loopCapabilities, loopConfig, loopNow } from "./support/loop-fixtures.js";

class FakeGitHub implements GitHubLoopPort {
  readonly transitions: IssueTransition[] = [];
  failIssue?: number;
  getIssueOverride?: IssueCandidate;
  issues: IssueCandidate[];

  constructor(issues: IssueCandidate[]) {
    this.issues = issues;
  }

  listQueue(): Promise<readonly IssueCandidate[]> {
    return Promise.resolve(structuredClone(this.issues));
  }

  getIssue(number: number): Promise<IssueCandidate> {
    if (this.getIssueOverride?.number === number) {
      return Promise.resolve(structuredClone(this.getIssueOverride));
    }
    const issue = this.issues.find((candidate) => candidate.number === number);
    return issue === undefined
      ? Promise.reject(new Error("missing"))
      : Promise.resolve(structuredClone(issue));
  }

  transitionIssue(transition: IssueTransition): Promise<"applied"> {
    if (this.failIssue === transition.issueNumber) {
      return Promise.reject(new Error("ambiguous"));
    }
    this.transitions.push(transition);
    this.issues = this.issues.map((issue) =>
      issue.number === transition.issueNumber
        ? {
            ...issue,
            labels: [...issue.labels.filter((label) => label !== transition.from), transition.to],
          }
        : issue,
    );
    return Promise.resolve("applied");
  }

  ensureDraftPullRequest(): Promise<PullRequestSnapshot> {
    return Promise.reject(new Error("not-used"));
  }

  getPullRequest(): Promise<PullRequestSnapshot> {
    return Promise.reject(new Error("not-used"));
  }
}

const inspectSafe = vi.fn((slot: { readonly worktreePath: string }) =>
  Promise.resolve({ canonicalPath: slot.worktreePath, safe: true }),
);
const safeSlots: SlotSafetyPort = {
  inspect: inspectSafe,
};

describe("dual-worker dispatcher", () => {
  it("claims two issues into distinct slots and leaves a third untouched", async () => {
    const github = new FakeGitHub([
      issueCandidate(1, { labels: ["codex-ready", "priority:p0"] }),
      issueCandidate(2, { labels: ["codex-ready", "priority:p1"] }),
      issueCandidate(3, { labels: ["codex-ready", "priority:p2"] }),
    ]);
    const store = new InMemoryLoopStateStore();
    let id = 0;
    const dispatcher = new DualWorkerDispatcher(
      loopConfig(),
      store,
      new InMemoryDispatcherMutex(),
      github,
      safeSlots,
      {
        attemptId: () => `attempt-${(++id).toString()}`,
        now: () => new Date(loopNow),
      },
    );

    const report = await dispatcher.dispatch(false, loopCapabilities());
    const state = await store.read();

    expect(report.assignments.map((assignment) => assignment.issueNumber)).toEqual([1, 2]);
    expect(report.assignments.map((assignment) => assignment.slotId)).toEqual([
      "worker-1",
      "worker-2",
    ]);
    expect(state.slots.map((slot) => slot.status)).toEqual(["reserved", "reserved"]);
    expect(github.transitions).toHaveLength(2);
    expect(github.issues.find((issue) => issue.number === 3)?.labels).toContain("codex-ready");
  });

  it("performs a zero-mutation dry-run with ordering and blockers", async () => {
    const github = new FakeGitHub([
      issueCandidate(1),
      issueCandidate(2, { labels: ["codex-ready", "priority:p0", "manual-validation"] }),
    ]);
    const store = new InMemoryLoopStateStore();
    const dispatcher = new DualWorkerDispatcher(
      loopConfig(),
      store,
      new InMemoryDispatcherMutex(),
      github,
      safeSlots,
      { attemptId: () => "must-not-run", now: () => new Date(loopNow) },
    );

    const report = await dispatcher.dispatch(true);

    expect(report.assignments).toHaveLength(1);
    expect(report.assignments[0]).toMatchObject({ attemptId: "dry-run", issueNumber: 1 });
    expect(report.blockers["2"]).toContain("manual-validation");
    expect(github.transitions).toHaveLength(0);
    expect((await store.read()).attempts).toHaveLength(0);
  });

  it("keeps an ambiguous GitHub claim out of active capacity", async () => {
    const github = new FakeGitHub([issueCandidate(1), issueCandidate(2)]);
    github.failIssue = 1;
    const store = new InMemoryLoopStateStore();
    const dispatcher = new DualWorkerDispatcher(
      loopConfig(),
      store,
      new InMemoryDispatcherMutex(),
      github,
      safeSlots,
      {
        attemptId: (() => {
          let next = 0;
          return () => `attempt-${(++next).toString()}`;
        })(),
        now: () => new Date(loopNow),
      },
    );

    const report = await dispatcher.dispatch(false, loopCapabilities());
    const state = await store.read();

    // The other worker can proceed, but the ambiguous claim's own slot is never reused.
    expect(report.assignments).toHaveLength(1);
    expect(report.assignments[0]).toMatchObject({ issueNumber: 2, slotId: "worker-2" });
    expect(state.slots[0]).toMatchObject({
      attemptId: "attempt-1",
      id: "worker-1",
      status: "attention",
    });
    expect(state.attempts[0]).toMatchObject({
      errorCode: "claim-github-ambiguous",
      stage: "attention",
    });
  });

  it("marks occupied and unsafe slots and never claims into either", async () => {
    const github = new FakeGitHub([issueCandidate(1), issueCandidate(2)]);
    const store = new InMemoryLoopStateStore();
    let attemptNumber = 0;
    const firstDispatcher = new DualWorkerDispatcher(
      loopConfig(),
      store,
      new InMemoryDispatcherMutex(),
      github,
      safeSlots,
      {
        attemptId: () => `attempt-${(++attemptNumber).toString()}`,
        now: () => new Date(loopNow),
      },
    );
    await firstDispatcher.dispatch(false, loopCapabilities());
    const unsafeSlots: SlotSafetyPort = {
      inspect: (slot) =>
        Promise.resolve(
          slot.id === "worker-1" ? { reason: "dirty-worktree", safe: false } : { safe: false },
        ),
    };
    const dispatcher = new DualWorkerDispatcher(
      loopConfig(),
      store,
      new InMemoryDispatcherMutex(),
      github,
      unsafeSlots,
      { now: () => new Date(loopNow) },
    );

    const report = await dispatcher.dispatch(false, loopCapabilities());

    // Existing pending launches are not handed to an unsafe worktree.
    expect(report.assignments).toHaveLength(0);
    expect(report.slots).toEqual([
      { id: "worker-1", status: "occupied" },
      { id: "worker-2", status: "occupied" },
    ]);

    const emptyReport = await new DualWorkerDispatcher(
      loopConfig(),
      new InMemoryLoopStateStore(),
      new InMemoryDispatcherMutex(),
      github,
      unsafeSlots,
      { now: () => new Date(loopNow) },
    ).dispatch(true);
    expect(emptyReport.assignments).toHaveLength(0);
    expect(emptyReport.slots).toEqual([
      { id: "worker-1", reason: "dirty-worktree", status: "unsafe" },
      { id: "worker-2", reason: "worktree-identity-unknown", status: "unsafe" },
    ]);
  });

  it("abandons a claim when lifecycle changes during authoritative revalidation", async () => {
    const github = new FakeGitHub([issueCandidate(1)]);
    github.getIssueOverride = issueCandidate(1, {
      labels: ["codex-ready", "priority:p0", "manual-validation"],
    });
    const store = new InMemoryLoopStateStore();
    const dispatcher = new DualWorkerDispatcher(
      loopConfig(),
      store,
      new InMemoryDispatcherMutex(),
      github,
      safeSlots,
      { attemptId: () => "must-not-reserve", now: () => new Date(loopNow) },
    );

    expect((await dispatcher.dispatch(false, loopCapabilities())).assignments).toHaveLength(0);
    expect((await store.read()).attempts).toHaveLength(0);
    expect(github.transitions).toHaveLength(0);
  });

  it("revalidates trusted promotion immediately before claim", async () => {
    const github = new FakeGitHub([issueCandidate(1)]);
    github.getIssueOverride = issueCandidate(1, {
      promotion: { actor: "intruder", eventId: "contract-promoted" },
    });
    const store = new InMemoryLoopStateStore();
    const dispatcher = new DualWorkerDispatcher(
      loopConfig(),
      store,
      new InMemoryDispatcherMutex(),
      github,
      safeSlots,
      { attemptId: () => "must-not-reserve", now: () => new Date(loopNow) },
    );

    const report = await dispatcher.dispatch(false, loopCapabilities());

    expect(report.assignments).toHaveLength(0);
    expect(github.transitions).toHaveLength(0);
    expect((await store.read()).attempts).toHaveLength(0);
  });

  it.each([
    ["number", { number: 89 }],
    ["base branch", { baseRef: "release" }],
    ["head", { headSha: "b".repeat(40) }],
  ])(
    "does not claim or alter lifecycle when a queued rework PR %s changed",
    async (_field, changedPullRequest) => {
      const authorizedHead = "a".repeat(40);
      const queued = issueCandidate(1, {
        labels: ["codex-rework", "priority:p0"],
        linkedPullRequest: {
          baseRef: "main",
          draft: true,
          headRef: "codex/1-implementation",
          headRepositoryOwner: "owner",
          headSha: authorizedHead,
          isCrossRepository: false,
          number: 88,
          state: "open",
          url: "https://github.com/owner/suno-automation/pull/88",
        },
      });
      const github = new FakeGitHub([queued]);
      const queuedPullRequest = queued.linkedPullRequest;
      if (queuedPullRequest === undefined) throw new Error("fixture-pull-request-missing");
      // The scheduler snapshot was valid, then the PR was updated before the
      // authoritative per-claim read.
      github.getIssueOverride = {
        ...queued,
        linkedPullRequest: { ...queuedPullRequest, ...changedPullRequest },
      };
      const store = new InMemoryLoopStateStore();
      await store.update((state) => {
        state.reworkRequests.push({
          approvedFeedbackIds: ["comment-1"],
          baseCommit: authorizedHead,
          eventId: "rework-1",
          issueNumber: 1,
          prNumber: 88,
          requestedAt: loopNow,
          requestedBy: "owner",
          status: "queued",
        });
      });
      const dispatcher = new DualWorkerDispatcher(
        loopConfig(),
        store,
        new InMemoryDispatcherMutex(),
        github,
        safeSlots,
        { attemptId: () => "must-not-reserve", now: () => new Date(loopNow) },
      );

      const report = await dispatcher.dispatch(false, loopCapabilities());

      expect(report.assignments).toHaveLength(0);
      expect((await store.read()).attempts).toHaveLength(0);
      expect((await store.read()).reworkRequests[0]?.status).toBe("queued");
      expect(github.transitions).toHaveLength(0);
    },
  );

  it("rejects missing capabilities before GitHub, mutex, slot, or state access", async () => {
    inspectSafe.mockClear();
    const github = new FakeGitHub([issueCandidate(1)]);
    const listQueue = vi.spyOn(github, "listQueue");
    const store = new InMemoryLoopStateStore();
    const dispatcher = new DualWorkerDispatcher(
      loopConfig(),
      store,
      new InMemoryDispatcherMutex(),
      github,
      safeSlots,
      { now: () => new Date(loopNow) },
    );

    await expect(dispatcher.dispatch(false)).rejects.toThrow();
    expect(listQueue).not.toHaveBeenCalled();
    expect(inspectSafe).not.toHaveBeenCalled();
    expect((await store.read()).attempts).toHaveLength(0);
  });

  it("audits retention maintenance and never prunes an occupied late-stage attempt", async () => {
    const github = new FakeGitHub([issueCandidate(1)]);
    const store = new InMemoryLoopStateStore();
    const first = new DualWorkerDispatcher(
      loopConfig(),
      store,
      new InMemoryDispatcherMutex(),
      github,
      safeSlots,
      {
        attemptId: () => "attempt-1",
        now: () => new Date(loopNow),
      },
    );
    await first.dispatch(false, loopCapabilities());
    await first.acknowledgeThread("attempt-1", "thread-1");
    await store.update((state) => {
      const attempt = state.attempts[0];
      if (attempt === undefined) throw new Error("fixture-attempt-missing");
      attempt.stage = "pr-linked";
      attempt.commitSha = "abcdef1234567";
      attempt.pullRequest = {
        draft: true,
        number: 99,
        url: "https://github.com/owner/suno-automation/pull/99",
      };
      attempt.verification = {
        attemptId: attempt.attemptId,
        commands: [],
        commitSha: attempt.commitSha,
        createdAt: loopNow,
        findings: [],
        signature: "0".repeat(64),
        slotId: attempt.slotId,
        status: "pass",
        version: 1,
      };
      attempt.updatedAt = "2020-01-01T00:00:00.000Z";
    });

    await new DualWorkerDispatcher(
      loopConfig(),
      store,
      new InMemoryDispatcherMutex(),
      github,
      safeSlots,
      { now: () => new Date("2026-07-23T12:00:01.000Z") },
    ).dispatch(false, {
      ...loopCapabilities(),
      observedAt: "2026-07-23T12:00:01.000Z",
    });

    const state = await store.read();
    expect(state.attempts.map((attempt) => attempt.attemptId)).toContain("attempt-1");
    expect(state.maintenanceAudit).toHaveLength(2);
    expect(state.maintenanceAudit[1]).toMatchObject({
      removedAttempts: 0,
      result: "success",
    });
  });

  it("deduplicates thread acknowledgement and rejects a conflicting task", async () => {
    const github = new FakeGitHub([issueCandidate(1)]);
    const store = new InMemoryLoopStateStore();
    const dispatcher = new DualWorkerDispatcher(
      loopConfig(),
      store,
      new InMemoryDispatcherMutex(),
      github,
      safeSlots,
      { attemptId: () => "attempt-1", now: () => new Date(loopNow) },
    );
    await dispatcher.dispatch(false, loopCapabilities());

    await dispatcher.acknowledgeThread("attempt-1", "thread-1");
    await dispatcher.acknowledgeThread("attempt-1", "thread-1");

    await expect(dispatcher.acknowledgeThread("attempt-1", "thread-2")).rejects.toThrow(
      "thread-ack-conflict",
    );
    expect((await store.read()).attempts[0]?.threadId).toBe("thread-1");
  });

  it("recovers launch acknowledgement by attempt before creating another task", async () => {
    const github = new FakeGitHub([issueCandidate(1)]);
    const store = new InMemoryLoopStateStore();
    const dispatcher = new DualWorkerDispatcher(
      loopConfig(),
      store,
      new InMemoryDispatcherMutex(),
      github,
      safeSlots,
      { attemptId: () => "attempt-1", now: () => new Date(loopNow) },
    );
    const report = await dispatcher.dispatch(false, loopCapabilities());
    const findByAttempt = vi.fn(() => Promise.resolve("existing-thread"));
    const launch = vi.fn(() => Promise.resolve("new-thread"));
    const threads: CodexThreadPort = { findByAttempt, launch };

    await launchAssignments(dispatcher, report, threads);

    expect(launch).not.toHaveBeenCalled();
    expect((await store.read()).attempts[0]?.threadId).toBe("existing-thread");
  });

  it("creates one task when recovery finds none and records the acknowledgement", async () => {
    const github = new FakeGitHub([issueCandidate(1)]);
    const store = new InMemoryLoopStateStore();
    const dispatcher = new DualWorkerDispatcher(
      loopConfig(),
      store,
      new InMemoryDispatcherMutex(),
      github,
      safeSlots,
      { attemptId: () => "attempt-1", now: () => new Date(loopNow) },
    );
    const report = await dispatcher.dispatch(false, loopCapabilities());
    const launch = vi.fn(() => Promise.resolve("new-thread"));
    const threads: CodexThreadPort = {
      findByAttempt: vi.fn(() => Promise.resolve(undefined)),
      launch,
    };

    await launchAssignments(dispatcher, report, threads);

    expect(launch).toHaveBeenCalledOnce();
    expect((await store.read()).attempts[0]).toMatchObject({
      stage: "running",
      threadId: "new-thread",
    });
    await expect(dispatcher.acknowledgeThread("missing", "thread")).rejects.toThrow(
      "attempt-not-found",
    );
  });

  it("persists launch failure before moving GitHub to attention", async () => {
    const github = new FakeGitHub([issueCandidate(1)]);
    const store = new InMemoryLoopStateStore();
    const dispatcher = new DualWorkerDispatcher(
      loopConfig(),
      store,
      new InMemoryDispatcherMutex(),
      github,
      safeSlots,
      { attemptId: () => "attempt-1", now: () => new Date(loopNow) },
    );
    await dispatcher.dispatch(false, loopCapabilities());

    await dispatcher.failLaunch("attempt-1", "codex-task-launch-failed");

    expect((await store.read()).attempts[0]).toMatchObject({
      errorCode: "codex-task-launch-failed",
      stage: "attention",
    });
    expect((await store.read()).slots[0].status).toBe("free");
    expect(github.transitions.at(-1)).toMatchObject({
      from: "codex-in-progress",
      to: "codex-needs-attention",
    });
    await expect(dispatcher.failLaunch("missing")).rejects.toThrow("attempt-not-found");
  });

  it("makes launch failure idempotent but never lets a late acknowledgement revive attention", async () => {
    const github = new FakeGitHub([issueCandidate(1)]);
    const store = new InMemoryLoopStateStore();
    const dispatcher = new DualWorkerDispatcher(
      loopConfig(),
      store,
      new InMemoryDispatcherMutex(),
      github,
      safeSlots,
      { attemptId: () => "attempt-1", now: () => new Date(loopNow) },
    );
    await dispatcher.dispatch(false, loopCapabilities());
    await dispatcher.failLaunch("attempt-1", "safe-launch-failure");

    await expect(
      dispatcher.failLaunch("attempt-1", "safe-launch-failure"),
    ).resolves.toBeUndefined();
    await expect(dispatcher.failLaunch("attempt-1", "different-failure")).rejects.toThrow(
      "launch-error-conflict",
    );
    await expect(dispatcher.acknowledgeThread("attempt-1", "late-thread")).rejects.toThrow(
      "thread-ack-stage-conflict",
    );
    expect((await store.read()).attempts[0]).toMatchObject({
      errorCode: "safe-launch-failure",
      stage: "attention",
    });
  });

  it("fails closed when overlapping ticks compete for the mutex", async () => {
    const github = new FakeGitHub([issueCandidate(1), issueCandidate(2)]);
    const store = new InMemoryLoopStateStore();
    const mutex = new InMemoryDispatcherMutex();
    let unblock: (() => void) | undefined;
    const gate = new Promise<{ safe: true }>((resolve) => {
      unblock = () => resolve({ safe: true });
    });
    const inspectBlocking = vi.fn(() => gate);
    const blockingSlots: SlotSafetyPort = { inspect: inspectBlocking };
    const dispatcher = new DualWorkerDispatcher(loopConfig(), store, mutex, github, blockingSlots, {
      attemptId: () => "attempt-1",
      now: () => new Date(loopNow),
    });
    const first = dispatcher.dispatch(true);
    await vi.waitFor(() => expect(inspectBlocking).toHaveBeenCalled());

    await expect(dispatcher.dispatch(true)).rejects.toBeInstanceOf(MutexBusyError);
    unblock?.();
    await first;
    expect((await store.read()).attempts).toHaveLength(0);
  });
});
