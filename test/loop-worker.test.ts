import { describe, expect, it, vi } from "vitest";
import { analyzeCandidates, reserveAttempt } from "../src/loop/domain.js";
import type { WorkerGitPort } from "../src/loop/git.js";
import type {
  EnsureDraftPullRequestInput,
  GitHubLoopPort,
  IssueTransition,
  PullRequestSnapshot,
  ReworkAuthorizationEvidence,
} from "../src/loop/github.js";
import type { AttemptRecord, IssueCandidate } from "../src/loop/schema.js";
import { InMemoryLoopStateStore } from "../src/loop/store.js";
import { DeepVerificationService, type VerificationGitPort } from "../src/loop/verification.js";
import { LoopWorkerService, queueTrustedRework } from "../src/loop/worker.js";
import {
  issueCandidate,
  loopConfig,
  loopNow,
  loopState,
  requiredValue,
} from "./support/loop-fixtures.js";

class WorkerGitHub implements GitHubLoopPort {
  ensureCalls = 0;
  readonly ensureInputs: EnsureDraftPullRequestInput[] = [];
  issue: IssueCandidate;
  reworkActor = "owner";
  reworkEvidence: ReworkAuthorizationEvidence | undefined;
  transitionFailures = 0;
  readonly transitions: IssueTransition[] = [];

  constructor(issue: IssueCandidate) {
    this.issue = issue;
  }

  getIssue(): Promise<IssueCandidate> {
    return Promise.resolve(structuredClone(this.issue));
  }

  listQueue(): Promise<readonly IssueCandidate[]> {
    return Promise.resolve([structuredClone(this.issue)]);
  }

  transitionIssue(transition: IssueTransition): Promise<"applied" | "duplicate"> {
    if (this.transitionFailures > 0) {
      this.transitionFailures -= 1;
      return Promise.reject(new Error("simulated-transition-failure"));
    }
    this.transitions.push(transition);
    if (this.issue.labels.includes(transition.to)) return Promise.resolve("duplicate");
    this.issue = {
      ...this.issue,
      labels: [...this.issue.labels.filter((label) => label !== transition.from), transition.to],
    };
    return Promise.resolve("applied");
  }

  ensureDraftPullRequest(input: EnsureDraftPullRequestInput): Promise<PullRequestSnapshot> {
    this.ensureCalls += 1;
    this.ensureInputs.push(input);
    return Promise.resolve({
      baseRef: "main",
      draft: true,
      headRef: "codex/42-implementation",
      headRepositoryOwner: "owner",
      headSha: "abcdef1234567",
      isCrossRepository: false,
      number: 88,
      state: "open",
      url: "https://github.com/owner/suno-automation/pull/88",
    });
  }

  getPullRequest(): Promise<PullRequestSnapshot> {
    return Promise.resolve({
      baseRef: "main",
      draft: true,
      headRef: "codex/42-implementation",
      headRepositoryOwner: "owner",
      headSha: "abcdef1234567",
      isCrossRepository: false,
      number: 88,
      state: "open",
      url: "https://github.com/owner/suno-automation/pull/88",
    });
  }

  getReworkAuthorization(): Promise<ReworkAuthorizationEvidence> {
    return Promise.resolve(
      this.reworkEvidence ?? {
        feedback: [
          {
            createdAt: "2026-07-23T11:30:00.000Z",
            id: "feedback-1",
            resolved: false,
          },
        ],
        headCommitAt: "2026-07-23T11:00:00.000Z",
        headSha: "abcdef1234567",
        requestActor: this.reworkActor,
        requestedAt: loopNow,
      },
    );
  }
}

