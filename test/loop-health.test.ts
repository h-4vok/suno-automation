import { describe, expect, it } from "vitest";
import { analyzeCandidates, reserveAttempt } from "../src/loop/domain.js";
import type { GitHubLoopPort, IssueTransition, PullRequestSnapshot } from "../src/loop/github.js";
import {
  buildHealth,
  LocalReconciliationEvidence,
  LoopReconciliationService,
  type ReconciliationEvidencePort,
} from "../src/loop/health.js";
import {
  AuditEventSchema,
  type AttemptRecord,
  type IssueCandidate,
  type LoopConfig,
} from "../src/loop/schema.js";
import { InMemoryLoopStateStore } from "../src/loop/store.js";
import {
  issueCandidate,
  loopConfig,
  loopNow,
  loopState,
  requiredValue,
} from "./support/loop-fixtures.js";

class ReconcileGitHub implements GitHubLoopPort {
  authorizationActor = "OwNeR";
  completeCalls = 0;
  issue: IssueCandidate;
  onAuthorization?: () => Promise<void> | void;
  pullRequest: PullRequestSnapshot;
  readonly transitions: IssueTransition[] = [];

  constructor(
    issue: IssueCandidate,
    pullRequest: PullRequestSnapshot = {
      baseRef: "main",
      draft: true,
      headRef: "codex/42-safe",
      headRepositoryOwner: "owner",
      headSha: "abcdef1234567",
      isCrossRepository: false,
      number: 1,
      state: "open",
      url: "https://github.com/owner/suno-automation/pull/1",
    },
  ) {
    this.issue = issue;
    this.pullRequest = pullRequest;
  }

  getIssue(): Promise<IssueCandidate> {
    return Promise.resolve(this.issue);
  }

  listQueue(): Promise<readonly IssueCandidate[]> {
    return Promise.resolve([]);
  }

  getPullRequest(): Promise<PullRequestSnapshot> {
    return Promise.resolve(this.pullRequest);
  }

  transitionIssue(transition: IssueTransition): Promise<"applied"> {
    this.transitions.push(transition);
    return Promise.resolve("applied");
  }

  completeMergedIssue(): Promise<"applied"> {
    this.completeCalls += 1;
    return Promise.resolve("applied");
  }

  async getReconciliationAuthorization(): Promise<{
    readonly actor: string;
    readonly authorizedAt: string;
  }> {
    await this.onAuthorization?.();
    return {
      actor: this.authorizationActor,
      authorizedAt: "2026-07-23T10:30:00.000Z",
    };
  }

  ensureDraftPullRequest(): Promise<PullRequestSnapshot> {
    return this.getPullRequest();
  }
}

function occupiedState() {
  const state = loopState();
  const candidate = requiredValue(
    analyzeCandidates([issueCandidate(42)], state, ["owner"]).eligible[0],
  );
  const attempt = reserveAttempt(state, {
    attemptId: "attempt-42",
    candidate,
    leaseExpiresAt: "2026-07-23T11:00:00.000Z",
    now: "2026-07-23T10:00:00.000Z",
    slotId: "worker-1",
  });
  attempt.stage = "running";
  attempt.threadId = "thread-42";
  state.slots[0].status = "running";
  return state;
}

function bindPublishedVerdict(attempt: AttemptRecord): void {
  if (attempt.commitSha === undefined) throw new Error("fixture-commit-missing");
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
}

