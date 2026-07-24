import { randomUUID } from "node:crypto";
import { open, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { parse } from "yaml";

import {
  emptyLoopState,
  LoopConfigSchema,
  LoopStateSchema,
  type LoopConfig,
  type LoopState,
} from "./schema.js";

export interface LoopStateStore {
  read(): Promise<LoopState>;
  update<T>(mutation: (state: LoopState) => Promise<T> | T): Promise<T>;
}

export class MalformedLoopStateError extends Error {
  constructor() {
    super("Loop state is malformed; evidence was preserved.");
    this.name = "MalformedLoopStateError";
  }
}

export class InvalidLoopConfigError extends Error {
  constructor() {
    super("Codex loop config is unavailable or invalid.");
    this.name = "InvalidLoopConfigError";
  }
}

export class StateUpdateBusyError extends Error {
  constructor() {
    super("Loop state update lock is busy; no state was changed.");
    this.name = "StateUpdateBusyError";
  }
}

export class StateUpdateOwnershipError extends Error {
  constructor() {
    super("Loop state update lock ownership changed; evidence was preserved.");
    this.name = "StateUpdateOwnershipError";
  }
}

interface StateUpdateLockDocument {
  readonly expiresAt: string;
  readonly ownerPid: number;
  readonly token: string;
  readonly version: 1;
}

function parseStateUpdateLock(contents: string): StateUpdateLockDocument {
  let value: Partial<StateUpdateLockDocument>;
  try {
    value = JSON.parse(contents) as Partial<StateUpdateLockDocument>;
  } catch {
    throw new MalformedLoopStateError();
  }
  if (
    value.version !== 1 ||
    typeof value.ownerPid !== "number" ||
    typeof value.token !== "string" ||
    typeof value.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(value.expiresAt))
  ) {
    throw new MalformedLoopStateError();
  }
  return value as StateUpdateLockDocument;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

export async function loadLoopConfig(path: string): Promise<LoopConfig> {
  try {
    const contents = await readFile(resolve(path), "utf8");
    const parsed = LoopConfigSchema.safeParse(parse(contents));
    if (!parsed.success) throw new InvalidLoopConfigError();
    return parsed.data;
  } catch (error: unknown) {
    if (error instanceof InvalidLoopConfigError) throw error;
    throw new InvalidLoopConfigError();
  }
}

export function resolveLoopStatePath(config: LoopConfig, configPath: string): string {
  const directory = isAbsolute(config.stateDirectory)
    ? config.stateDirectory
    : resolve(dirname(resolve(configPath)), config.stateDirectory);
  return resolve(directory, "state.json");
}

export class FileLoopStateStore implements LoopStateStore {
  readonly #path: string;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(path: string) {
    this.#path = resolve(path);
  }

  async read(): Promise<LoopState> {
    await this.#queue;
    return structuredClone(await this.#readUnsafe());
  }

  update<T>(mutation: (state: LoopState) => Promise<T> | T): Promise<T> {
    const operation = this.#queue.then(() =>
      this.#withUpdateLock(async () => {
        const state = await this.#readUnsafe();
        const result = await mutation(state);
        const parsed = LoopStateSchema.parse(state);
        await this.#writeUnsafe(parsed);
        return result;
      }),
    );
    this.#queue = operation.catch(() => undefined);
    return operation;
  }

  async #readUnsafe(): Promise<LoopState> {
    let contents: string;
    try {
      contents = await readFile(this.#path, "utf8");
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyLoopState();
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(contents);
    } catch {
      throw new MalformedLoopStateError();
    }
    const parsed = LoopStateSchema.safeParse(value);
    if (!parsed.success) throw new MalformedLoopStateError();
    return parsed.data;
  }

  async #writeUnsafe(state: LoopState): Promise<void> {
    await mkdir(dirname(this.#path), { mode: 0o700, recursive: true });
    const temporaryPath = `${this.#path}.${process.pid.toString()}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.#path);
  }

  async #withUpdateLock<T>(operation: () => Promise<T>): Promise<T> {
    const lockPath = `${this.#path}.update.lock`;
    await mkdir(dirname(this.#path), { mode: 0o700, recursive: true });
    const token = randomUUID();
    await this.#acquireUpdateLock(lockPath, token);
    try {
      return await operation();
    } finally {
      await this.#releaseUpdateLock(lockPath, token);
    }
  }

  async #acquireUpdateLock(lockPath: string, token: string): Promise<void> {
    const maximumAttempts = 200;
    for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
      const document: StateUpdateLockDocument = {
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
        ownerPid: process.pid,
        token,
        version: 1,
      };
      try {
        const handle = await open(lockPath, "wx", 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(document)}\n`, "utf8");
        } finally {
          await handle.close();
        }
        return;
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }

      let existing: StateUpdateLockDocument;
      try {
        existing = parseStateUpdateLock(await readFile(lockPath, "utf8"));
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (Date.parse(existing.expiresAt) <= Date.now() && !isProcessAlive(existing.ownerPid)) {
        const stalePath = `${lockPath}.stale.${existing.token}.${Date.now().toString()}`;
        try {
          await rename(lockPath, stalePath);
          continue;
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
      }
      await wait(Math.min(50, 5 + attempt));
    }
    throw new StateUpdateBusyError();
  }

  async #releaseUpdateLock(lockPath: string, token: string): Promise<void> {
    let existing: StateUpdateLockDocument;
    try {
      existing = parseStateUpdateLock(await readFile(lockPath, "utf8"));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (existing.token !== token) throw new StateUpdateOwnershipError();
    await rm(lockPath, { force: true });
  }
}

export class InMemoryLoopStateStore implements LoopStateStore {
  #state: LoopState;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(initial: LoopState = emptyLoopState()) {
    this.#state = LoopStateSchema.parse(structuredClone(initial));
  }

  async read(): Promise<LoopState> {
    await this.#queue;
    return structuredClone(this.#state);
  }

  update<T>(mutation: (state: LoopState) => Promise<T> | T): Promise<T> {
    const operation = this.#queue.then(async () => {
      const draft = structuredClone(this.#state);
      const result = await mutation(draft);
      this.#state = LoopStateSchema.parse(draft);
      return result;
    });
    this.#queue = operation.catch(() => undefined);
    return operation;
  }
}

export interface DispatcherMutex {
  runExclusive<T>(operation: () => Promise<T>): Promise<T>;
}

interface MutexDocument {
  readonly expiresAt: string;
  readonly ownerPid: number;
  readonly token: string;
  readonly version: 1;
}

export class MutexBusyError extends Error {
  constructor() {
    super("Dispatcher mutex is already held.");
    this.name = "MutexBusyError";
  }
}

function parseMutexDocument(contents: string): MutexDocument {
  const value = JSON.parse(contents) as Partial<MutexDocument>;
  if (
    value.version !== 1 ||
    typeof value.ownerPid !== "number" ||
    typeof value.token !== "string" ||
    typeof value.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(value.expiresAt))
  ) {
    throw new Error("Dispatcher mutex is malformed; evidence was preserved.");
  }
  return value as MutexDocument;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class FileDispatcherMutex implements DispatcherMutex {
  readonly #path: string;
  readonly #now: () => Date;
  readonly #ttlMs: number;

  constructor(path: string, ttlSeconds: number, now: () => Date = () => new Date()) {
    this.#path = resolve(path);
    this.#ttlMs = ttlSeconds * 1_000;
    this.#now = now;
  }

  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.#path), { recursive: true });
    const token = randomUUID();
    await this.#acquire(token);
    try {
      return await operation();
    } finally {
      await this.#release(token);
    }
  }

  async #acquire(token: string): Promise<void> {
    const document: MutexDocument = {
      expiresAt: new Date(this.#now().getTime() + this.#ttlMs).toISOString(),
      ownerPid: process.pid,
      token,
      version: 1,
    };
    try {
      const handle = await open(this.#path, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(document)}\n`, "utf8");
      await handle.close();
      return;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    const existing = parseMutexDocument(await readFile(this.#path, "utf8"));
    if (
      Date.parse(existing.expiresAt) > this.#now().getTime() ||
      isProcessAlive(existing.ownerPid)
    ) {
      throw new MutexBusyError();
    }

    const evidencePath = `${this.#path}.stale.${existing.token}.${this.#now().getTime().toString()}`;
    try {
      await rename(this.#path, evidencePath);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new MutexBusyError();
      throw error;
    }
    try {
      const handle = await open(this.#path, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(document)}\n`, "utf8");
      await handle.close();
    } catch {
      throw new MutexBusyError();
    }
  }

  async #release(token: string): Promise<void> {
    let existing: MutexDocument;
    try {
      existing = parseMutexDocument(await readFile(this.#path, "utf8"));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (existing.token !== token) {
      throw new Error("Dispatcher mutex ownership changed; release refused.");
    }
    await rm(this.#path);
  }
}

export class InMemoryDispatcherMutex implements DispatcherMutex {
  #active = false;

  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#active) throw new MutexBusyError();
    this.#active = true;
    try {
      return await operation();
    } finally {
      this.#active = false;
    }
  }
}
