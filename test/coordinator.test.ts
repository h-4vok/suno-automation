import { describe, expect, it, vi } from "vitest";

import type { CommandResult } from "../src/contracts/extension.js";
import { Coordinator } from "../src/coordinator/coordinator.js";
import type { Clock } from "../src/domain/time.js";
import { InMemoryStateStore } from "../src/persistence/state.js";
import { makeConfig, SequenceRandom } from "./support/fixtures.js";

const available = (): Extract<CommandResult, { kind: "inspect" }> => ({
  kind: "inspect",
  quota: { observedAt: "2026-07-19T22:30:00.000Z", state: "available" },
});

const unknown = (): Extract<CommandResult, { kind: "inspect" }> => ({
  kind: "inspect",
  quota: {
    details: "No remaining-credit count is visible.",
    observedAt: "2026-07-19T22:30:00.000Z",
    state: "unknown",
  },
});

function harness(mode: "observe" | "draft" | "live", maxGenerations = 5) {
  const clock: Clock = { now: () => new Date("2026-07-19T22:30:00.000Z") };
  const compose = vi.fn().mockResolvedValue({
    lyricsField: "[Intro: bandoneon enters softly]\n[Finale: ensemble resolves abruptly]",
    title: "Clockwork Avenida",
  });
  const store = new InMemoryStateStore();
  const coordinator = new Coordinator({
    clock,
    config: makeConfig({ maxGenerations, mode }),
    random: new SequenceRandom(...Array.from({ length: 20 }, () => 0.5)),
    songwriter: { compose },
    store,
  });
  return { compose, coordinator, store };
}