function runningStore(): InMemoryLoopStateStore {
  const state = loopState();
  const ready = issueCandidate(42, { labels: ["codex-ready", "priority:p0"] });
  const candidate = requiredValue(analyzeCandidates([ready], state, ["owner"]).eligible[0]);
  const attempt = reserveAttempt(state, {
    attemptId: "attempt-42",
    candidate,
    leaseExpiresAt: "2026-07-23T14:00:00.000Z",
    now: loopNow,
    slotId: "worker-1",
  });
  attempt.stage = "running";
  attempt.threadId = "thread-42";
  state.slots[0].status = "running";
  return new InMemoryLoopStateStore(state);
}

function fakeGit(): {
  readonly park: ReturnType<typeof vi.fn>;
  readonly prepare: ReturnType<typeof vi.fn>;
  readonly port: WorkerGitPort;
} {
  const evidence = (attempt: AttemptRecord) => ({
    branchName: requiredValue(attempt.branchName),
    commitSha: "abcdef1234567",
  });
  const park = vi.fn(() => Promise.resolve());
  const prepare = vi.fn((...args: Parameters<WorkerGitPort["prepare"]>) =>
    Promise.resolve(evidence(args[2])),
  );
  const port: WorkerGitPort = {
    inspect: vi.fn(() => Promise.resolve({ safe: true })),
    park,
    prepare,
    publicationEvidence: vi.fn((...args: Parameters<WorkerGitPort["publicationEvidence"]>) =>
      Promise.resolve(evidence(args[1])),
    ),
    push: vi.fn((...args: Parameters<WorkerGitPort["push"]>) => Promise.resolve(evidence(args[1]))),
  };
  return { park, port, prepare };
}

async function advanceToPushed(
  config: ReturnType<typeof loopConfig>,
  store: InMemoryLoopStateStore,
  worker: LoopWorkerService,
): Promise<string> {
  await worker.prepare("attempt-42");
  await worker.checkpoint("attempt-42", "implemented");
  await worker.checkpoint("attempt-42", "committed", "abcdef1234567");
  const verifier = new DeepVerificationService(
    config,
    store,
    { run: vi.fn(() => Promise.resolve(1)) },
    {
      changedPaths: vi.fn(() => Promise.resolve(["docs/operations.md"])),
      commitSha: vi.fn(() => Promise.resolve("abcdef1234567")),
      diff: vi.fn(() => Promise.resolve("+safe\n")),
    } satisfies VerificationGitPort,
    () => new Date(loopNow),
  );
  const key = "a-strong-local-verification-key-12345";
  await verifier.verify({
    attemptId: "attempt-42",
    focusedPassed: true,
    key,
  });
  await worker.push("attempt-42", key);
  return key;
}

