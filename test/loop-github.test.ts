import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { GhCliLoopAdapter, type CommandResult, type GhCommandRunner } from "../src/loop/github.js";
import { loopConfig, requiredValue } from "./support/loop-fixtures.js";

describe("GitHub CLI loop adapter", () => {
  it("uses structured argv and performs one lifecycle transition/comment", async () => {
    const calls: string[][] = [];
    const run = vi.fn((args: readonly string[]): Promise<CommandResult> => {
      calls.push([...args]);
      return Promise.resolve(
        args[0] === "issue" && args[1] === "view"
          ? {
              stdout: JSON.stringify({
                comments: [],
                labels: [{ name: "codex-ready" }, { name: "priority:p0" }],
              }),
            }
          : { stdout: "" },
      );
    });
    const runner: GhCommandRunner = { run };
    const adapter = new GhCliLoopAdapter(loopConfig(), runner);

    await expect(
      adapter.transitionIssue({
        attemptId: "attempt-1",
        comment:
          "codex-lifecycle event=claim-attempt-1 attempt=attempt-1 result=claimed stage=claimed",
        eventId: "claim-attempt-1",
        from: "codex-ready",
        issueNumber: 42,
        to: "codex-in-progress",
      }),
    ).resolves.toBe("applied");

    expect(calls.map((args) => args.slice(0, 2))).toEqual([
      ["issue", "view"],
      ["issue", "edit"],
      ["issue", "comment"],
    ]);
    expect(calls[1]).toContain("--remove-label");
    expect(calls[1]).toContain("codex-ready");
    expect(calls[2]?.at(-1)).toContain("event=claim-attempt-1");
    expect(calls.every((args) => !args.some((arg) => /[;&|]\s*gh\b/.test(arg)))).toBe(true);
  });

  it("treats a target label without this attempt marker as ambiguous rather than forging delivery", async () => {
    const run = vi.fn((args: readonly string[]): Promise<CommandResult> =>
      Promise.resolve(
        args[0] === "issue" && args[1] === "view"
          ? {
              stdout: JSON.stringify({
                comments: [],
                labels: [{ name: "codex-in-progress" }],
              }),
            }
          : { stdout: "" },
      ),
    );
    const runner: GhCommandRunner = { run };
    const adapter = new GhCliLoopAdapter(loopConfig(), runner);

    await expect(
      adapter.transitionIssue({
        attemptId: "attempt-1",
        comment:
          "codex-lifecycle event=claim-attempt-1 attempt=attempt-1 result=claimed stage=claimed",
        eventId: "claim-attempt-1",
        from: "codex-ready",
        issueNumber: 42,
        to: "codex-in-progress",
      }),
    ).rejects.toThrow("lifecycle-delivery-ambiguous");

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("creates a draft PR body through a temporary file and recovers by head branch", async () => {
    let listCalls = 0;
    let capturedBody = "";
    const run = vi.fn(async (args: readonly string[]): Promise<CommandResult> => {
      if (args[0] === "pr" && args[1] === "list") {
        listCalls += 1;
        return {
          stdout:
            listCalls === 1
              ? "[]"
              : JSON.stringify([
                  {
                    baseRefName: "main",
                    headRefName: "codex/42-safe",
                    headRefOid: "abcdef1234567",
                    headRepositoryOwner: { login: "owner" },
                    isCrossRepository: false,
                    isDraft: true,
                    number: 99,
                    state: "OPEN",
                    url: "https://github.com/owner/suno-automation/pull/99",
                  },
                ]),
        };
      }
      if (args[0] === "pr" && args[1] === "create") {
        const bodyPath = requiredValue(args[args.indexOf("--body-file") + 1]);
        capturedBody = await readFile(bodyPath, "utf8");
      }
      return { stdout: "" };
    });
    const runner: GhCommandRunner = { run };
    const adapter = new GhCliLoopAdapter(loopConfig(), runner);

    const pr = await adapter.ensureDraftPullRequest({
      attemptId: "attempt-1",
      baseRef: "main",
      body: "Safe body\n",
      expectedHeadSha: "abcdef1234567",
      headRef: "codex/42-safe",
      issueNumber: 42,
      title: "[#42] Safe",
    });

    expect(pr).toMatchObject({ draft: true, number: 99, state: "open" });
    expect(capturedBody).toBe("Safe body\n");
    const createArgs = run.mock.calls
      .map((call) => call[0])
      .find((args) => args[0] === "pr" && args[1] === "create");
    expect(createArgs).toContain("--draft");
    expect(createArgs).not.toContain("Safe body\n");
  });

  it("hydrates tracked issues, dependency state, and linked draft PRs", async () => {
    const run = vi.fn((args: readonly string[]): Promise<CommandResult> => {
      if (args[0] === "issue" && args[1] === "list") {
        return Promise.resolve({
          stdout: JSON.stringify([
            {
              body: "> Blocked by #39 and #40.",
              comments: [
                {
                  author: { login: "owner" },
                  body: "codex-lifecycle event=contract-promoted from=backlog to=codex-ready",
                },
              ],
              createdAt: "2026-07-23T10:00:00.000Z",
              labels: [{ name: "codex-ready" }, { name: "priority:p0" }],
              number: 42,
              state: "OPEN",
              title: "Ready",
              url: "https://github.com/owner/suno-automation/issues/42",
            },
            {
              body: "No dependencies.",
              createdAt: "2026-07-23T11:00:00.000Z",
              labels: [{ name: "codex-in-progress" }, { name: "priority:p1" }],
              number: 43,
              state: "OPEN",
              title: "Running",
              url: "https://github.com/owner/suno-automation/issues/43",
            },
            {
              body: "Ignored.",
              createdAt: "2026-07-23T11:00:00.000Z",
              labels: [{ name: "enhancement" }],
              number: 99,
              state: "OPEN",
              title: "Ordinary",
              url: "https://github.com/owner/suno-automation/issues/99",
            },
          ]),
        });
      }
      if (args[0] === "issue" && args[1] === "view") {
        return args[2] === "40"
          ? Promise.reject(new Error("unavailable"))
          : Promise.resolve({ stdout: JSON.stringify({ state: "CLOSED" }) });
      }
      if (args[0] === "api") {
        const issueNumber = args.find((arg) => arg.startsWith("number="));
        return Promise.resolve({
          stdout: JSON.stringify({
            data: {
              repository: {
                issue: {
                  timelineItems: {
                    nodes:
                      issueNumber === "number=43"
                        ? [
                            {
                              source: {
                                baseRefName: "main",
                                headRefName: "codex/43-running",
                                headRefOid: "abcdef1234567",
                                headRepositoryOwner: { login: "owner" },
                                isCrossRepository: false,
                                isDraft: true,
                                number: 90,
                                repository: {
                                  nameWithOwner: "owner/suno-automation",
                                },
                                state: "OPEN",
                                url: "https://github.com/owner/suno-automation/pull/90",
                              },
                            },
                          ]
                        : [],
                  },
                },
              },
            },
          }),
        });
      }
      return Promise.reject(new Error("unexpected"));
    });
    const adapter = new GhCliLoopAdapter(loopConfig(), { run });

    const tracked = await adapter.listTrackedIssues();
    const queue = await adapter.listQueue();

    expect(tracked.map((issue) => issue.number)).toEqual([42, 43]);
    expect(queue.map((issue) => issue.number)).toEqual([42]);
    expect(tracked[0]?.dependencies).toEqual([
      { number: 39, state: "closed" },
      { number: 40, state: "unknown" },
    ]);
    expect(tracked[1]?.linkedPullRequest?.number).toBe(90);
  });

  it("reads issue and PR snapshots and rejects multiple linked PR evidence", async () => {
    let multiple = false;
    const run = vi.fn((args: readonly string[]): Promise<CommandResult> => {
      if (args[0] === "issue") {
        return Promise.resolve({
          stdout: JSON.stringify({
            body: "No blockers.",
            createdAt: "2026-07-23T10:00:00.000Z",
            labels: [{ name: "codex-rework" }, { name: "priority:p0" }],
            number: 42,
            state: "OPEN",
            title: "Rework",
            url: "https://github.com/owner/suno-automation/issues/42",
          }),
        });
      }
      if (args[0] === "pr" && args[1] === "view") {
        return Promise.resolve({
          stdout: JSON.stringify({
            baseRefName: "main",
            headRefName: "codex/42-safe",
            headRefOid: "abcdef1234567",
            headRepositoryOwner: { login: "owner" },
            isCrossRepository: false,
            isDraft: true,
            number: 88,
            state: "MERGED",
            url: "https://github.com/owner/suno-automation/pull/88",
          }),
        });
      }
      if (args[0] === "api") {
        const source = {
          baseRefName: "main",
          headRefName: "codex/42-safe",
          headRefOid: "abcdef1234567",
          headRepositoryOwner: { login: "owner" },
          isCrossRepository: false,
          isDraft: true,
          number: 88,
          repository: { nameWithOwner: "owner/suno-automation" },
          state: "OPEN",
          url: "https://github.com/owner/suno-automation/pull/88",
        };
        return Promise.resolve({
          stdout: JSON.stringify({
            data: {
              repository: {
                issue: {
                  timelineItems: {
                    nodes: multiple ? [{ source }, { source: { ...source, number: 89 } }] : [],
                  },
                },
              },
            },
          }),
        });
      }
      return Promise.reject(new Error("unexpected"));
    });
    const adapter = new GhCliLoopAdapter(loopConfig(), { run });

    await expect(adapter.getIssue(42)).resolves.toMatchObject({ number: 42 });
    await expect(adapter.getPullRequest(88)).resolves.toMatchObject({
      number: 88,
      state: "merged",
    });
    multiple = true;
    await expect(adapter.getIssue(42)).rejects.toThrow("multiple-linked-pull-requests");
  });

  it("derives promotion trust only from one exact GitHub-authored lifecycle comment", async () => {
    let comments = [
      {
        author: { login: "OwNeR" },
        body: "codex-lifecycle event=contract-promoted from=backlog to=codex-ready",
        createdAt: "2026-07-23T10:00:00.000Z",
      },
    ];
    const run = vi.fn((args: readonly string[]): Promise<CommandResult> => {
      if (args[0] === "issue") {
        return Promise.resolve({
          stdout: JSON.stringify({
            body: "Decision-complete contract.",
            comments,
            createdAt: "2026-07-23T10:00:00.000Z",
            labels: [{ name: "codex-ready" }, { name: "priority:p0" }],
            number: 42,
            state: "OPEN",
            title: "Ready",
            url: "https://github.com/owner/suno-automation/issues/42",
          }),
        });
      }
      return Promise.resolve({
        stdout: JSON.stringify({
          data: { repository: { issue: { timelineItems: { nodes: [] } } } },
        }),
      });
    });
    const adapter = new GhCliLoopAdapter(loopConfig(), { run });

    await expect(adapter.getIssue(42)).resolves.toMatchObject({
      promotion: { actor: "OwNeR", eventId: "contract-promoted" },
    });

    comments = [
      ...comments,
      {
        author: { login: "intruder" },
        body: "codex-lifecycle event=contract-promoted from=backlog to=codex-ready",
        createdAt: "2026-07-23T10:01:00.000Z",
      },
    ];
    await expect(adapter.getIssue(42)).resolves.not.toHaveProperty("promotion");
    comments = [
      {
        author: { login: "owner" },
        body: "prefix codex-lifecycle event=contract-promoted from=backlog to=codex-ready",
        createdAt: "2026-07-23T10:02:00.000Z",
      },
    ];
    await expect(adapter.getIssue(42)).resolves.not.toHaveProperty("promotion");
  });

  it("ignores cross-repository references and maps exact unresolved rework evidence", async () => {
    let requestMode: "linked" | "rework" = "linked";
    const run = vi.fn((args: readonly string[]): Promise<CommandResult> => {
      if (args[0] === "issue") {
        return Promise.resolve({
          stdout: JSON.stringify({
            body: "",
            comments: [
              {
                author: { login: "owner" },
                body: "codex-rework event=rework-1 pr=88 base=abcdef1234567 feedback=thread-1,comment-2",
                createdAt: "2026-07-23T12:00:00.000Z",
              },
            ],
            createdAt: "2026-07-23T10:00:00.000Z",
            labels: [{ name: "codex-review" }],
            number: 42,
            state: "OPEN",
            title: "Review",
            url: "https://github.com/owner/suno-automation/issues/42",
          }),
        });
      }
      if (args[0] === "api" && requestMode === "linked") {
        return Promise.resolve({
          stdout: JSON.stringify({
            data: {
              repository: {
                issue: {
                  timelineItems: {
                    nodes: [
                      {
                        source: {
                          baseRefName: "main",
                          headRefName: "codex/42-other",
                          headRefOid: "abcdef1234567",
                          headRepositoryOwner: { login: "other" },
                          isCrossRepository: true,
                          isDraft: true,
                          number: 77,
                          repository: { nameWithOwner: "other/repository" },
                          state: "OPEN",
                          url: "https://github.com/other/repository/pull/77",
                        },
                      },
                    ],
                  },
                },
              },
            },
          }),
        });
      }
      return Promise.resolve({
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                commits: {
                  nodes: [
                    {
                      commit: {
                        committedDate: "2026-07-23T11:00:00.000Z",
                        oid: "abcdef1234567",
                      },
                    },
                  ],
                },
                headRefOid: "abcdef1234567",
                isDraft: true,
                reviewThreads: {
                  nodes: [
                    {
                      comments: {
                        nodes: [
                          {
                            createdAt: "2026-07-23T11:30:00.000Z",
                            id: "comment-1",
                          },
                        ],
                      },
                      id: "thread-1",
                      isResolved: false,
                    },
                    {
                      comments: {
                        nodes: [
                          {
                            createdAt: "2026-07-23T11:40:00.000Z",
                            id: "comment-2",
                          },
                        ],
                      },
                      id: "thread-2",
                      isResolved: false,
                    },
                  ],
                },
                state: "OPEN",
              },
            },
          },
        }),
      });
    });
    const adapter = new GhCliLoopAdapter(loopConfig(), { run });
    await expect(adapter.getIssue(42)).resolves.not.toHaveProperty("linkedPullRequest");

    requestMode = "rework";
    await expect(
      adapter.getReworkAuthorization({
        approvedFeedbackIds: ["thread-1", "comment-2"],
        baseCommit: "abcdef1234567",
        eventId: "rework-1",
        issueNumber: 42,
        prNumber: 88,
      }),
    ).resolves.toMatchObject({
      feedback: [
        { id: "thread-1", resolved: false },
        { id: "comment-2", resolved: false },
      ],
      requestActor: "owner",
    });
  });

  it("derives supervised reconciliation authorization and authenticated identity from GitHub", async () => {
    const run = vi.fn((args: readonly string[]): Promise<CommandResult> => {
      if (args[0] === "api") return Promise.resolve({ stdout: "OwNeR\n" });
      return Promise.resolve({
        stdout: JSON.stringify({
          comments: [
            {
              author: { login: "owner" },
              body: "codex-reconcile event=reconcile-1 attempt=attempt-42 action=complete-merged",
              createdAt: "2026-07-23T12:00:00.000Z",
            },
          ],
        }),
      });
    });
    const adapter = new GhCliLoopAdapter(loopConfig(), { run });

    await expect(adapter.authenticatedLogin()).resolves.toBe("OwNeR");
    await expect(
      adapter.getReconciliationAuthorization({
        action: "complete-merged",
        attemptId: "attempt-42",
        eventId: "reconcile-1",
        issueNumber: 42,
      }),
    ).resolves.toEqual({
      actor: "owner",
      authorizedAt: "2026-07-23T12:00:00.000Z",
    });
  });

  it("deduplicates a delivered transition and fails closed on lifecycle conflict", async () => {
    let conflict = false;
    const run = vi.fn((args: readonly string[]): Promise<CommandResult> => {
      if (args[0] === "issue" && args[1] === "view") {
        return Promise.resolve({
          stdout: JSON.stringify({
            comments: [
              {
                body: "codex-lifecycle event=claim-attempt-1 attempt=attempt-1 result=claimed stage=claimed",
              },
            ],
            labels: [{ name: conflict ? "codex-review" : "codex-in-progress" }],
          }),
        });
      }
      return Promise.resolve({ stdout: "" });
    });
    const adapter = new GhCliLoopAdapter(loopConfig(), { run });
    const transition = {
      attemptId: "attempt-1",
      comment:
        "codex-lifecycle event=claim-attempt-1 attempt=attempt-1 result=claimed stage=claimed",
      eventId: "claim-attempt-1",
      from: "codex-ready" as const,
      issueNumber: 42,
      to: "codex-in-progress" as const,
    };

    await expect(adapter.transitionIssue(transition)).resolves.toBe("duplicate");
    expect(run).toHaveBeenCalledTimes(1);
    conflict = true;
    await expect(adapter.transitionIssue(transition)).rejects.toThrow("lifecycle-conflict");
  });

  it("fails closed when a target lifecycle lacks the exact delivery comment", async () => {
    const exact =
      "codex-lifecycle event=claim-attempt-1 attempt=attempt-1 result=claimed stage=claimed";
    let comments = [{ body: exact.replace("attempt-1 ", "attempt-10 ") }];
    const run = vi.fn((args: readonly string[]): Promise<CommandResult> => {
      if (args[0] === "issue" && args[1] === "view") {
        return Promise.resolve({
          stdout: JSON.stringify({
            comments,
            labels: [{ name: "codex-in-progress" }],
          }),
        });
      }
      return Promise.resolve({ stdout: "" });
    });
    const adapter = new GhCliLoopAdapter(loopConfig(), { run });
    const transition = {
      attemptId: "attempt-1",
      comment: exact,
      eventId: "claim-attempt-1",
      from: "codex-ready" as const,
      issueNumber: 42,
      to: "codex-in-progress" as const,
    };

    await expect(adapter.transitionIssue(transition)).rejects.toThrow(
      "lifecycle-delivery-ambiguous",
    );
    // The adapter must not append its marker to a target label it cannot prove it owns.
    expect(run).toHaveBeenCalledTimes(1);

    run.mockClear();
    comments = [{ body: `${exact} extra` }];
    await expect(adapter.transitionIssue(transition)).rejects.toThrow(
      "lifecycle-delivery-ambiguous",
    );
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("repairs merged issue lifecycle without reopening or merging anything", async () => {
    let duplicate = false;
    const calls: string[][] = [];
    const run = vi.fn((args: readonly string[]): Promise<CommandResult> => {
      calls.push([...args]);
      if (args[0] === "issue" && args[1] === "view") {
        return Promise.resolve({
          stdout: JSON.stringify({
            comments: duplicate
              ? [
                  {
                    body: "codex-lifecycle event=merge-42 attempt=attempt-42 result=completed",
                  },
                ]
              : [],
            labels: duplicate ? [] : [{ name: "codex-review" }],
            state: "CLOSED",
          }),
        });
      }
      return Promise.resolve({ stdout: "" });
    });
    const adapter = new GhCliLoopAdapter(loopConfig(), { run });
    const input = {
      attemptId: "attempt-42",
      comment: "codex-lifecycle event=merge-42 attempt=attempt-42 result=completed stage=completed",
      eventId: "merge-42",
      from: "codex-review" as const,
      issueNumber: 42,
    };

    await expect(adapter.completeMergedIssue(input)).resolves.toBe("applied");
    expect(calls.map((args) => args.slice(0, 2))).toEqual([
      ["issue", "view"],
      ["issue", "edit"],
      ["issue", "comment"],
    ]);
    expect(calls.flat()).not.toContain("--state");
    duplicate = true;
    calls.length = 0;
    await expect(adapter.completeMergedIssue(input)).resolves.toBe("duplicate");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.at(-1)).toBe(input.comment);
    duplicate = false;
    calls.length = 0;
    const exactRun = vi.fn((args: readonly string[]): Promise<CommandResult> => {
      calls.push([...args]);
      if (args[0] === "issue" && args[1] === "view") {
        return Promise.resolve({
          stdout: JSON.stringify({
            comments: [{ body: input.comment }],
            labels: [],
            state: "CLOSED",
          }),
        });
      }
      return Promise.resolve({ stdout: "" });
    });
    await expect(
      new GhCliLoopAdapter(loopConfig(), { run: exactRun }).completeMergedIssue(input),
    ).resolves.toBe("duplicate");
    expect(calls).toHaveLength(1);
  });

  it("recovers an ambiguous PR create and rejects conflicting existing PRs", async () => {
    let mode: "empty" | "ambiguous-created" | "conflict" = "empty";
    const run = vi.fn((args: readonly string[]): Promise<CommandResult> => {
      if (args[0] === "pr" && args[1] === "list") {
        if (mode === "empty") return Promise.resolve({ stdout: "[]" });
        return Promise.resolve({
          stdout: JSON.stringify([
            {
              baseRefName: "main",
              headRefName: "codex/42-safe",
              headRefOid: "abcdef1234567",
              headRepositoryOwner: { login: "owner" },
              isCrossRepository: false,
              isDraft: mode !== "conflict",
              number: 99,
              state: "OPEN",
              url: "https://github.com/owner/suno-automation/pull/99",
            },
          ]),
        });
      }
      if (args[0] === "pr" && args[1] === "create") {
        mode = "ambiguous-created";
        return Promise.reject(new Error("ack lost"));
      }
      return Promise.reject(new Error("unexpected"));
    });
    const adapter = new GhCliLoopAdapter(loopConfig(), { run });
    const input = {
      attemptId: "attempt-1",
      baseRef: "main",
      body: "Safe",
      expectedHeadSha: "abcdef1234567",
      headRef: "codex/42-safe",
      issueNumber: 42,
      title: "Safe",
    };

    await expect(adapter.ensureDraftPullRequest(input)).resolves.toMatchObject({
      draft: true,
      number: 99,
    });
    mode = "conflict";
    await expect(adapter.ensureDraftPullRequest(input)).rejects.toThrow("conflicting-pull-request");
  });

  it("refuses existing PR evidence unless every publication identity field matches", async () => {
    const input = {
      attemptId: "attempt-1",
      baseRef: "main",
      body: "Safe",
      expectedHeadSha: "abcdef1234567",
      headRef: "codex/42-safe",
      issueNumber: 42,
      title: "Safe",
    };
    const baseline = {
      baseRefName: "main",
      headRefName: "codex/42-safe",
      headRefOid: "abcdef1234567",
      headRepositoryOwner: { login: "owner" },
      isCrossRepository: false,
      isDraft: true,
      number: 99,
      state: "OPEN",
      url: "https://github.com/owner/suno-automation/pull/99",
    };
    const variants = [
      { name: "ready PR", pr: { ...baseline, isDraft: false } },
      { name: "closed PR", pr: { ...baseline, state: "CLOSED" } },
      { name: "wrong base", pr: { ...baseline, baseRefName: "release" } },
      { name: "fork", pr: { ...baseline, isCrossRepository: true } },
      { name: "other owner", pr: { ...baseline, headRepositoryOwner: { login: "other" } } },
      { name: "head mismatch", pr: { ...baseline, headRefOid: "deadbee1234567" } },
    ];

    for (const variant of variants) {
      const adapter = new GhCliLoopAdapter(loopConfig(), {
        run: (args) =>
          Promise.resolve({
            stdout: args[0] === "pr" && args[1] === "list" ? JSON.stringify([variant.pr]) : "",
          }),
      });
      await expect(adapter.ensureDraftPullRequest(input), variant.name).rejects.toThrow(
        "conflicting-pull-request",
      );
    }
  });

  it("rejects invalid authenticated and supervised authorization evidence rather than guessing", async () => {
    const invalidLogin = new GhCliLoopAdapter(loopConfig(), {
      run: () => Promise.resolve({ stdout: "not a login\n" }),
    });
    await expect(invalidLogin.authenticatedLogin()).rejects.toThrow("authenticated-login-invalid");

    const comments = [
      { author: { login: "owner" }, body: "unrelated", createdAt: "2026-07-23T12:00:00.000Z" },
    ];
    const adapter = new GhCliLoopAdapter(loopConfig(), {
      run: () => Promise.resolve({ stdout: JSON.stringify({ comments }) }),
    });
    const input = {
      action: "complete-merged",
      attemptId: "attempt-42",
      eventId: "event-42",
      issueNumber: 42,
    };
    await expect(adapter.getReconciliationAuthorization(input)).rejects.toThrow(
      "reconciliation-authorization-missing",
    );
    comments.push({
      author: { login: "owner" },
      body: "codex-reconcile event=event-42 attempt=attempt-42 action=complete-merged",
      createdAt: "not-a-timestamp",
    });
    await expect(adapter.getReconciliationAuthorization(input)).rejects.toThrow(
      "reconciliation-authorization-author-missing",
    );
  });

  it("fails closed for malformed or ambiguous trusted-rework PR evidence", async () => {
    const input = {
      approvedFeedbackIds: ["thread-1"],
      baseCommit: "abcdef1234567",
      eventId: "rework-1",
      issueNumber: 42,
      prNumber: 88,
    };
    const requestComment = {
      author: { login: "owner" },
      body: "codex-rework event=rework-1 pr=88 base=abcdef1234567 feedback=thread-1",
      createdAt: "2026-07-23T12:00:00.000Z",
    };
    const baseline = {
      data: {
        repository: {
          pullRequest: {
            commits: {
              nodes: [
                { commit: { committedDate: "2026-07-23T11:00:00.000Z", oid: "abcdef1234567" } },
              ],
            },
            headRefOid: "abcdef1234567",
            isDraft: true,
            reviewThreads: {
              nodes: [
                {
                  comments: { nodes: [{ createdAt: "2026-07-23T11:30:00.000Z", id: "comment-1" }] },
                  id: "thread-1",
                  isResolved: false,
                },
              ],
            },
            state: "OPEN",
          },
        },
      },
    };
    const malformed = [
      {
        name: "closed",
        value: {
          ...baseline,
          data: {
            repository: {
              pullRequest: { ...baseline.data.repository.pullRequest, state: "CLOSED" },
            },
          },
        },
      },
      {
        name: "ready",
        value: {
          ...baseline,
          data: {
            repository: {
              pullRequest: { ...baseline.data.repository.pullRequest, isDraft: false },
            },
          },
        },
      },
      {
        name: "head mismatch",
        value: {
          ...baseline,
          data: {
            repository: {
              pullRequest: {
                ...baseline.data.repository.pullRequest,
                headRefOid: "deadbee1234567",
              },
            },
          },
        },
      },
      {
        name: "bad date",
        value: {
          ...baseline,
          data: {
            repository: {
              pullRequest: {
                ...baseline.data.repository.pullRequest,
                commits: {
                  nodes: [{ commit: { committedDate: "not-a-date", oid: "abcdef1234567" } }],
                },
              },
            },
          },
        },
      },
      {
        name: "missing feedback",
        value: {
          ...baseline,
          data: {
            repository: {
              pullRequest: {
                ...baseline.data.repository.pullRequest,
                reviewThreads: { nodes: [] },
              },
            },
          },
        },
      },
      {
        name: "duplicate feedback",
        value: {
          ...baseline,
          data: {
            repository: {
              pullRequest: {
                ...baseline.data.repository.pullRequest,
                reviewThreads: {
                  nodes: [
                    ...baseline.data.repository.pullRequest.reviewThreads.nodes,
                    ...baseline.data.repository.pullRequest.reviewThreads.nodes,
                  ],
                },
              },
            },
          },
        },
      },
    ];

    for (const testCase of malformed) {
      const adapter = new GhCliLoopAdapter(loopConfig(), {
        run: (args) =>
          Promise.resolve({
            stdout:
              args[0] === "issue"
                ? JSON.stringify({ comments: [requestComment] })
                : JSON.stringify(testCase.value),
          }),
      });
      await expect(adapter.getReworkAuthorization(input), testCase.name).rejects.toThrow(
        testCase.name.includes("feedback")
          ? "rework-feedback-ambiguous"
          : "rework-pull-request-evidence-conflict",
      );
    }
  });

  it("requires exactly one immutable rework request marker before reading PR evidence", async () => {
    const input = {
      approvedFeedbackIds: ["thread-1"],
      baseCommit: "abcdef1234567",
      eventId: "rework-1",
      issueNumber: 42,
      prNumber: 88,
    };
    const marker = "codex-rework event=rework-1 pr=88 base=abcdef1234567 feedback=thread-1";
    for (const comments of [
      [],
      [
        { author: { login: "owner" }, body: marker, createdAt: "2026-07-23T12:00:00.000Z" },
        { author: { login: "owner" }, body: marker, createdAt: "2026-07-23T12:01:00.000Z" },
      ],
    ]) {
      const graphql = vi.fn();
      const adapter = new GhCliLoopAdapter(loopConfig(), {
        run: (args) => {
          if (args[0] === "api") graphql();
          return Promise.resolve({ stdout: JSON.stringify({ comments }) });
        },
      });
      await expect(adapter.getReworkAuthorization(input)).rejects.toThrow(
        comments.length === 0 ? "rework-request-missing" : "rework-request-ambiguous",
      );
      expect(graphql).not.toHaveBeenCalled();
    }
  });
});