describe("Coordinator", () => {
  it("observe mode inspects once without spending Gemini or Suno quota", async () => {
    const { compose, coordinator } = harness("observe");
    const run = await coordinator.startRun({ reason: "schedule" });
    const inspect = await coordinator.leaseNextCommand();
    expect(inspect?.kind).toBe("inspect");
    await coordinator.completeCommand(inspect?.id ?? "", unknown());

    const state = await coordinator.state();
    expect(state.runs[0]).toMatchObject({ completedReason: "observe-only", status: "completed" });
    expect(compose).not.toHaveBeenCalled();
    expect(await coordinator.leaseNextCommand()).toBeUndefined();
    expect((await coordinator.startRun({ reason: "schedule" })).id).toBe(run.id);
  });

  it("draft mode composes and fills without submission", async () => {
    const { coordinator } = harness("draft");
    await coordinator.startRun({ reason: "manual" });
    const inspect = await coordinator.leaseNextCommand();
    await coordinator.completeCommand(inspect?.id ?? "", unknown());
    const create = await coordinator.leaseNextCommand();
    expect(create).toMatchObject({ kind: "create", payload: { submit: false } });
    await coordinator.completeCommand(create?.id ?? "", { kind: "create", outcome: "drafted" });
    expect((await coordinator.state()).runs[0]).toMatchObject({
      completedReason: "draft-ready",
      generationCount: 0,
      status: "completed",
    });
  });

  it("live mode loops through inspection and stops at generation guard", async () => {
    const { compose, coordinator } = harness("live", 2);
    await coordinator.startRun({ reason: "schedule" });
    for (let generation = 0; generation < 2; generation += 1) {
      const inspect = await coordinator.leaseNextCommand();
      await coordinator.completeCommand(inspect?.id ?? "", available());
      const create = await coordinator.leaseNextCommand();
      expect(create).toMatchObject({ kind: "create", payload: { submit: true } });
      await coordinator.completeCommand(create?.id ?? "", { kind: "create", outcome: "submitted" });
    }
    expect((await coordinator.state()).runs[0]).toMatchObject({
      completedReason: "daily-generation-guard",
      generationCount: 2,
      status: "completed",
    });
    expect(compose).toHaveBeenCalledTimes(2);
    expect(await coordinator.leaseNextCommand()).toBeUndefined();
  });

  it("treats results idempotently and closes when upgrade is observed", async () => {
    const { compose, coordinator } = harness("live");
    await coordinator.startRun({ reason: "schedule" });
    const inspect = await coordinator.leaseNextCommand();
    const result: CommandResult = {
      kind: "inspect",
      quota: { observedAt: "2026-07-19T22:30:00.000Z", state: "upgrade" },
    };
    await coordinator.completeCommand(inspect?.id ?? "", result);
    await coordinator.completeCommand(inspect?.id ?? "", result);
    expect(
      (await coordinator.state()).runs[0]?.history.filter((event) =>
        event.message.includes("Quota"),
      ),
    ).toHaveLength(1);
    expect(compose).not.toHaveBeenCalled();
  });

  it("prepares a guarded live command when initial quota is not observable", async () => {
    const { compose, coordinator } = harness("live");
    await coordinator.startRun({ reason: "schedule" });
    const inspect = await coordinator.leaseNextCommand();
    await coordinator.completeCommand(inspect?.id ?? "", unknown());

    expect(await coordinator.leaseNextCommand()).toMatchObject({
      kind: "create",
      payload: { submit: true },
    });
    expect(compose).toHaveBeenCalledOnce();
  });

  it("stops after an unconfirmed live submission instead of dispatching another click", async () => {
    const { compose, coordinator } = harness("live");
    await coordinator.startRun({ reason: "schedule" });
    const initialInspect = await coordinator.leaseNextCommand();
    await coordinator.completeCommand(initialInspect?.id ?? "", unknown());
    const create = await coordinator.leaseNextCommand();
    await coordinator.completeCommand(create?.id ?? "", {
      kind: "create",
      outcome: "submitted",
    });
    const confirmationInspect = await coordinator.leaseNextCommand();
    await coordinator.completeCommand(confirmationInspect?.id ?? "", unknown());

    expect((await coordinator.state()).runs[0]).toMatchObject({
      completedReason:
        "Post-submission Suno outcome could not be determined; stopped to prevent another click.",
      generationCount: 1,
      status: "failed",
    });
    expect(compose).toHaveBeenCalledOnce();
    expect(await coordinator.leaseNextCommand()).toBeUndefined();
  });

  it("records extension refusal instead of claiming a live submission", async () => {
    const { coordinator } = harness("live");
    await coordinator.startRun({ reason: "manual" });
    const inspect = await coordinator.leaseNextCommand();
    await coordinator.completeCommand(inspect?.id ?? "", available());
    const create = await coordinator.leaseNextCommand();
    await coordinator.completeCommand(create?.id ?? "", {
      details: "Live gate disabled.",
      kind: "create",
      outcome: "drafted",
    });
    expect((await coordinator.state()).runs[0]).toMatchObject({
      completedReason: "extension-live-disabled",
      generationCount: 0,
      status: "completed",
    });
  });

  it("propagates browser failure details to run state", async () => {
    const { coordinator } = harness("draft");
    await coordinator.startRun({ reason: "manual" });
    const inspect = await coordinator.leaseNextCommand();
    await coordinator.completeCommand(inspect?.id ?? "", available());
    const create = await coordinator.leaseNextCommand();
    await coordinator.completeCommand(create?.id ?? "", {
      details: "Style field missing.",
      kind: "create",
      outcome: "failed",
    });
    expect((await coordinator.state()).runs[0]).toMatchObject({
      completedReason: "Style field missing.",
      status: "failed",
    });
  });

  it("leases a queued command to only one concurrent poller", async () => {
    const { coordinator } = harness("observe");
    await coordinator.startRun({ reason: "manual" });
    const leases = await Promise.all([
      coordinator.leaseNextCommand(),
      coordinator.leaseNextCommand(),
    ]);
    expect(leases.filter(Boolean)).toHaveLength(1);
  });

  it("recovers interrupted planning with a fresh safe inspection", async () => {
    const { coordinator, store } = harness("draft");
    await coordinator.startRun({ reason: "schedule" });
    await store.update((state) => {
      const run = state.runs[0];
      const command = state.commands[0];
      if (run === undefined || command === undefined) {
        throw new Error("Fixture must include run and command.");
      }
      run.status = "planning";
      command.status = "completed";
    });

    await expect(coordinator.recoverIncompleteRuns()).resolves.toBe(1);
    expect(await coordinator.leaseNextCommand()).toMatchObject({ kind: "inspect" });
    expect((await coordinator.state()).runs[0]?.history.at(-1)?.message).toMatch(
      /Recovered interrupted planning/u,
    );
  });

  it("recreates a missing inspection command but leaves a pending one alone", async () => {
    const { coordinator, store } = harness("observe");
    await coordinator.startRun({ reason: "schedule" });
    await expect(coordinator.recoverIncompleteRuns()).resolves.toBe(0);
    await store.update((state) => {
      state.commands = [];
    });
    await expect(coordinator.recoverIncompleteRuns()).resolves.toBe(1);
    expect(await coordinator.leaseNextCommand()).toMatchObject({ kind: "inspect" });
  });

  it("stops an ambiguous creation after restart instead of risking a duplicate", async () => {
    const { coordinator, store } = harness("draft");
    await coordinator.startRun({ reason: "manual" });
    const inspect = await coordinator.leaseNextCommand();
    await coordinator.completeCommand(inspect?.id ?? "", available());
    await expect(coordinator.recoverIncompleteRuns()).resolves.toBe(0);
    await store.update((state) => {
      const create = state.commands.find((stored) => stored.command.kind === "create");
      if (create === undefined) {
        throw new Error("Fixture must include create command.");
      }
      create.status = "completed";
    });

    await expect(coordinator.recoverIncompleteRuns()).resolves.toBe(1);
    expect((await coordinator.state()).runs[0]).toMatchObject({
      completedReason:
        "Creation outcome is ambiguous after restart; stopped to prevent a duplicate submission.",
      status: "failed",
    });
  });

  it("rejects unknown commands and result-kind mismatches", async () => {
    const { coordinator } = harness("observe");
    await expect(coordinator.completeCommand("missing", available())).rejects.toThrow(
      "Unknown command",
    );
    await coordinator.startRun({ reason: "manual" });
    const inspect = await coordinator.leaseNextCommand();
    await expect(
      coordinator.completeCommand(inspect?.id ?? "", {
        kind: "create",
        outcome: "drafted",
      }),
    ).rejects.toThrow("does not match");
  });

  it("fails run when songwriter fails without queuing browser work", async () => {
    const { coordinator, compose } = harness("draft");
    compose.mockRejectedValueOnce(new Error("Gemini quota exceeded."));
    await coordinator.startRun({ reason: "manual" });
    const inspect = await coordinator.leaseNextCommand();
    await coordinator.completeCommand(inspect?.id ?? "", available());
    expect((await coordinator.state()).runs[0]).toMatchObject({
      completedReason: "Gemini quota exceeded.",
      status: "failed",
    });
    expect(await coordinator.leaseNextCommand()).toBeUndefined();
  });

  it("does not let force create two concurrent daily reservations", async () => {
    const { coordinator } = harness("live", 1);
    const first = await coordinator.startRun({ force: true, reason: "manual" });
    const second = await coordinator.startRun({ force: true, reason: "manual" });
    expect(second.id).toBe(first.id);
    expect((await coordinator.state()).commands).toHaveLength(1);
  });

  it("cancels a persisted live command after configuration is downgraded", async () => {
    const { coordinator, store } = harness("live", 1);
    await coordinator.startRun({ reason: "manual" });
    const inspect = await coordinator.leaseNextCommand();
    await coordinator.completeCommand(inspect?.id ?? "", available());
    expect((await coordinator.state()).commands.at(-1)?.command).toMatchObject({
      kind: "create",
      payload: { submit: true },
    });

    const resumed = new Coordinator({
      clock: { now: () => new Date("2026-07-19T22:31:00.000Z") },
      config: makeConfig({ maxGenerations: 1, mode: "observe" }),
      random: new SequenceRandom(0, 0),
      songwriter: {
        compose: () => Promise.reject(new Error("Songwriter must not run during recovery.")),
      },
      store,
    });
    await expect(resumed.recoverIncompleteRuns()).resolves.toBe(1);
    expect(await resumed.leaseNextCommand()).toBeUndefined();
    expect((await resumed.state()).runs[0]).toMatchObject({
      completedReason: "Persisted live command cancelled because current mode is observe.",
      status: "failed",
    });
  });
});