describe("Codex loop worker", () => {
  it("runs one attempt through the same branch to exactly one draft PR and releases capacity", async () => {
    const config = loopConfig();
    const store = runningStore();
    const github = new WorkerGitHub(
      issueCandidate(42, { labels: ["codex-in-progress", "priority:p0"] }),
    );
    const git = fakeGit();
    const worker = new LoopWorkerService(config, store, github, git.port, {
      now: () => new Date(loopNow),
    });

    const key = await advanceToPushed(config, store, worker);
    const finalized = await worker.finalizeReview("attempt-42", key);
    const duplicate = await worker.finalizeReview("attempt-42", key);

    expect(finalized.pullRequest?.number).toBe(88);
    expect(duplicate.stage).toBe("review");
    expect(github.ensureCalls).toBe(1);
    expect(github.ensureInputs[0]).toMatchObject({
      attemptId: "attempt-42",
      baseRef: "main",
      headRef: "codex/42-implementation",
      issueNumber: 42,
      title: "[#42] Automated issue implementation",
    });
    const pullRequestBody = requiredValue(github.ensureInputs[0]).body;
    expect(pullRequestBody).toContain("Closes #42.");
    expect(pullRequestBody).toContain("- focused: not-applicable");
    expect(pullRequestBody).toContain("- full-gate: pass");
    expect(pullRequestBody).toContain("- build: pass");
    expect(pullRequestBody).toContain("- config: not-applicable");
    expect(pullRequestBody).toContain("- mutation: not-applicable");
    expect(pullRequestBody).toContain("No live Suno access");
    expect(pullRequestBody).toContain("Attempt: `attempt-42`");
    expect(pullRequestBody).not.toContain("C:\\safe");
    expect(pullRequestBody).not.toContain("issues/42");
    expect(pullRequestBody).not.toMatch(/\b(?:gh[pousr]_|AIza|sk-)/);
    expect(github.transitions).toHaveLength(1);
    expect(github.transitions[0]).toMatchObject({
      from: "codex-in-progress",
      to: "codex-review",
    });
    expect((await store.read()).slots[0]).toEqual({ id: "worker-1", status: "free" });
    expect(git.park).toHaveBeenCalledOnce();
  });

  it("retries after a lost GitHub transition without duplicating branch, push, PR, or comment", async () => {
    const config = loopConfig();
    const store = runningStore();
    const github = new WorkerGitHub(
      issueCandidate(42, { labels: ["codex-in-progress", "priority:p0"] }),
    );
    const git = fakeGit();
    const worker = new LoopWorkerService(config, store, github, git.port, {
      now: () => new Date(loopNow),
    });
    const key = await advanceToPushed(config, store, worker);
    github.transitionFailures = 1;

    await expect(worker.finalizeReview("attempt-42", key)).rejects.toThrow(
      "simulated-transition-failure",
    );
    expect((await store.read()).attempts[0]?.stage).toBe("pr-linked");
    expect(git.park).not.toHaveBeenCalled();
    expect(github.ensureCalls).toBe(1);

    await expect(worker.finalizeReview("attempt-42", key)).resolves.toMatchObject({
      stage: "review",
    });
    expect(github.ensureCalls).toBe(1);
    expect(github.transitions).toHaveLength(1);
    expect(git.park).toHaveBeenCalledOnce();
  });

  it("resumes after park fails post-GitHub without a second transition or PR", async () => {
    const config = loopConfig();
    const store = runningStore();
    const github = new WorkerGitHub(
      issueCandidate(42, { labels: ["codex-in-progress", "priority:p0"] }),
    );
    const git = fakeGit();
    git.park.mockRejectedValueOnce(new Error("simulated-park-failure"));
    const worker = new LoopWorkerService(config, store, github, git.port, {
      now: () => new Date(loopNow),
    });
    const key = await advanceToPushed(config, store, worker);

    await expect(worker.finalizeReview("attempt-42", key)).rejects.toThrow(
      "simulated-park-failure",
    );
    const interrupted = await store.read();
    expect(interrupted.attempts[0]?.stage).toBe("pr-linked");
    expect(interrupted.slots[0].status).toBe("running");
    expect(interrupted.audit).toContainEqual(
      expect.objectContaining({
        attemptId: "attempt-42",
        eventId: "review-attempt-42",
        result: "pending",
        stage: "pr-linked",
      }),
    );
    expect(github.issue.labels).toContain("codex-review");
    expect(github.ensureCalls).toBe(1);
    expect(github.transitions).toHaveLength(1);

    await expect(worker.finalizeReview("attempt-42", key)).resolves.toMatchObject({
      stage: "review",
    });
    expect(github.ensureCalls).toBe(1);
    expect(github.transitions).toHaveLength(1);
    expect(git.park).toHaveBeenCalledTimes(2);
    const completed = await store.read();
    expect(completed.slots[0]).toEqual({ id: "worker-1", status: "free" });
    expect(completed.audit).toContainEqual(
      expect.objectContaining({
        attemptId: "attempt-42",
        eventId: "review-attempt-42",
        result: "success",
        stage: "review",
      }),
    );
  });

  it("rejects publication when persisted commit diverges from the signed verdict", async () => {
    const config = loopConfig();
    const store = runningStore();
    const github = new WorkerGitHub(
      issueCandidate(42, { labels: ["codex-in-progress", "priority:p0"] }),
    );
    const worker = new LoopWorkerService(config, store, github, fakeGit().port, {
      now: () => new Date(loopNow),
    });
    await advanceToPushed(config, store, worker);
    await expect(
      store.update((state) => {
        const attempt = state.attempts[0];
        if (attempt === undefined) throw new Error("fixture-attempt-missing");
        attempt.commitSha = "deadbee1234567";
      }),
    ).rejects.toThrow("Verification evidence must be bound");
    expect(github.ensureCalls).toBe(0);
  });

  it("persists attention before lifecycle mutation and then releases the slot", async () => {
    const store = runningStore();
    const github = new WorkerGitHub(
      issueCandidate(42, { labels: ["codex-in-progress", "priority:p0"] }),
    );
    const worker = new LoopWorkerService(loopConfig(), store, github, fakeGit().port, {
      now: () => new Date(loopNow),
    });

    const result = await worker.finalizeAttention("attempt-42", "validation-failed");

    expect(result).toMatchObject({
      errorCode: "validation-failed",
      stage: "attention",
    });
    expect(github.transitions[0]).toMatchObject({ to: "codex-needs-attention" });
    expect((await store.read()).slots[0].status).toBe("free");
  });

  it("fails closed before git preparation for an expired lease or invalid live issue", async () => {
    const cases = [
      {
        name: "expired lease",
        mutate: async (store: InMemoryLoopStateStore, github: WorkerGitHub) => {
          await store.update((state) => {
            const current = requiredValue(state.attempts[0]);
            current.leaseExpiresAt = "2026-07-23T11:00:00.000Z";
            const slot = requiredValue(
              state.slots.find((candidate) => candidate.id === current.slotId),
            );
            if (slot.status === "running") slot.leaseExpiresAt = current.leaseExpiresAt;
          });
          return github;
        },
        error: "lease-expired",
      },
      {
        name: "closed issue",
        mutate: (_store: InMemoryLoopStateStore, github: WorkerGitHub) => {
          github.issue = { ...github.issue, state: "closed" };
          return Promise.resolve(github);
        },
        error: "issue-revalidation-failed",
      },
      {
        name: "blocked dependency",
        mutate: (_store: InMemoryLoopStateStore, github: WorkerGitHub) => {
          github.issue = {
            ...github.issue,
            dependencies: [{ number: 9, state: "open" }],
          };
          return Promise.resolve(github);
        },
        error: "issue-revalidation-failed",
      },
      {
        name: "unexpected existing pull request",
        mutate: (_store: InMemoryLoopStateStore, github: WorkerGitHub) => {
          github.issue = {
            ...github.issue,
            linkedPullRequest: {
              baseRef: "main",
              draft: true,
              headRef: "codex/42-implementation",
              headRepositoryOwner: "owner",
              headSha: "abcdef1234567",
              isCrossRepository: false,
              number: 88,
              state: "open",
              url: "https://github.com/owner/suno-automation/pull/88",
            },
          };
          return Promise.resolve(github);
        },
        error: "unexpected-linked-pull-request",
      },
    ] as const;

    for (const testCase of cases) {
      const store = runningStore();
      const github = new WorkerGitHub(
        issueCandidate(42, { labels: ["codex-in-progress", "priority:p0"] }),
      );
      const git = fakeGit();
      await testCase.mutate(store, github);
      const worker = new LoopWorkerService(loopConfig(), store, github, git.port, {
        now: () => new Date(loopNow),
      });

      await expect(worker.prepare("attempt-42"), testCase.name).rejects.toThrow(testCase.error);
      expect(git.prepare, testCase.name).not.toHaveBeenCalled();
      expect((await store.read()).attempts[0]?.stage, testCase.name).toBe("running");
    }
  });

  it("makes worker checkpoints restart-safe but rejects divergent or skipped durable stages", async () => {
    const store = runningStore();
    const github = new WorkerGitHub(
      issueCandidate(42, { labels: ["codex-in-progress", "priority:p0"] }),
    );
    const worker = new LoopWorkerService(loopConfig(), store, github, fakeGit().port, {
      now: () => new Date(loopNow),
    });

    await expect(worker.checkpoint("attempt-42", "implemented")).rejects.toThrow(
      "invalid-worker-stage",
    );
    await worker.prepare("attempt-42");
    await worker.checkpoint("attempt-42", "implemented");
    await expect(worker.checkpoint("attempt-42", "committed")).rejects.toThrow(
      "commit-sha-required",
    );
    await worker.checkpoint("attempt-42", "committed", "abcdef1234567");
    await expect(worker.checkpoint("attempt-42", "committed", "deadbee1234567")).rejects.toThrow(
      "commit-sha-conflict",
    );
    await expect(worker.checkpoint("attempt-42", "implemented")).resolves.toMatchObject({
      stage: "committed",
      commitSha: "abcdef1234567",
    });
  });

  it("does not push a verified verdict when git reports a different commit", async () => {
    const config = loopConfig();
    const store = runningStore();
    const github = new WorkerGitHub(
      issueCandidate(42, { labels: ["codex-in-progress", "priority:p0"] }),
    );
    const git = fakeGit();
    const worker = new LoopWorkerService(config, store, github, git.port, {
      now: () => new Date(loopNow),
    });
    await worker.prepare("attempt-42");
    await worker.checkpoint("attempt-42", "implemented");
    await worker.checkpoint("attempt-42", "committed", "abcdef1234567");
    const verifier = new DeepVerificationService(
      config,
      store,
      { run: vi.fn(() => Promise.resolve(1)) },
      {
        changedPaths: vi.fn(() => Promise.resolve(["docs/operations.md"])),
        commitSha: vi.fn(() => Promise.resolve("abcdef1234567")),
        diff: vi.fn(() => Promise.resolve("+safe\n")),
      } satisfies VerificationGitPort,
      () => new Date(loopNow),
    );
    const key = "a-strong-local-verification-key-12345";
    await verifier.verify({ attemptId: "attempt-42", focusedPassed: true, key });
    git.port.push = vi.fn(() =>
      Promise.resolve({ branchName: "codex/42-implementation", commitSha: "deadbee1234567" }),
    );

    await expect(worker.push("attempt-42", key)).rejects.toThrow("pushed-commit-mismatch");
    expect((await store.read()).attempts[0]?.stage).toBe("verified");
  });

  it("resumes a prepared worker after restart without repeating repository preparation", async () => {
    const store = runningStore();
    const github = new WorkerGitHub(
      issueCandidate(42, { labels: ["codex-in-progress", "priority:p0"] }),
    );
    const git = fakeGit();
    const worker = new LoopWorkerService(loopConfig(), store, github, git.port, {
      now: () => new Date(loopNow),
    });

    await worker.prepare("attempt-42");
    const resumed = await worker.prepare("attempt-42");

    expect(resumed.stage).toBe("prepared");
    expect(git.prepare).toHaveBeenCalledTimes(1);
  });

  it("keeps capacity held when attention lifecycle delivery is ambiguous, then releases once", async () => {
    const store = runningStore();
    const github = new WorkerGitHub(
      issueCandidate(42, { labels: ["codex-in-progress", "priority:p0"] }),
    );
    github.transitionFailures = 1;
    const worker = new LoopWorkerService(loopConfig(), store, github, fakeGit().port, {
      now: () => new Date(loopNow),
    });

    await expect(worker.finalizeAttention("attempt-42", "verification-failed")).rejects.toThrow(
      "simulated-transition-failure",
    );
    expect((await store.read()).slots[0]).toMatchObject({
      attemptId: "attempt-42",
      status: "attention",
    });

    await expect(
      worker.finalizeAttention("attempt-42", "verification-failed"),
    ).resolves.toMatchObject({
      stage: "attention",
    });
    expect((await store.read()).slots[0]).toEqual({ id: "worker-1", status: "free" });
    await expect(worker.finalizeAttention("attempt-42", "other-safe-code")).rejects.toThrow(
      "attention-error-conflict",
    );
  });

  it("rejects a linked review PR whose branch, owner, base, or head no longer proves this attempt", async () => {
    const variants = [
      { name: "base", mutate: (pr: PullRequestSnapshot) => ({ ...pr, baseRef: "release" }) },
      {
        name: "cross repository",
        mutate: (pr: PullRequestSnapshot) => ({ ...pr, isCrossRepository: true }),
      },
      {
        name: "head sha",
        mutate: (pr: PullRequestSnapshot) => ({ ...pr, headSha: "deadbee1234567" }),
      },
      {
        name: "owner",
        mutate: (pr: PullRequestSnapshot) => ({ ...pr, headRepositoryOwner: "other" }),
      },
    ];
    for (const variant of variants) {
      const config = loopConfig();
      const store = runningStore();
      const github = new WorkerGitHub(
        issueCandidate(42, { labels: ["codex-in-progress", "priority:p0"] }),
      );
      const worker = new LoopWorkerService(config, store, github, fakeGit().port, {
        now: () => new Date(loopNow),
      });
      const key = await advanceToPushed(config, store, worker);
      await store.update((state) => {
        const current = requiredValue(state.attempts[0]);
        current.stage = "pr-linked";
        current.pullRequest = { draft: true, number: 88, url: "https://github.com/owner/pull/88" };
      });
      const original = github.getPullRequest.bind(github);
      github.getPullRequest = () => original().then(variant.mutate);

      await expect(worker.finalizeReview("attempt-42", key), variant.name).rejects.toThrow(
        "pull-request-identity-conflict",
      );
      expect((await store.read()).attempts[0]?.stage, variant.name).toBe("pr-linked");
    }
  });

  it("accepts only allowlisted unambiguous rework and preserves the existing PR", async () => {
    const store = new InMemoryLoopStateStore();
    const github = new WorkerGitHub(
      issueCandidate(42, {
        labels: ["codex-review", "priority:p0"],
        linkedPullRequest: {
          baseRef: "main",
          draft: true,
          headRef: "codex/42-implementation",
          headRepositoryOwner: "owner",
          headSha: "abcdef1234567",
          isCrossRepository: false,
          number: 88,
          state: "open",
          url: "https://github.com/owner/suno-automation/pull/88",
        },
      }),
    );

    github.reworkActor = "intruder";
    await expect(
      queueTrustedRework(loopConfig(), store, github, {
        approvedFeedbackIds: ["feedback-1"],
        baseCommit: "abcdef1234567",
        eventId: "rework-untrusted",
        issueNumber: 42,
        prNumber: 88,
      }),
    ).rejects.toThrow("untrusted-rework-actor");
    expect((await store.read()).reworkRequests).toHaveLength(0);

    github.reworkActor = "owner";
    const request = await queueTrustedRework(loopConfig(), store, github, {
      approvedFeedbackIds: ["feedback-1"],
      baseCommit: "abcdef1234567",
      eventId: "rework-1",
      issueNumber: 42,
      prNumber: 88,
    });
    const duplicate = await queueTrustedRework(loopConfig(), store, github, {
      approvedFeedbackIds: ["feedback-1"],
      baseCommit: "abcdef1234567",
      eventId: "rework-1",
      issueNumber: 42,
      prNumber: 88,
    });

    expect(request).toMatchObject({ prNumber: 88, status: "queued" });
    expect(duplicate).toEqual(request);
    expect((await store.read()).reworkRequests).toHaveLength(1);
    expect(github.transitions.at(-1)).toMatchObject({
      from: "codex-review",
      to: "codex-rework",
    });
    expect((await store.read()).reworkAudit).toEqual([
      {
        at: loopNow,
        eventId: "rework-untrusted",
        issueNumber: 42,
        result: "rejected",
        safeReason: "untrusted-rework-actor",
      },
      {
        at: loopNow,
        eventId: "rework-1",
        issueNumber: 42,
        result: "queued",
      },
    ]);
  });

  it("rejects a rework whose live PR head no longer matches the approved base before git prepare", async () => {
    const state = loopState();
    state.reworkRequests.push({
      approvedFeedbackIds: ["feedback-1"],
      baseCommit: "abcdef1234567",
      eventId: "rework-1",
      issueNumber: 42,
      prNumber: 88,
      requestedAt: loopNow,
      requestedBy: "owner",
      status: "queued",
    });
    const issue = issueCandidate(42, {
      labels: ["codex-rework", "priority:p0"],
      linkedPullRequest: {
        baseRef: "main",
        draft: true,
        headRef: "codex/42-implementation",
        headRepositoryOwner: "owner",
        headSha: "abcdef1234567",
        isCrossRepository: false,
        number: 88,
        state: "open",
        url: "https://github.com/owner/suno-automation/pull/88",
      },
    });
    const candidate = requiredValue(analyzeCandidates([issue], state, ["owner"]).eligible[0]);
    const attempt = reserveAttempt(state, {
      attemptId: "rework-attempt",
      candidate,
      leaseExpiresAt: "2026-07-23T14:00:00.000Z",
      now: loopNow,
      slotId: "worker-1",
    });
    attempt.stage = "running";
    state.slots[0].status = "running";
    const github = new WorkerGitHub({
      ...issue,
      labels: ["codex-in-progress", "priority:p0"],
      linkedPullRequest: { ...requiredValue(issue.linkedPullRequest), headSha: "deadbee1234567" },
    });
    const git = fakeGit();
    const worker = new LoopWorkerService(
      loopConfig(),
      new InMemoryLoopStateStore(state),
      github,
      git.port,
      { now: () => new Date(loopNow) },
    );

    await expect(worker.prepare("rework-attempt")).rejects.toThrow("rework-pull-request-conflict");
    expect(git.prepare).not.toHaveBeenCalled();
  });

  it("rejects resolved or stale feedback to attention without storing review bodies", async () => {
    const store = new InMemoryLoopStateStore();
    const github = new WorkerGitHub(
      issueCandidate(42, {
        labels: ["codex-review", "priority:p0"],
        linkedPullRequest: {
          baseRef: "main",
          draft: true,
          headRef: "codex/42-implementation",
          headRepositoryOwner: "owner",
          headSha: "abcdef1234567",
          isCrossRepository: false,
          number: 88,
          state: "open",
          url: "https://github.com/owner/suno-automation/pull/88",
        },
      }),
    );
    github.reworkEvidence = {
      feedback: [
        {
          createdAt: "2026-07-23T10:00:00.000Z",
          id: "feedback-1",
          resolved: true,
        },
      ],
      headCommitAt: "2026-07-23T11:00:00.000Z",
      headSha: "abcdef1234567",
      requestActor: "owner",
      requestedAt: loopNow,
    };

    await expect(
      queueTrustedRework(loopConfig(), store, github, {
        approvedFeedbackIds: ["feedback-1"],
        baseCommit: "abcdef1234567",
        eventId: "rework-resolved",
        issueNumber: 42,
        prNumber: 88,
      }),
    ).rejects.toThrow("rework-feedback-conflict");

    const state = await store.read();
    expect(state.reworkRequests).toHaveLength(0);
    expect(state.reworkAudit).toEqual([
      {
        at: loopNow,
        eventId: "rework-resolved",
        issueNumber: 42,
        result: "rejected",
        safeReason: "rework-feedback-conflict",
      },
    ]);
    expect(github.transitions[0]).toMatchObject({ to: "codex-needs-attention" });
  });

  it("keeps the three-rework cap after attempt retention has removed old attempts", async () => {
    const store = new InMemoryLoopStateStore({
      ...loopState(),
      reworkAudit: [1, 2, 3].map((index) => ({
        at: `2026-07-2${index.toString()}T12:00:00.000Z`,
        eventId: `prior-rework-${index.toString()}`,
        issueNumber: 42,
        result: "queued" as const,
      })),
    });
    const github = new WorkerGitHub(
      issueCandidate(42, {
        labels: ["codex-review", "priority:p0"],
        linkedPullRequest: {
          baseRef: "main",
          draft: true,
          headRef: "codex/42-implementation",
          headRepositoryOwner: "owner",
          headSha: "abcdef1234567",
          isCrossRepository: false,
          number: 88,
          state: "open",
          url: "https://github.com/owner/suno-automation/pull/88",
        },
      }),
    );

    await expect(
      queueTrustedRework(loopConfig(), store, github, {
        approvedFeedbackIds: ["feedback-1"],
        baseCommit: "abcdef1234567",
        eventId: "fourth-rework",
        issueNumber: 42,
        prNumber: 88,
      }),
    ).rejects.toThrow("rework-attempt-limit");
    expect(github.transitions.at(-1)).toMatchObject({ to: "codex-needs-attention" });
  });

  it("rejects replayed rework identifiers when their immutable authorization payload differs", async () => {
    const store = new InMemoryLoopStateStore({
      ...loopState(),
      reworkRequests: [
        {
          approvedFeedbackIds: ["feedback-1"],
          baseCommit: "abcdef1234567",
          eventId: "rework-1",
          issueNumber: 42,
          prNumber: 88,
          requestedAt: loopNow,
          requestedBy: "owner",
          status: "queued",
        },
      ],
    });
    const github = new WorkerGitHub(
      issueCandidate(42, { labels: ["codex-review", "priority:p0"] }),
    );
    const variants = [
      { baseCommit: "deadbee1234567", issueNumber: 42, prNumber: 88 },
      { baseCommit: "abcdef1234567", issueNumber: 43, prNumber: 88 },
      { baseCommit: "abcdef1234567", issueNumber: 42, prNumber: 89 },
      { baseCommit: "abcdef1234567", issueNumber: 42, prNumber: 88, feedback: ["other"] },
    ];
    for (const variant of variants) {
      await expect(
        queueTrustedRework(loopConfig(), store, github, {
          approvedFeedbackIds: variant.feedback ?? ["feedback-1"],
          baseCommit: variant.baseCommit,
          eventId: "rework-1",
          issueNumber: variant.issueNumber,
          prNumber: variant.prNumber,
        }),
      ).rejects.toThrow("rework-event-conflict");
    }
    expect(github.transitions).toHaveLength(0);
  });

  it("requires explicit GitHub rework evidence and unique requested feedback ids", async () => {
    const noEvidencePort = {
      ensureDraftPullRequest: vi.fn(),
      getIssue: vi.fn(),
      getPullRequest: vi.fn(),
      listQueue: vi.fn(),
      transitionIssue: vi.fn(),
    } as unknown as GitHubLoopPort;
    const input = {
      approvedFeedbackIds: ["feedback-1"],
      baseCommit: "abcdef1234567",
      eventId: "rework-no-evidence",
      issueNumber: 42,
      prNumber: 88,
    };
    await expect(
      queueTrustedRework(loopConfig(), new InMemoryLoopStateStore(), noEvidencePort, input),
    ).rejects.toThrow("rework-evidence-port-unavailable");

    const github = new WorkerGitHub(
      issueCandidate(42, { labels: ["codex-review", "priority:p0"] }),
    );
    await expect(
      queueTrustedRework(loopConfig(), new InMemoryLoopStateStore(), github, {
        ...input,
        approvedFeedbackIds: ["feedback-1", "feedback-1"],
      }),
    ).rejects.toThrow("duplicate-feedback-id");
  });
});
