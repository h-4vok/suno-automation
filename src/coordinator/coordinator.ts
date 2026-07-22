import { randomUUID } from "node:crypto";

import type { AppConfig } from "../config/schema.js";
import type { CommandResult, ExtensionCommand } from "../contracts/extension.js";
import { createGenerationPlan } from "../domain/generation-plan.js";
import type { RandomSource } from "../domain/random.js";
import type { Songwriter } from "../domain/songwriter.js";
import { dayInTimezone, type Clock } from "../domain/time.js";
import type { AppState, RunRecord, StateStore, StoredCommand } from "../persistence/state.js";

const COMMAND_LEASE_MILLISECONDS = 2 * 60 * 1_000;

export interface StartRunOptions {
  readonly force?: boolean;
  readonly reason: "manual" | "schedule";
}

export class Coordinator {
  readonly #clock: Clock;
  readonly #config: AppConfig;
  readonly #random: RandomSource;
  readonly #songwriter: Songwriter;
  readonly #store: StateStore;

  constructor(dependencies: {
    clock: Clock;
    config: AppConfig;
    random: RandomSource;
    songwriter: Songwriter;
    store: StateStore;
  }) {
    this.#clock = dependencies.clock;
    this.#config = dependencies.config;
    this.#random = dependencies.random;
    this.#songwriter = dependencies.songwriter;
    this.#store = dependencies.store;
  }

  state(): Promise<AppState> {
    return this.#store.read();
  }

  async recoverIncompleteRuns(): Promise<number> {
    const timestamp = this.#clock.now().toISOString();
    return this.#store.update((state) => {
      let recovered = this.#cancelUnsafeLiveCommands(state, timestamp);
      for (const run of state.runs) {
        if (run.status === "planning") {
          run.status = "awaiting-inspection";
          run.updatedAt = timestamp;
          run.history.push({
            at: timestamp,
            message: "Recovered interrupted planning by requesting a fresh quota inspection.",
          });
          state.commands.push(this.#inspectCommand(run, timestamp));
          recovered += 1;
          continue;
        }
        if (run.status === "awaiting-inspection" && !hasPendingCommand(state, run.id, "inspect")) {
          state.commands.push(this.#inspectCommand(run, timestamp));
          run.updatedAt = timestamp;
          run.history.push({ at: timestamp, message: "Recovered missing inspection command." });
          recovered += 1;
          continue;
        }
        if (run.status === "awaiting-creation" && !hasPendingCommand(state, run.id, "create")) {
          failRun(
            run,
            timestamp,
            "Creation outcome is ambiguous after restart; stopped to prevent a duplicate submission.",
          );
          recovered += 1;
        }
      }
      return recovered;
    });
  }

  async startRun(options: StartRunOptions): Promise<RunRecord> {
    const now = this.#clock.now();
    const timestamp = now.toISOString();
    const localDay = dayInTimezone(now, this.#config.schedule.timezone);

    return this.#store.update((state) => {
      const active = state.runs.findLast(
        (run) => run.localDay === localDay && run.status !== "completed" && run.status !== "failed",
      );
      if (active !== undefined) {
        return active;
      }
      const existing = state.runs.findLast(
        (run) => run.localDay === localDay && run.status !== "failed",
      );
      if (existing !== undefined && options.force !== true) {
        return existing;
      }

      const run: RunRecord = {
        generationCount: 0,
        history: [{ at: timestamp, message: `Run started by ${options.reason}.` }],
        id: randomUUID(),
        localDay,
        mode: this.#config.automation.mode,
        startedAt: timestamp,
        status: "awaiting-inspection",
        updatedAt: timestamp,
      };
      state.runs.push(run);
      state.commands.push(this.#inspectCommand(run, timestamp));
      return run;
    });
  }

