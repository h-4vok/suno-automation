import { describe, expect, it } from "vitest";

import { reserveLiveAttempt, type AttemptStorage } from "../extension/src/live-attempt-guard.js";

class MemoryAttemptStorage implements AttemptStorage {
  readonly values: Record<string, unknown> = {};

  get(): Promise<Record<string, unknown>> {
    return Promise.resolve({ ...this.values });
  }

  set(items: Record<string, unknown>): Promise<void> {
    Object.assign(this.values, items);
    return Promise.resolve();
  }
}

describe("live attempt guard", () => {
  it("reserves each live command at most once across retries", async () => {
    const storage = new MemoryAttemptStorage();
    await expect(reserveLiveAttempt(storage, "command-1")).resolves.toBe(true);
    await expect(reserveLiveAttempt(storage, "command-1")).resolves.toBe(false);
  });

  it("keeps bounded persistent history", async () => {
    const storage = new MemoryAttemptStorage();
    await reserveLiveAttempt(storage, "one", 2);
    await reserveLiveAttempt(storage, "two", 2);
    await reserveLiveAttempt(storage, "three", 2);
    expect(storage.values.attemptedLiveCommandIds).toEqual(["two", "three"]);
    await expect(reserveLiveAttempt(storage, "one", 2)).resolves.toBe(true);
  });

  it("ignores corrupt stored values safely", async () => {
    const storage = new MemoryAttemptStorage();
    storage.values.attemptedLiveCommandIds = { unexpected: true };
    await expect(reserveLiveAttempt(storage, "fresh")).resolves.toBe(true);
  });
});