describe("loop health and reconciliation", () => {
  it("reports both slots, queue depth, stale leases, and recent outcomes without local data", () => {
    const state = occupiedState();
    state.audit.push({
      at: "2026-07-23T11:30:00.000Z",
      attemptId: "attempt-42",
      eventId: "event-42",
      issueNumber: 42,
      result: "success",
      slotId: "worker-1",
      stage: "running",
    });
    const health = buildHealth(
      state,
      [
        issueCandidate(50, { labels: ["codex-ready", "priority:p0"] }),
        issueCandidate(51, { labels: ["codex-rework", "priority:p2"] }),
      ],
      new Date(loopNow),
    );

    expect(health.summary).toMatchObject({
      activeWorkers: 1,
      capacity: 2,
      staleLeases: 1,
    });
    expect(health.slots.map((slot) => slot.state)).toEqual(["running", "free"]);
    expect(health.queue).toMatchObject({
      byLifecycle: { "codex-ready": 1, "codex-rework": 1 },
      total: 2,
    });
    expect(JSON.stringify(health)).not.toMatch(/C:\\|project-worker|thread-42/);
  });

  it("rejects raw paths, prompt bodies, and secret fields at the audit schema boundary", () => {
    const unsafe = AuditEventSchema.safeParse({
      at: loopNow,
      attemptId: "attempt-42",
      eventId: "event-42",
      issueNumber: 42,
      localPath: "C:\\private\\worker",
      prompt: "private prompt",
      result: "failure",
      secret: ["ghp", "secret"].join("_"),
      slotId: "worker-1",
      stage: "attention",
    });

    expect(unsafe.success).toBe(false);
  });

  it("surfaces orphan lifecycle, missing attempts, owner conflicts, and attention codes", () => {
    const state = occupiedState();
    const attempt = requiredValue(state.attempts[0]);
    attempt.stage = "attention";
    attempt.errorCode = "safe-failure";
    state.slots[0].attemptId = "missing-attempt";
    const health = buildHealth(
      state,
      [issueCandidate(50, { labels: ["enhancement"] })],
      new Date(loopNow),
      [issueCandidate(99, { labels: ["codex-in-progress", "priority:p2"] })],
    );

    expect(health.summary.contradictions).toEqual(
      expect.arrayContaining(["github:#99:orphan-active", "worker-1:missing-attempt"]),
    );
    expect(health.queue).toMatchObject({
      byLifecycle: { unknown: 1 },
      byPriority: { unknown: 1 },
    });
    expect(health.attention).toEqual([
      {
        attemptId: "attempt-42",
        errorCode: "safe-failure",
        issueNumber: 42,
      },
    ]);

    state.slots[0].attemptId = "attempt-42";
    attempt.slotId = "worker-2";
    expect(buildHealth(state, [], new Date(loopNow)).summary.contradictions).toContain(
      "worker-1:attempt-owner-conflict",
    );
  });

  it("fails stale contradictory evidence to attention in dry-run only", async () => {
    const state = occupiedState();
    const evidence: ReconciliationEvidencePort = {
      inspect: () =>
        Promise.resolve({
          branch: "wrong-branch",
          clean: false,
          exists: true,
          head: "different-commit",
        }),
    };
    const store = new InMemoryLoopStateStore(state);
    const service = new LoopReconciliationService(
      loopConfig(),
      store,
      new ReconcileGitHub(issueCandidate(42, { labels: ["codex-in-progress", "priority:p0"] })),
      evidence,
      () => new Date(loopNow),
    );

    const report = await service.reconcileDryRun();

    const item = requiredValue(report.items[0]);
    expect(item.recommendation).toBe("move-to-attention");
    expect(item.reasons).toEqual(
      expect.arrayContaining(["worktree-dirty", "branch-ownership-conflict", "lease-stale"]),
    );
    expect((await store.read()).slots[0].status).toBe("running");
  });

  it.each([
    {
      lifecycle: "codex-review",
      pr: { draft: true, state: "open" },
      stage: "review",
      expected: "release-review-slot",
    },
    {
      lifecycle: "codex-in-progress",
      issueState: "closed",
      pr: { draft: false, state: "merged" },
      stage: "pushed",
      expected: "complete-merged",
    },
    {
      lifecycle: "codex-in-progress",
      pr: { draft: true, state: "open" },
      stage: "pr-linked",
      expected: "finalize-review",
    },
  ] as const)(
    "recommends $expected from authoritative GitHub and PR evidence",
    async ({ expected, issueState = "open", lifecycle, pr, stage }) => {
      const state = occupiedState();
      const attempt = requiredValue(state.attempts[0]);
      attempt.stage = stage;
      attempt.branchName = "codex/42-safe";
      attempt.commitSha = "abcdef1234567";
      attempt.pullRequest = {
        draft: true,
        number: 1,
        url: "https://github.com/owner/suno-automation/pull/1",
      };
      bindPublishedVerdict(attempt);
      if (stage === "review") {
        state.slots[0] = { id: "worker-1", status: "free" };
      }
      const evidence: ReconciliationEvidencePort = {
        inspect: () =>
          expected === "finalize-review"
            ? Promise.resolve({
                branch: "codex/42-safe",
                clean: true,
                exists: true,
                head: "abcdef1234567",
              })
            : Promise.resolve({
                baseHead: "base-sha",
                branch: "",
                clean: true,
                exists: true,
                head: "base-sha",
                remoteBranchHead: "abcdef1234567",
              }),
      };
      const service = new LoopReconciliationService(
        loopConfig(),
        new InMemoryLoopStateStore(state),
        new ReconcileGitHub(
          issueCandidate(42, {
            labels: [lifecycle, "priority:p0"],
            state: issueState as "closed" | "open",
          }),
          {
            baseRef: "main",
            draft: pr.draft,
            headRef: "codex/42-safe",
            headRepositoryOwner: "owner",
            headSha: "abcdef1234567",
            isCrossRepository: false,
            number: 1,
            state: pr.state,
            url: "https://github.com/owner/suno-automation/pull/1",
          },
        ),
        evidence,
        () => new Date("2026-07-23T10:30:00.000Z"),
      );

      expect(
        (
          await service.reconcileDryRun([
            {
              attemptId: "attempt-42",
              observedAt: "2026-07-23T10:30:00.000Z",
              source: "codex-desktop",
              state: expected === "release-review-slot" ? "inactive" : "absent",
              ...(expected === "release-review-slot" ? { threadId: "thread-42" } : {}),
              version: 1,
            },
          ])
        ).items[0]?.recommendation,
      ).toBe(expected);
    },
  );

  it("ignores a released review once a newer active rework owns the same PR", async () => {
    const state = occupiedState();
    const review = requiredValue(state.attempts[0]);
    review.branchName = "codex/42-safe";
    review.commitSha = "abcdef1234567";
    review.pullRequest = {
      draft: true,
      number: 1,
      url: "https://github.com/owner/suno-automation/pull/1",
    };
    review.stage = "review";
    bindPublishedVerdict(review);
    state.slots[0] = { id: "worker-1", status: "free" };

    const reworkIssue = issueCandidate(42, {
      labels: ["codex-rework"],
      linkedPullRequest: {
        baseRef: "main",
        draft: true,
        headRef: "codex/42-safe",
        headRepositoryOwner: "owner",
        headSha: "fedcba9876543",
        isCrossRepository: false,
        number: 1,
        state: "open",
        url: "https://github.com/owner/suno-automation/pull/1",
      },
    });
    state.reworkRequests.push({
      approvedFeedbackIds: ["feedback-42"],
      baseCommit: "abcdef1234567",
      eventId: "rework-42",
      issueNumber: 42,
      prNumber: 1,
      requestedAt: "2026-07-23T10:15:00.000Z",
      requestedBy: "owner",
      status: "queued",
    });
    const rework = reserveAttempt(state, {
      attemptId: "attempt-42-rework",
      candidate: requiredValue(analyzeCandidates([reworkIssue], state, ["owner"]).eligible[0]),
      leaseExpiresAt: "2026-07-23T13:00:00.000Z",
      now: "2026-07-23T10:20:00.000Z",
      slotId: "worker-1",
    });
    rework.stage = "running";
    rework.threadId = "thread-42-rework";
    state.slots[0].status = "running";

    const store = new InMemoryLoopStateStore(state);
    const github = new ReconcileGitHub(
      issueCandidate(42, { labels: ["codex-in-progress", "priority:p0"] }),
      {
        baseRef: "main",
        draft: true,
        headRef: "codex/42-safe",
        headRepositoryOwner: "owner",
        headSha: "fedcba9876543",
        isCrossRepository: false,
        number: 1,
        state: "open",
        url: "https://github.com/owner/suno-automation/pull/1",
      },
    );
    const service = new LoopReconciliationService(
      loopConfig(),
      store,
      github,
      {
        inspect: () => Promise.resolve({ branch: "codex/42-safe", clean: true, exists: true }),
      },
      () => new Date("2026-07-23T10:30:00.000Z"),
    );

    expect((await service.reconcileDryRun()).items.map((item) => item.attemptId)).not.toContain(
      "attempt-42",
    );
    await expect(service.apply("attempt-42", "old-review-42", [])).rejects.toThrow(
      "reconciliation-attempt-not-found",
    );
    expect(github.transitions).toEqual([]);
    expect(
      (await store.read()).attempts.find((attempt) => attempt.attemptId === "attempt-42"),
    ).toMatchObject({ stage: "review" });
    expect((await store.read()).slots[0]).toMatchObject({
      attemptId: "attempt-42-rework",
      status: "running",
    });
  });

  it("rechecks released-review currency after authorization before mutating GitHub", async () => {
    const state = occupiedState();
    const review = requiredValue(state.attempts[0]);
    review.branchName = "codex/42-safe";
    review.commitSha = "abcdef1234567";
    review.pullRequest = {
      draft: true,
      number: 1,
      url: "https://github.com/owner/suno-automation/pull/1",
    };
    review.stage = "review";
    bindPublishedVerdict(review);
    state.slots[0] = { id: "worker-1", status: "free" };

    const store = new InMemoryLoopStateStore(state);
    const github = new ReconcileGitHub(
      issueCandidate(42, { labels: ["codex-review", "priority:p0"] }),
      {
        baseRef: "main",
        draft: true,
        headRef: "codex/42-safe",
        headRepositoryOwner: "owner",
        headSha: "fedcba9876543",
        isCrossRepository: false,
        number: 1,
        state: "open",
        url: "https://github.com/owner/suno-automation/pull/1",
      },
    );
    github.onAuthorization = () =>
      store.update((draft) => {
        const reworkIssue = issueCandidate(42, {
          labels: ["codex-ready", "priority:p0"],
        });
        const rework = reserveAttempt(draft, {
          attemptId: "attempt-42-rework",
          candidate: requiredValue(analyzeCandidates([reworkIssue], draft, ["owner"]).eligible[0]),
          leaseExpiresAt: "2026-07-23T13:00:00.000Z",
          now: "2026-07-23T10:20:00.000Z",
          slotId: "worker-1",
        });
        rework.stage = "running";
        rework.threadId = "thread-42-rework";
        draft.slots[0].status = "running";
      });
    const service = new LoopReconciliationService(
      loopConfig(),
      store,
      github,
      {
        inspect: () => Promise.resolve({ branch: "codex/42-safe", clean: true, exists: true }),
      },
      () => new Date("2026-07-23T10:30:00.000Z"),
    );

    await expect(service.apply("attempt-42", "racing-review-42", [])).rejects.toThrow(
      "reconciliation-attempt-superseded",
    );
    expect(github.transitions).toEqual([]);
  });

  it.each([
    { lifecycle: "codex-review", issueState: "open", prState: "open" },
    { lifecycle: "codex-in-progress", issueState: "closed", prState: "merged" },
  ] as const)(
    "gives local conflicts precedence over $prState terminal evidence",
    async ({ issueState, lifecycle, prState }) => {
      const state = occupiedState();
      const attempt = requiredValue(state.attempts[0]);
      attempt.stage = "pr-linked";
      attempt.branchName = "codex/42-safe";
      attempt.commitSha = "abcdef1234567";
      attempt.pullRequest = {
        draft: true,
        number: 1,
        url: "https://github.com/owner/suno-automation/pull/1",
      };
      bindPublishedVerdict(attempt);
      const service = new LoopReconciliationService(
        loopConfig(),
        new InMemoryLoopStateStore(state),
        new ReconcileGitHub(
          issueCandidate(42, {
            labels: [lifecycle, "priority:p0"],
            state: issueState,
          }),
          {
            baseRef: "main",
            draft: prState === "open",
            headRef: "codex/42-safe",
            headRepositoryOwner: "owner",
            headSha: "abcdef1234567",
            isCrossRepository: false,
            number: 1,
            state: prState,
            url: "https://github.com/owner/suno-automation/pull/1",
          },
        ),
        {
          inspect: () =>
            Promise.resolve({
              branch: "codex/42-safe",
              clean: false,
              exists: true,
              head: "abcdef1234567",
            }),
        },
        () => new Date("2026-07-23T10:30:00.000Z"),
      );

      const item = requiredValue(
        (
          await service.reconcileDryRun([
            {
              attemptId: "attempt-42",
              observedAt: "2026-07-23T10:30:00.000Z",
              source: "codex-desktop",
              state: "absent",
              version: 1,
            },
          ])
        ).items[0],
      );
      expect(item.recommendation).toBe("move-to-attention");
      expect(item.reasons).toContain("worktree-dirty");
    },
  );

  it("distinguishes a healthy running task from one that needs task recovery", async () => {
    const evidence: ReconciliationEvidencePort = {
      inspect: (_config, attempt) =>
        Promise.resolve({
          ...(attempt.branchName === undefined ? {} : { branch: attempt.branchName }),
          clean: true,
          exists: true,
          ...(attempt.commitSha === undefined ? {} : { head: attempt.commitSha }),
        }),
    };
    const state = occupiedState();
    requiredValue(state.attempts[0]).branchName = "codex/42-safe";
    const github = new ReconcileGitHub(
      issueCandidate(42, { labels: ["codex-in-progress", "priority:p0"] }),
    );
    const current = new Date("2026-07-23T10:30:00.000Z");
    const running = new LoopReconciliationService(
      loopConfig(),
      new InMemoryLoopStateStore(state),
      github,
      evidence,
      () => current,
    );

    expect(
      (
        await running.reconcileDryRun([
          {
            attemptId: "attempt-42",
            observedAt: current.toISOString(),
            source: "codex-desktop",
            state: "active",
            threadId: "thread-42",
            version: 1,
          },
        ])
      ).items[0]?.recommendation,
    ).toBe("leave-running");
    expect(
      (
        await running.reconcileDryRun([
          {
            attemptId: "attempt-42",
            observedAt: current.toISOString(),
            source: "codex-desktop",
            state: "absent",
            version: 1,
          },
        ])
      ).items[0]?.recommendation,
    ).toBe("move-to-attention");
    delete requiredValue(state.attempts[0]).threadId;
    requiredValue(state.attempts[0]).stage = "launch-pending";
    state.slots[0].status = "reserved";
    const missingTask = new LoopReconciliationService(
      loopConfig(),
      new InMemoryLoopStateStore(state),
      github,
      evidence,
      () => current,
    );
    const item = requiredValue(
      (
        await missingTask.reconcileDryRun([
          {
            attemptId: "attempt-42",
            observedAt: current.toISOString(),
            source: "codex-desktop",
            state: "absent",
            version: 1,
          },
        ])
      ).items[0],
    );
    expect(item.recommendation).toBe("resume-thread");
    expect(item.reasons).toContain("task-absent");
  });

  it("applies merged completion once from trusted GitHub authorization", async () => {
    const state = occupiedState();
    const attempt = requiredValue(state.attempts[0]);
    attempt.stage = "pushed";
    attempt.branchName = "codex/42-safe";
    attempt.commitSha = "abcdef1234567";
    attempt.pullRequest = {
      draft: true,
      number: 1,
      url: "https://github.com/owner/suno-automation/pull/1",
    };
    bindPublishedVerdict(attempt);
    const store = new InMemoryLoopStateStore(state);
    const github = new ReconcileGitHub(
      issueCandidate(42, {
        labels: ["codex-in-progress", "priority:p0"],
        state: "closed",
      }),
      {
        baseRef: "main",
        draft: false,
        headRef: "codex/42-safe",
        headRepositoryOwner: "owner",
        headSha: "abcdef1234567",
        isCrossRepository: false,
        number: 1,
        state: "merged",
        url: "https://github.com/owner/suno-automation/pull/1",
      },
    );
    const current = new Date("2026-07-23T10:30:00.000Z");
    const service = new LoopReconciliationService(
      loopConfig(),
      store,
      github,
      {
        inspect: () =>
          Promise.resolve({
            baseHead: "base-sha",
            branch: "",
            clean: true,
            exists: true,
            head: "base-sha",
            remoteBranchHead: "abcdef1234567",
          }),
      },
      () => current,
    );
    const tasks = [
      {
        attemptId: "attempt-42",
        observedAt: current.toISOString(),
        source: "codex-desktop" as const,
        state: "absent" as const,
        version: 1 as const,
      },
    ];

    await expect(service.apply("attempt-42", "reconcile-merged-42", tasks)).resolves.toMatchObject({
      applied: true,
      item: { recommendation: "complete-merged" },
    });
    await expect(service.apply("attempt-42", "reconcile-merged-42", tasks)).resolves.toMatchObject({
      applied: false,
    });
    expect(github.completeCalls).toBe(1);
    expect((await store.read()).attempts[0]?.stage).toBe("completed");
    expect((await store.read()).slots[0]).toEqual({ id: "worker-1", status: "free" });
  });

  it("moves dirty reconciliation to attention while retaining the local hold", async () => {
    const state = occupiedState();
    const attempt = requiredValue(state.attempts[0]);
    attempt.stage = "pr-linked";
    attempt.branchName = "codex/42-safe";
    attempt.commitSha = "abcdef1234567";
    attempt.pullRequest = {
      draft: true,
      number: 1,
      url: "https://github.com/owner/suno-automation/pull/1",
    };
    bindPublishedVerdict(attempt);
    const store = new InMemoryLoopStateStore(state);
    const github = new ReconcileGitHub(
      issueCandidate(42, { labels: ["codex-review", "priority:p0"] }),
    );
    const current = new Date("2026-07-23T10:30:00.000Z");
    const service = new LoopReconciliationService(
      loopConfig(),
      store,
      github,
      {
        inspect: () =>
          Promise.resolve({
            branch: "codex/42-safe",
            clean: false,
            exists: true,
            head: "abcdef1234567",
          }),
      },
      () => current,
    );
    const tasks = [
      {
        attemptId: "attempt-42",
        observedAt: current.toISOString(),
        source: "codex-desktop" as const,
        state: "absent" as const,
        version: 1 as const,
      },
    ];

    await expect(service.apply("attempt-42", "reconcile-dirty-42", tasks)).resolves.toMatchObject({
      applied: true,
      item: { recommendation: "move-to-attention" },
    });
    expect(github.transitions[0]).toMatchObject({ to: "codex-needs-attention" });
    expect((await store.read()).slots[0]).toMatchObject({
      attemptId: "attempt-42",
      status: "attention",
    });

    const untrustedState = occupiedState();
    const untrusted = new ReconcileGitHub(
      issueCandidate(42, { labels: ["codex-in-progress", "priority:p0"] }),
    );
    untrusted.authorizationActor = "intruder";
    const untrustedService = new LoopReconciliationService(
      loopConfig(),
      new InMemoryLoopStateStore(untrustedState),
      untrusted,
      {
        inspect: () => Promise.resolve({ clean: false, exists: false }),
      },
      () => current,
    );
    await expect(
      untrustedService.apply("attempt-42", "reconcile-untrusted-42", tasks),
    ).rejects.toThrow("untrusted-reconciliation-actor");
  });

  it("collects local git evidence and fails closed for missing paths or slot config", async () => {
    const state = occupiedState();
    const attempt = requiredValue(state.attempts[0]);
    const base = loopConfig();
    const localConfig: LoopConfig = {
      ...base,
      slots: [{ ...base.slots[0], worktreePath: process.cwd() }, base.slots[1]],
    };
    const evidence = new LocalReconciliationEvidence();
    const local = await evidence.inspect(localConfig, attempt);

    expect(local.exists).toBe(true);
    expect(local.head).toMatch(/^[a-f0-9]{40}$/);
    await expect(evidence.inspect(base, attempt)).resolves.toEqual({
      clean: false,
      exists: false,
    });
    const missingSlotConfig = { ...base, slots: [] } as unknown as LoopConfig;
    await expect(evidence.inspect(missingSlotConfig, attempt)).resolves.toEqual({
      clean: false,
      exists: false,
    });
  });
});