  async leaseNextCommand(): Promise<ExtensionCommand | undefined> {
    const now = this.#clock.now();
    return this.#store.update((state) => {
      this.#cancelUnsafeLiveCommands(state, now.toISOString());
      for (const stored of state.commands) {
        if (
          stored.status === "leased" &&
          stored.leaseUntil !== undefined &&
          Date.parse(stored.leaseUntil) <= now.getTime()
        ) {
          stored.status = "queued";
          delete stored.leaseUntil;
        }
      }
      const next = state.commands.find((command) => command.status === "queued");
      if (next === undefined) {
        return undefined;
      }
      next.status = "leased";
      next.leaseUntil = new Date(now.getTime() + COMMAND_LEASE_MILLISECONDS).toISOString();
      return next.command;
    });
  }

  async completeCommand(commandId: string, result: CommandResult): Promise<void> {
    const state = await this.#store.read();
    const stored = state.commands.find((candidate) => candidate.command.id === commandId);
    if (stored === undefined) {
      throw new Error(`Unknown command ${commandId}.`);
    }
    if (stored.status === "completed") {
      return;
    }
    if (stored.command.kind !== result.kind) {
      throw new Error(`Result kind ${result.kind} does not match ${stored.command.kind}.`);
    }

    if (result.kind === "inspect") {
      await this.#handleInspection(commandId, stored.command.runId, result);
    } else {
      await this.#handleCreation(commandId, stored.command.runId, result);
    }
  }

  async #handleInspection(
    commandId: string,
    runId: string,
    result: Extract<CommandResult, { kind: "inspect" }>,
  ): Promise<void> {
    const shouldCompose = await this.#store.update((state) => {
      const stored = state.commands.find((candidate) => candidate.command.id === commandId);
      if (stored === undefined) {
        throw new Error(`Unknown command ${commandId}.`);
      }
      if (stored.status === "completed") {
        return false;
      }
      stored.status = "completed";
      delete stored.leaseUntil;
      const run = requireRun(state, runId);
      const timestamp = this.#clock.now().toISOString();
      run.lastQuota = result.quota.state;
      run.updatedAt = timestamp;
      run.history.push({
        at: timestamp,
        message: `Quota observed: ${result.quota.state}.${result.quota.details === undefined ? "" : ` ${result.quota.details}`}`,
      });

      if (result.quota.state === "upgrade") {
        completeRun(run, timestamp, "credits-unavailable");
        return false;
      }
      if (run.mode === "observe") {
        completeRun(run, timestamp, "observe-only");
        return false;
      }
      if (result.quota.state === "unknown" && run.generationCount > 0) {
        failRun(
          run,
          timestamp,
          "Post-submission Suno outcome could not be determined; stopped to prevent another click.",
        );
        return false;
      }
      if (
        this.#generationSlotsToday(state, run.localDay) >=
        this.#config.automation.maxGenerationsPerDay
      ) {
        completeRun(run, timestamp, "daily-generation-guard");
        return false;
      }
      run.status = "planning";
      return true;
    });

    if (!shouldCompose) {
      return;
    }

    try {
      const plan = createGenerationPlan(
        {
          instrumentChance: this.#config.automation.instrumentalFeatureChance,
          instruments: this.#config.instruments,
          styles: this.#config.styles,
        },
        this.#random,
      );
      const song = await this.#songwriter.compose(plan);
      const timestamp = this.#clock.now().toISOString();
      await this.#store.update((state) => {
        const run = requireRun(state, runId);
        const command: ExtensionCommand = {
          id: randomUUID(),
          kind: "create",
          payload: {
            draft: {
              instrumental: true,
              lyricsField: song.lyricsField,
              styleField: plan.style.prompt,
              title: song.title,
            },
            submit: run.mode === "live",
          },
          runId,
        };
        state.commands.push({ command, createdAt: timestamp, status: "queued" });
        run.status = "awaiting-creation";
        run.updatedAt = timestamp;
        run.history.push({
          at: timestamp,
          message: `Draft prepared with style ${plan.style.id}${plan.instrument ? ` and ${plan.instrument.id}` : ""}.`,
        });
      });
    } catch (error: unknown) {
      const timestamp = this.#clock.now().toISOString();
      await this.#store.update((state) => {
        failRun(requireRun(state, runId), timestamp, errorMessage(error));
      });
    }
  }

  async #handleCreation(
    commandId: string,
    runId: string,
    result: Extract<CommandResult, { kind: "create" }>,
  ): Promise<void> {
    const timestamp = this.#clock.now().toISOString();
    await this.#store.update((state) => {
      const stored = state.commands.find((candidate) => candidate.command.id === commandId);
      if (stored === undefined) {
        throw new Error(`Unknown command ${commandId}.`);
      }
      if (stored.status === "completed") {
        return;
      }
      stored.status = "completed";
      delete stored.leaseUntil;
      const run = requireRun(state, runId);
      run.updatedAt = timestamp;
      run.history.push({ at: timestamp, message: `Browser outcome: ${result.outcome}.` });

      if (result.outcome === "failed") {
        failRun(run, timestamp, result.details ?? "Browser creation command failed.");
        return;
      }
      if (result.outcome === "drafted") {
        completeRun(
          run,
          timestamp,
          run.mode === "live" ? "extension-live-disabled" : "draft-ready",
        );
        return;
      }

      run.generationCount += 1;
      if (
        this.#generationsToday(state, run.localDay) >= this.#config.automation.maxGenerationsPerDay
      ) {
        completeRun(run, timestamp, "daily-generation-guard");
        return;
      }
      run.status = "awaiting-inspection";
      state.commands.push(this.#inspectCommand(run, timestamp));
    });
  }

  #generationsToday(state: AppState, localDay: string): number {
    return state.runs
      .filter((run) => run.localDay === localDay)
      .reduce((sum, run) => sum + run.generationCount, 0);
  }

  #generationSlotsToday(state: AppState, localDay: string): number {
    const pendingLiveCommands = state.commands.filter((stored) => {
      if (
        stored.status === "completed" ||
        stored.command.kind !== "create" ||
        !stored.command.payload.submit
      ) {
        return false;
      }
      return state.runs.some((run) => run.id === stored.command.runId && run.localDay === localDay);
    }).length;
    return this.#generationsToday(state, localDay) + pendingLiveCommands;
  }

  #cancelUnsafeLiveCommands(state: AppState, timestamp: string): number {
    if (this.#config.automation.mode === "live") {
      return 0;
    }
    let cancelled = 0;
    for (const stored of state.commands) {
      if (
        stored.status === "completed" ||
        stored.command.kind !== "create" ||
        !stored.command.payload.submit
      ) {
        continue;
      }
      stored.status = "completed";
      delete stored.leaseUntil;
      const run = state.runs.find((candidate) => candidate.id === stored.command.runId);
      if (run !== undefined && run.status !== "completed" && run.status !== "failed") {
        failRun(
          run,
          timestamp,
          `Persisted live command cancelled because current mode is ${this.#config.automation.mode}.`,
        );
      }
      cancelled += 1;
    }
    return cancelled;
  }

  #inspectCommand(run: RunRecord, timestamp: string): StoredCommand {
    return {
      command: {
        id: randomUUID(),
        kind: "inspect",
        payload: { expectedMode: run.mode },
        runId: run.id,
      },
      createdAt: timestamp,
      status: "queued",
    };
  }
}

function requireRun(state: AppState, runId: string): RunRecord {
  const run = state.runs.find((candidate) => candidate.id === runId);
  if (run === undefined) {
    throw new Error(`Unknown run ${runId}.`);
  }
  return run;
}

function hasPendingCommand(
  state: AppState,
  runId: string,
  kind: ExtensionCommand["kind"],
): boolean {
  return state.commands.some(
    (stored) =>
      stored.command.runId === runId &&
      stored.command.kind === kind &&
      stored.status !== "completed",
  );
}

function completeRun(run: RunRecord, timestamp: string, reason: string): void {
  run.completedReason = reason;
  run.status = "completed";
  run.updatedAt = timestamp;
  run.history.push({ at: timestamp, message: `Run completed: ${reason}.` });
}

function failRun(run: RunRecord, timestamp: string, message: string): void {
  run.completedReason = message;
  run.status = "failed";
  run.updatedAt = timestamp;
  run.history.push({ at: timestamp, message: `Run failed: ${message}` });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
