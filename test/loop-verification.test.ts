import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeCandidates, releaseAttempt, reserveAttempt } from "../src/loop/domain.js";
import {
  DeepVerificationService,
  ExecFileVerificationRunner,
  loadAdversarialReview,
  packageManagerExecutable,
  planVerification,
  scanDiff,
  VerificationGitAdapter,
  verifyVerdictSignature,
  type VerificationCommandRunner,
  type VerificationGitPort,
} from "../src/loop/verification.js";
import type { LoopConfig, LoopState } from "../src/loop/schema.js";
import { InMemoryLoopStateStore, type LoopStateStore } from "../src/loop/store.js";
import {
  issueCandidate,
  loopConfig,
  loopNow,
  loopState,
  requiredValue,
} from "./support/loop-fixtures.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

function committedStore(): InMemoryLoopStateStore {
  const state = loopState();
  const candidate = requiredValue(
    analyzeCandidates([issueCandidate(42)], state, ["owner"]).eligible[0],
  );
  const attempt = reserveAttempt(state, {
    attemptId: "attempt-42",
    candidate,
    leaseExpiresAt: "2026-07-23T14:00:00.000Z",
    now: loopNow,
    slotId: "worker-1",
  });
  attempt.stage = "committed";
  attempt.commitSha = "abcdef1234567";
  state.slots[0].status = "running";
  return new InMemoryLoopStateStore(state);
}

class DivergingStore implements LoopStateStore {
  readonly #readState: LoopState;

  constructor(readState: LoopState) {
    this.#readState = readState;
  }

