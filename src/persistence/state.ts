import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { ExtensionCommand, QuotaState } from "../contracts/extension.js";

export type RunStatus =
  "awaiting-inspection" | "planning" | "awaiting-creation" | "completed" | "failed";

export interface RunEvent {
  readonly at: string;
  readonly message: string;
}

export interface RunRecord {
  completedReason?: string;
  generationCount: number;
  history: RunEvent[];
  id: string;
  lastQuota?: QuotaState;
  localDay: string;
  mode: "observe" | "draft" | "live";
  startedAt: string;
  status: RunStatus;
  updatedAt: string;
}

export interface StoredCommand {
  command: ExtensionCommand;
  createdAt: string;
  leaseUntil?: string;
  status: "queued" | "leased" | "completed";
}

export interface AppState {
  commands: StoredCommand[];
  runs: RunRecord[];
  version: 1;
}

export const emptyState = (): AppState => ({ commands: [], runs: [], version: 1 });

export interface StateStore {
  read(): Promise<AppState>;
  update<T>(mutation: (state: AppState) => T | Promise<T>): Promise<T>;
}

export class FileStateStore implements StateStore {
  readonly #path: string;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(path: string) {
    this.#path = resolve(path);
  }

  async read(): Promise<AppState> {
    await this.#queue;
    return structuredClone(await this.#readUnsafe());
  }

  update<T>(mutation: (state: AppState) => T | Promise<T>): Promise<T> {
    const operation = this.#queue.then(async () => {
      const state = await this.#readUnsafe();
      const result = await mutation(state);
      await this.#writeUnsafe(state);
      return result;
    });
    this.#queue = operation.catch(() => undefined);
    return operation;
  }

  async #readUnsafe(): Promise<AppState> {
    try {
      return JSON.parse(await readFile(this.#path, "utf8")) as AppState;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return emptyState();
      }
      throw error;
    }
  }

  async #writeUnsafe(state: AppState): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    const temporaryPath = `${this.#path}.${process.pid.toString()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.#path);
  }
}

export class InMemoryStateStore implements StateStore {
  #state: AppState;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(initialState: AppState = emptyState()) {
    this.#state = structuredClone(initialState);
  }

  async read(): Promise<AppState> {
    await this.#queue;
    return structuredClone(this.#state);
  }

  update<T>(mutation: (state: AppState) => T | Promise<T>): Promise<T> {
    const operation = this.#queue.then(async () => {
      const draft = structuredClone(this.#state);
      const result = await mutation(draft);
      this.#state = draft;
      return result;
    });
    this.#queue = operation.catch(() => undefined);
    return operation;
  }
}
