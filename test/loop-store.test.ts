import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeCandidates, reserveAttempt, transitionAttempt } from "../src/loop/domain.js";
import { LoopConfigSchema } from "../src/loop/schema.js";
import {
  FileDispatcherMutex,
  FileLoopStateStore,
  InMemoryDispatcherMutex,
  InMemoryLoopStateStore,
  InvalidLoopConfigError,
  MalformedLoopStateError,
  MutexBusyError,
  StateUpdateOwnershipError,
  loadLoopConfig,
  resolveLoopStatePath,
} from "../src/loop/store.js";
import { issueCandidate, loopConfig, loopNow, requiredValue } from "./support/loop-fixtures.js";

const execFileAsync = promisify(execFile);

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("loop configuration and persistence", () => {
  it("validates the committed two-slot example without real identifiers", async () => {
    const config = await loadLoopConfig(
      resolve(import.meta.dirname, "..", "config", "codex-loop.example.yaml"),
    );

    expect(config.slots.map((slot) => slot.id)).toEqual(["worker-1", "worker-2"]);
    expect(config.dispatcher.pollMinutes).toBe(15);
  });

  it("bounds config read and validation failures without exposing local values or paths", async () => {
    const directory = await mkdtemp(join(tmpdir(), "loop-invalid-config-"));
    directories.push(directory);
    const path = join(directory, "private-project-name.yaml");
    await writeFile(path, "projectId: private-project-identifier\n", "utf8");

    for (const candidate of [path, join(directory, "missing-private-config.yaml")]) {
      let failure: unknown;
      try {
        await loadLoopConfig(candidate);
      } catch (error: unknown) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(InvalidLoopConfigError);
      expect((failure as Error).message).toBe("Codex loop config is unavailable or invalid.");
      expect((failure as Error).message).not.toMatch(/private|projectId|yaml/i);
    }
  });

  it("rejects relative and aliased duplicate worktrees plus non-two-slot topologies", () => {
    const valid = {
      dispatcher: { leaseSeconds: 7_200, mutexSeconds: 60, pollMinutes: 15 },
      repository: { baseBranch: "main", name: "repo", owner: "owner" },
      retention: { completedAttempts: 500, days: 90 },
      slots: [
        { id: "worker-1", projectId: "p1", worktreePath: "C:\\repo\\worker" },
        { id: "worker-2", projectId: "p2", worktreePath: "C:/repo/other/../worker" },
      ],
      stateDirectory: "C:\\repo\\state",
      trustedLogins: ["owner"],
      verificationKeyEnv: "CODEX_LOOP_VERIFICATION_KEY",
      version: 1,
    };

    expect(LoopConfigSchema.safeParse(valid).success).toBe(false);
    expect(LoopConfigSchema.safeParse({ ...valid, slots: valid.slots.slice(0, 1) }).success).toBe(
      false,
    );
    expect(
      LoopConfigSchema.safeParse({
        ...valid,
        slots: [
          { ...valid.slots[0], worktreePath: "relative/worker-1" },
          { ...valid.slots[1], worktreePath: "/absolute/worker-2" },
        ],
      }).success,
    ).toBe(false);
    expect(
      LoopConfigSchema.safeParse({ ...valid, stateDirectory: "../relative-state" }).success,
    ).toBe(false);
  });

  it("preserves malformed state instead of replacing it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "loop-store-"));
    directories.push(directory);
    const path = join(directory, "state.json");
    const malformed = '{"version":1,"slots":"corrupt"}\n';
    await writeFile(path, malformed, "utf8");
    const store = new FileLoopStateStore(path);

    await expect(store.read()).rejects.toBeInstanceOf(MalformedLoopStateError);
    expect(await readFile(path, "utf8")).toBe(malformed);
  });

  it("creates missing state atomically and returns isolated snapshots", async () => {
    const directory = await mkdtemp(join(tmpdir(), "loop-store-"));
    directories.push(directory);
    const path = join(directory, "nested", "state.json");
    const store = new FileLoopStateStore(path);

    expect((await store.read()).attempts).toEqual([]);
    await store.update((state) => {
      state.audit.push({
        at: "2026-07-23T12:00:00.000Z",
        attemptId: "attempt-1",
        eventId: "created-1",
        issueNumber: 1,
        result: "success",
        slotId: "worker-1",
        stage: "claimed",
      });
      return "written";
    });
    const snapshot = await store.read();
    snapshot.audit.splice(0);

    expect((await store.read()).audit).toHaveLength(1);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ version: 1 });
  });

  it("serializes memory updates and recovers its queue after a rejected mutation", async () => {
    const store = new InMemoryLoopStateStore();
    await expect(
      store.update(() => {
        throw new Error("expected-failure");
      }),
    ).rejects.toThrow("expected-failure");

    await store.update((state) => {
      state.audit.push({
        at: "2026-07-23T12:00:00.000Z",
        attemptId: "attempt-1",
        eventId: "recovered-1",
        issueNumber: 1,
        result: "success",
        slotId: "worker-1",
        stage: "claimed",
      });
    });
    const first = await store.read();
    first.audit.splice(0);

    expect((await store.read()).audit).toHaveLength(1);
  });

  it("resolves the canonical absolute state path independently of config cwd", () => {
    const absolute = loopConfig();

    expect(resolveLoopStatePath(absolute, "C:\\repo\\config\\loop.yaml")).toBe(
      resolve(absolute.stateDirectory, "state.json"),
    );
    expect(resolveLoopStatePath(absolute, "C:\\worker\\elsewhere\\loop.yaml")).toBe(
      resolve(absolute.stateDirectory, "state.json"),
    );
  });

  it("preserves concurrent updates from separate Node processes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "loop-store-processes-"));
    directories.push(directory);
    const path = join(directory, "state.json");
    const childPath = resolve(import.meta.dirname, "support", "loop-store-child.ts");

    await Promise.all(
      ["process-a", "process-b"].map((eventId) =>
        execFileAsync(process.execPath, ["--import", "tsx", childPath, path, eventId, "100"], {
          cwd: resolve(import.meta.dirname, ".."),
          encoding: "utf8",
          windowsHide: true,
        }),
      ),
    );

    const state = await new FileLoopStateStore(path).read();
    expect(state.maintenanceAudit.map((event) => event.eventId).sort()).toEqual([
      "process-a",
      "process-b",
    ]);
  });

  it("serializes overlapping dispatcher and worker journals across store instances", async () => {
    const directory = await mkdtemp(join(tmpdir(), "loop-store-overlap-"));
    directories.push(directory);
    const path = join(directory, "state.json");
    const dispatcherStore = new FileLoopStateStore(path);
    const workerStore = new FileLoopStateStore(path);
    await dispatcherStore.update((state) => {
      const candidate = requiredValue(
        analyzeCandidates([issueCandidate(42)], state, ["owner"]).eligible[0],
      );
      reserveAttempt(state, {
        attemptId: "attempt-42",
        candidate,
        leaseExpiresAt: "2026-07-23T14:00:00.000Z",
        now: loopNow,
        slotId: "worker-1",
      });
    });

    await Promise.all([
      dispatcherStore.update(async (state) => {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 75));
        state.maintenanceAudit.push({
          at: loopNow,
          eventId: "dispatcher-overlap",
          removedAttempts: 0,
          result: "success",
        });
      }),
      workerStore.update((state) => {
        transitionAttempt(state, "attempt-42", "running", loopNow, {
          threadId: "thread-42",
        });
      }),
    ]);

    const state = await dispatcherStore.read();
    expect(state.attempts[0]).toMatchObject({
      stage: "running",
      threadId: "thread-42",
    });
    expect(state.maintenanceAudit.map((event) => event.eventId)).toContain("dispatcher-overlap");
  });

  it("fails closed and preserves contradictory state-lock ownership", async () => {
    const directory = await mkdtemp(join(tmpdir(), "loop-store-lock-owner-"));
    directories.push(directory);
    const path = join(directory, "state.json");
    const lockPath = `${path}.update.lock`;
    const store = new FileLoopStateStore(path);

    await expect(
      store.update(async (state) => {
        state.maintenanceAudit.push({
          at: loopNow,
          eventId: "must-not-report-success",
          removedAttempts: 0,
          result: "success",
        });
        await writeFile(
          lockPath,
          JSON.stringify({
            expiresAt: "2099-01-01T00:00:00.000Z",
            ownerPid: process.pid,
            token: "changed-owner",
            version: 1,
          }),
          "utf8",
        );
      }),
    ).rejects.toBeInstanceOf(StateUpdateOwnershipError);
    expect(await readFile(lockPath, "utf8")).toContain("changed-owner");
  });

  it("preserves malformed state update locks instead of guessing ownership", async () => {
    const directory = await mkdtemp(join(tmpdir(), "loop-store-lock-malformed-"));
    directories.push(directory);
    const path = join(directory, "state.json");
    const lockPath = `${path}.update.lock`;
    await writeFile(lockPath, '{"version":2}', "utf8");

    await expect(new FileLoopStateStore(path).update(() => undefined)).rejects.toBeInstanceOf(
      MalformedLoopStateError,
    );
    expect(await readFile(lockPath, "utf8")).toBe('{"version":2}');
  });

  it("archives a stale dead-owner mutex before taking ownership", async () => {
    const directory = await mkdtemp(join(tmpdir(), "loop-mutex-"));
    directories.push(directory);
    const path = join(directory, "dispatcher.lock");
    await writeFile(
      path,
      JSON.stringify({
        expiresAt: "2000-01-01T00:00:00.000Z",
        ownerPid: 2_000_000_000,
        token: "old-token",
        version: 1,
      }),
      "utf8",
    );
    const mutex = new FileDispatcherMutex(path, 60, () => new Date("2026-07-23T12:00:00.000Z"));

    await expect(mutex.runExclusive(() => Promise.resolve("done"))).resolves.toBe("done");
    const entries = await readdir(directory);
    expect(entries.some((entry) => entry.startsWith("dispatcher.lock.stale.old-token"))).toBe(true);
    expect(entries).not.toContain("dispatcher.lock");
  });

  it("refuses a live mutex and preserves malformed mutex evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "loop-mutex-"));
    directories.push(directory);
    const path = join(directory, "dispatcher.lock");
    const now = () => new Date("2026-07-23T12:00:00.000Z");
    await writeFile(
      path,
      JSON.stringify({
        expiresAt: "2026-07-23T12:01:00.000Z",
        ownerPid: process.pid,
        token: "active-token",
        version: 1,
      }),
      "utf8",
    );
    const mutex = new FileDispatcherMutex(path, 60, now);

    await expect(mutex.runExclusive(() => Promise.resolve())).rejects.toBeInstanceOf(
      MutexBusyError,
    );
    await writeFile(path, '{"version":2}', "utf8");
    await expect(mutex.runExclusive(() => Promise.resolve())).rejects.toThrow("mutex is malformed");
    expect(await readFile(path, "utf8")).toBe('{"version":2}');
  });

  it("releases the in-memory mutex after success and failure", async () => {
    const mutex = new InMemoryDispatcherMutex();
    await expect(
      mutex.runExclusive(() => Promise.reject(new Error("operation-failed"))),
    ).rejects.toThrow("operation-failed");
    await expect(mutex.runExclusive(() => Promise.resolve("recovered"))).resolves.toBe("recovered");
  });
});