  read(): Promise<LoopState> {
    return Promise.resolve(structuredClone(this.#readState));
  }

  async update<T>(mutation: (state: LoopState) => Promise<T> | T): Promise<T> {
    return mutation(loopState());
  }
}

describe("deep verification", () => {
  it("routes tests, config, and high-risk loop changes to every required gate", () => {
    expect(
      planVerification(["src/loop/domain.ts", "src/loop/schema.ts", "test/loop-domain.test.ts"]),
    ).toMatchObject({
      config: true,
      highRisk: true,
      testsChanged: true,
    });
    expect(planVerification(["docs\\operations.md"])).toMatchObject({
      changedPaths: ["docs/operations.md"],
      config: false,
      highRisk: false,
      testsChanged: false,
    });
  });

  it.each([
    ["config/options.yaml", true, false, false],
    ["configuration/options.yaml", false, false, false],
    ["src/domain/issue-promotion.ts", false, true, false],
    ["src/domain/not-risky.ts", false, false, false],
    ["src/persistence/state.ts", false, true, false],
    ["src/server/auth.ts", false, true, false],
    ["src/server/auth-helper.ts", false, false, false],
    ["extension/src/dom-adapter.ts", false, true, false],
    ["extension/src/live-attempt-guard.ts", false, true, false],
    ["extension/src/command-executor.ts", false, true, false],
    ["extension/src/options.ts", false, false, false],
    ["test/unit.ts", false, false, true],
    ["contest/unit.ts", false, false, false],
    ["src/unit.test.mts", false, false, true],
    ["src/unit.test.cts", false, false, true],
    ["src/unit.spec.ts", false, false, false],
  ] as const)(
    "routes %s without broad prefix or extension matches",
    (path, config, highRisk, testsChanged) => {
      expect(planVerification([path])).toEqual({
        changedPaths: [path],
        config,
        highRisk,
        testsChanged,
      });
    },
  );

  it("selects the package manager executable explicitly for both platforms", () => {
    expect(packageManagerExecutable("win32")).toBe("pnpm.cmd");
    expect(packageManagerExecutable("linux")).toBe("pnpm");
  });

  it("blocks secret-like values and unsafe live/force workflow changes", () => {
    const numericPayload = ["1234567890", "1234567890", "1234567890"].join("");
    const githubToken = ["ghp_", numericPayload].join("");
    const googleApiKey = ["AI", "za", numericPayload.slice(0, 25)].join("");
    const apiSecret = ["sk", "-", numericPayload.slice(0, 25)].join("");
    const sessionCookie = ["1234567890", "1234567890"].join("");
    const tokenField = ["to", "ken"].join("");
    const cookieField = ["coo", "kie"].join("");
    const allowLive = ["allowLive", "Submissions = true"].join("");
    const liveMode = ["automation.", 'mode = "live"'].join("");
    const forcePush = ["git push ", "--force", " origin main"].join("");
    const hardReset = ["git reset ", "--hard", " HEAD"].join("");
    const privateKeyMarker = ["-----BEGIN ", "PRIVATE", " KEY-----"].join("");
    const diff = `diff --git a/x b/x
+${tokenField} = "${githubToken}"
+${allowLive}
+${forcePush}
+${liveMode}
+${hardReset}
+key = "${googleApiKey}"
+secret = "${apiSecret}"
+${cookieField} = "${sessionCookie}"
+${privateKeyMarker}
`;
    const findings = scanDiff(diff);

    expect(findings.map((finding) => finding.id)).toEqual(
      expect.arrayContaining(["github-token", "live-suno-enabled", "force-push-workflow"]),
    );
    expect(findings.map((finding) => finding.id)).toEqual(
      expect.arrayContaining([
        "api-secret",
        "google-api-key",
        "private-key",
        "session-secret",
        "destructive-git-workflow",
      ]),
    );
    expect(JSON.stringify(findings)).not.toContain(githubToken);
  });

  it("does not flag removed lines, diff headers, short tokens, or lookalike commands", () => {
    const numericPayload = ["1234567890", "1234567890", "1234567890"].join("");
    const githubToken = ["ghp_", numericPayload].join("");
    const sessionCookie = ["1234567890", "1234567890"].join("");
    const tokenField = ["to", "ken"].join("");
    const cookieField = ["coo", "kie"].join("");
    const removedLive = ["allowLive", "Submissions = true"].join("");
    const removedReset = ["git reset ", "--hard", " HEAD"].join("");
    const shortGitHubToken = ["ghp_", "short"].join("");
    const lookalikeGitHubToken = ["xghp_", "1234567890", "1234567890", "1234567890"].join("");
    const authorizationField = ["author", "ization"].join("");
    const publicKeyMarker = ["-----BEGIN ", "PUBLIC", " KEY-----"].join("");
    const diff = `diff --git a/x b/x
-${removedLive}
-${removedReset}
-${tokenField} = "${githubToken}"
-${cookieField} = "${sessionCookie}"
+++ ${removedLive}
+disallowLiveSubmissions = true
+git push origin main --forceful
+git reset --harder HEAD
+${tokenField} = "${shortGitHubToken}"
+${tokenField} = "${lookalikeGitHubToken}"
+${authorizationField} = unquoted-value
+${publicKeyMarker}
`;

    expect(scanDiff(diff)).toEqual([]);
  });

  it("returns redacted, severity-bound findings rather than matched values", () => {
    const authorizationField = ["author", "ization"].join("");
    const sessionValue = ["a-very-long-", "session-value"].join("");
    const liveMode = ["automation.", "mode = live"].join("");
    const findings = scanDiff(`+${authorizationField} = "${sessionValue}"\n+${liveMode}\n`);

    expect(findings).toEqual([
      {
        confidence: "high",
        id: "session-secret",
        location: "repository-diff",
        requiredAction: "Remove the sensitive value and rotate it before publication.",
        severity: "P0",
        summary: "A secret-like value is present in the proposed diff.",
      },
      {
        confidence: "high",
        id: "live-suno-enabled",
        location: "repository-diff",
        requiredAction:
          "Remove the unsafe workflow change or obtain a separate supervised contract.",
        severity: "P1",
        summary: "The diff would weaken a live-action or Git safety boundary.",
      },
    ]);
    expect(JSON.stringify(findings)).not.toContain("session-value");
  });

  it("loads only schema-valid adversarial reports", async () => {
    const directory = await mkdtemp(join(tmpdir(), "loop-review-"));
    directories.push(directory);
    const validPath = join(directory, "valid.json");
    const invalidPath = join(directory, "invalid.json");
    await writeFile(validPath, '{"findings":[],"status":"pass","version":1}', "utf8");
    await writeFile(invalidPath, '{"status":"maybe"}', "utf8");

    await expect(loadAdversarialReview(validPath)).resolves.toMatchObject({ status: "pass" });
    await expect(loadAdversarialReview(invalidPath)).rejects.toThrow();
  });

  it("executes verification commands without a shell and normalizes failures", async () => {
    const runner = new ExecFileVerificationRunner();

    await expect(
      runner.run(process.cwd(), process.execPath, ["-e", "process.exit(0)"]),
    ).resolves.toBeGreaterThanOrEqual(0);
    await expect(
      runner.run(process.cwd(), process.execPath, ["-e", "process.exit(7)"]),
    ).rejects.toThrow("verification-command-failed");
  });

  it("reads change, commit, and diff evidence from git", async () => {
    const git = new VerificationGitAdapter();
    const baseRef = "HEAD~1";

    await expect(git.commitSha(process.cwd())).resolves.toMatch(/^[a-f0-9]{40}$/);
    expect((await git.changedPaths(process.cwd(), baseRef)).length).toBeGreaterThan(0);
    await expect(git.diff(process.cwd(), baseRef)).resolves.toContain("diff --git");
  });

  it("produces a signed commit-bound verdict and isolates command evidence", async () => {
    const store = committedStore();
    const run = vi.fn(() => Promise.resolve(12));
    const commands: VerificationCommandRunner = {
      run,
    };
    const changedPaths = vi.fn(() =>
      Promise.resolve(["src/loop/domain.ts", "src/loop/schema.ts", "test/loop-domain.test.ts"]),
    );
    const git: VerificationGitPort = {
      changedPaths,
      commitSha: vi.fn(() => Promise.resolve("abcdef1234567")),
      diff: vi.fn(() => Promise.resolve("+safe change\n")),
    };
    const service = new DeepVerificationService(
      loopConfig(),
      store,
      commands,
      git,
      () => new Date(loopNow),
    );
    const key = "a-strong-local-verification-key-12345";

    const verdict = await service.verify({
      adversarialReview: { findings: [], status: "pass", version: 1 },
      attemptId: "attempt-42",
      focusedPassed: true,
      key,
    });

    expect(verdict.status).toBe("pass");
    expect(verdict.commands.map((command) => command.name)).toEqual([
      "focused",
      "full-gate",
      "build",
      "config",
      "mutation",
    ]);
    expect(changedPaths).toHaveBeenCalledWith("C:\\safe\\worker-1", "origin/main");
    expect(run).toHaveBeenNthCalledWith(1, "C:\\safe\\worker-1", "pnpm.cmd", [
      "exec",
      "vitest",
      "run",
      "test/loop-domain.test.ts",
    ]);
    expect(run).toHaveBeenNthCalledWith(2, "C:\\safe\\worker-1", "pnpm.cmd", ["check"]);
    expect(run).toHaveBeenNthCalledWith(3, "C:\\safe\\worker-1", "pnpm.cmd", ["build"]);
    expect(run).toHaveBeenNthCalledWith(4, "C:\\safe\\worker-1", "pnpm.cmd", ["validate:config"]);
    expect(run).toHaveBeenNthCalledWith(5, "C:\\safe\\worker-1", "pnpm.cmd", ["test:mutation"]);
    expect(verifyVerdictSignature(verdict, key)).toBe(true);
    expect(verifyVerdictSignature(verdict, `${key}-wrong`)).toBe(false);
    expect(verdict.slotId).toBe("worker-1");
    expect(
      verifyVerdictSignature(
        {
          ...verdict,
          slotId: "worker-2",
        },
        key,
      ),
    ).toBe(false);
    expect((await store.read()).attempts[0]).toMatchObject({
      commitSha: "abcdef1234567",
      stage: "verified",
    });
  });

  it("blocks publication when changed tests have no independent review", async () => {
    const store = committedStore();
    const service = new DeepVerificationService(
      loopConfig(),
      store,
      { run: vi.fn(() => Promise.resolve(1)) },
      {
        changedPaths: vi.fn(() => Promise.resolve(["test/loop-domain.test.ts"])),
        commitSha: vi.fn(() => Promise.resolve("abcdef1234567")),
        diff: vi.fn(() => Promise.resolve("+safe\n")),
      },
      () => new Date(loopNow),
    );

    const verdict = await service.verify({
      attemptId: "attempt-42",
      focusedPassed: true,
      key: "a-strong-local-verification-key-12345",
    });

    expect(verdict.status).toBe("block");
    expect(verdict.findings.map((finding) => finding.id)).toContain("adversarial-review-missing");
    expect((await store.read()).attempts[0]?.repairPasses).toBe(1);
  });

  it("combines focused, command, and adversarial failures into one repair verdict", async () => {
    const store = committedStore();
    const service = new DeepVerificationService(
      loopConfig(),
      store,
      { run: vi.fn(() => Promise.reject(new Error("gate-failed"))) },
      {
        changedPaths: vi.fn(() => Promise.resolve(["test/loop-domain.test.ts"])),
        commitSha: vi.fn(() => Promise.resolve("abcdef1234567")),
        diff: vi.fn(() => Promise.resolve("+safe\n")),
      },
      () => new Date(loopNow),
    );

    const verdict = await service.verify({
      adversarialReview: {
        findings: [
          {
            confidence: "low",
            id: "weak-assertion",
            location: "changed-tests",
            requiredAction: "Strengthen the outcome assertion.",
            severity: "P2",
            summary: "A test may be too permissive.",
          },
        ],
        status: "block",
        version: 1,
      },
      attemptId: "attempt-42",
      focusedPassed: false,
      key: "a-strong-local-verification-key-12345",
    });

    expect(verdict.status).toBe("block");
    expect(verdict.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "focused", status: "block" }),
        expect.objectContaining({ name: "full-gate", status: "block" }),
        expect.objectContaining({ name: "build", status: "block" }),
      ]),
    );
    expect(verdict.findings.map((finding) => finding.id)).toEqual(
      expect.arrayContaining(["weak-assertion", "adversarial-review-blocked"]),
    );
  });

  it("blocks a no-change attempt before publication", async () => {
    const store = committedStore();
    const service = new DeepVerificationService(
      loopConfig(),
      store,
      { run: vi.fn(() => Promise.resolve(1)) },
      {
        changedPaths: vi.fn(() => Promise.resolve([])),
        commitSha: vi.fn(() => Promise.resolve("abcdef1234567")),
        diff: vi.fn(() => Promise.resolve("")),
      },
      () => new Date(loopNow),
    );

    const verdict = await service.verify({
      attemptId: "attempt-42",
      focusedPassed: true,
      key: "a-strong-local-verification-key-12345",
    });

    expect(verdict.status).toBe("block");
    expect(verdict.findings).toEqual([
      expect.objectContaining({
        id: "no-changed-paths",
        severity: "P1",
      }),
    ]);
    expect((await store.read()).attempts[0]).toMatchObject({
      repairPasses: 1,
      stage: "committed",
    });
  });

  it.each([
    ["high", "P0", "block"],
    ["high", "P1", "block"],
    ["high", "P2", "pass"],
    ["medium", "P0", "pass"],
    ["low", "P1", "pass"],
  ] as const)(
    "blocks only high-confidence P0/P1 findings: %s %s",
    async (confidence, severity, expected) => {
      const service = new DeepVerificationService(
        loopConfig(),
        committedStore(),
        { run: vi.fn(() => Promise.resolve(1)) },
        {
          changedPaths: vi.fn(() => Promise.resolve(["test/loop-domain.test.ts"])),
          commitSha: vi.fn(() => Promise.resolve("abcdef1234567")),
          diff: vi.fn(() => Promise.resolve("+safe\n")),
        },
        () => new Date(loopNow),
      );

      const verdict = await service.verify({
        adversarialReview: {
          findings: [
            {
              confidence,
              id: "review-finding",
              location: "changed-tests",
              requiredAction: "Resolve the exact test weakness.",
              severity,
              summary: "Independent review finding.",
            },
          ],
          status: "pass",
          version: 1,
        },
        attemptId: "attempt-42",
        focusedPassed: true,
        key: "a-strong-local-verification-key-12345",
      });

      expect(verdict.status).toBe(expected);
    },
  );

  it("selects the requested attempt, its slot, and only its persisted record", async () => {
    const state = loopState();
    const first = requiredValue(
      analyzeCandidates([issueCandidate(41)], state, ["owner"]).eligible[0],
    );
    reserveAttempt(state, {
      attemptId: "attempt-41",
      candidate: first,
      leaseExpiresAt: "2026-07-23T13:00:00.000Z",
      now: "2026-07-23T09:00:00.000Z",
      slotId: "worker-1",
    });
    releaseAttempt(state, "attempt-41", "attention", "2026-07-23T10:00:00.000Z");
    const second = requiredValue(
      analyzeCandidates([issueCandidate(42)], state, ["owner"]).eligible[0],
    );
    const target = reserveAttempt(state, {
      attemptId: "attempt-42",
      candidate: second,
      leaseExpiresAt: "2026-07-23T14:00:00.000Z",
      now: loopNow,
      slotId: "worker-2",
    });
    target.stage = "committed";
    target.commitSha = "abcdef1234567";
    state.slots[1].status = "running";
    const store = new InMemoryLoopStateStore(state);
    const changedPaths = vi.fn(() => Promise.resolve(["docs/operations.md"]));
    const run = vi.fn(() => Promise.resolve(1));
    const service = new DeepVerificationService(
      loopConfig(),
      store,
      { run },
      {
        changedPaths,
        commitSha: vi.fn(() => Promise.resolve("abcdef1234567")),
        diff: vi.fn(() => Promise.resolve("+safe\n")),
      },
      () => new Date(loopNow),
    );

    const verdict = await service.verify({
      attemptId: "attempt-42",
      focusedPassed: true,
      key: "a-strong-local-verification-key-12345",
    });

    const stored = await store.read();
    expect(verdict.slotId).toBe("worker-2");
    expect(stored.attempts[0]?.stage).toBe("attention");
    expect(Object.hasOwn(requiredValue(stored.attempts[0]), "verification")).toBe(false);
    expect(stored.attempts[1]).toMatchObject({
      attemptId: "attempt-42",
      stage: "verified",
    });
    expect(changedPaths).toHaveBeenCalledWith("C:\\safe\\worker-2", "origin/main");
    expect(run).toHaveBeenCalledWith("C:\\safe\\worker-2", "pnpm.cmd", ["check"]);
  });

  it("fails closed for missing slot config and a disappearing persisted attempt", async () => {
    const missingSlot = {
      ...loopConfig(),
      slots: [loopConfig().slots[1]],
    } as unknown as LoopConfig;
    const noSlotService = new DeepVerificationService(
      missingSlot,
      committedStore(),
      { run: vi.fn() },
      { changedPaths: vi.fn(), commitSha: vi.fn(), diff: vi.fn() },
    );
    await expect(
      noSlotService.verify({
        attemptId: "attempt-42",
        focusedPassed: true,
        key: "a-strong-local-verification-key-12345",
      }),
    ).rejects.toThrow("slot-config-missing");

    const readState = await committedStore().read();
    const disappearing = new DeepVerificationService(
      loopConfig(),
      new DivergingStore(readState),
      { run: vi.fn(() => Promise.resolve(1)) },
      {
        changedPaths: vi.fn(() => Promise.resolve(["docs/operations.md"])),
        commitSha: vi.fn(() => Promise.resolve("abcdef1234567")),
        diff: vi.fn(() => Promise.resolve("+safe\n")),
      },
      () => new Date(loopNow),
    );
    await expect(
      disappearing.verify({
        attemptId: "attempt-42",
        focusedPassed: true,
        key: "a-strong-local-verification-key-12345",
      }),
    ).rejects.toThrow("attempt-not-found");
  });

  it("preserves the repair ceiling after a prior passing verdict", async () => {
    const store = committedStore();
    const service = new DeepVerificationService(
      loopConfig(),
      store,
      { run: vi.fn(() => Promise.resolve(1)) },
      {
        changedPaths: vi.fn(() => Promise.resolve(["docs/operations.md"])),
        commitSha: vi.fn(() => Promise.resolve("abcdef1234567")),
        diff: vi.fn(() => Promise.resolve("+safe\n")),
      },
      () => new Date(loopNow),
    );
    const key = "a-strong-local-verification-key-12345";
    await service.verify({ attemptId: "attempt-42", focusedPassed: true, key });
    await store.update((state) => {
      requiredValue(state.attempts[0]).repairPasses = 2;
    });

    const blocked = await service.verify({
      attemptId: "attempt-42",
      focusedPassed: false,
      key,
    });

    expect(blocked.status).toBe("pass");
    expect((await store.read()).attempts[0]?.repairPasses).toBe(2);
  });

  it("enforces attempt stage and the two-pass repair ceiling", async () => {
    const missing = new DeepVerificationService(
      loopConfig(),
      new InMemoryLoopStateStore(),
      { run: vi.fn() },
      {
        changedPaths: vi.fn(),
        commitSha: vi.fn(),
        diff: vi.fn(),
      },
    );
    await expect(
      missing.verify({
        attemptId: "missing",
        focusedPassed: true,
        key: "a-strong-local-verification-key-12345",
      }),
    ).rejects.toThrow("attempt-not-found");

    const notCommittedStore = committedStore();
    await notCommittedStore.update((state) => {
      requiredValue(state.attempts[0]).stage = "running";
    });
    const notCommitted = new DeepVerificationService(
      loopConfig(),
      notCommittedStore,
      { run: vi.fn() },
      {
        changedPaths: vi.fn(),
        commitSha: vi.fn(),
        diff: vi.fn(),
      },
    );
    await expect(
      notCommitted.verify({
        attemptId: "attempt-42",
        focusedPassed: true,
        key: "a-strong-local-verification-key-12345",
      }),
    ).rejects.toThrow("attempt-not-committed");

    const exhaustedStore = committedStore();
    await exhaustedStore.update((state) => {
      requiredValue(state.attempts[0]).repairPasses = 2;
    });
    const exhausted = new DeepVerificationService(
      loopConfig(),
      exhaustedStore,
      { run: vi.fn() },
      {
        changedPaths: vi.fn(),
        commitSha: vi.fn(),
        diff: vi.fn(),
      },
    );
    await expect(
      exhausted.verify({
        attemptId: "attempt-42",
        focusedPassed: true,
        key: "a-strong-local-verification-key-12345",
      }),
    ).rejects.toThrow("repair-pass-limit");
  });

  it("does not silently omit non-applicable gates", async () => {
    const store = committedStore();
    const service = new DeepVerificationService(
      loopConfig(),
      store,
      { run: vi.fn(() => Promise.resolve(1)) },
      {
        changedPaths: vi.fn(() => Promise.resolve(["docs/operations.md"])),
        commitSha: vi.fn(() => Promise.resolve("abcdef1234567")),
        diff: vi.fn(() => Promise.resolve("+safe docs\n")),
      },
      () => new Date(loopNow),
    );

    const verdict = await service.verify({
      attemptId: "attempt-42",
      focusedPassed: true,
      key: "a-strong-local-verification-key-12345",
    });

    expect(verdict.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "config", status: "not-applicable" }),
        expect.objectContaining({ name: "mutation", status: "not-applicable" }),
      ]),
    );
  });
});
