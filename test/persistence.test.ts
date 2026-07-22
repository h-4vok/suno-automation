import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { FileStateStore } from "../src/persistence/state.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("FileStateStore", () => {
  it("serializes concurrent updates without losing either mutation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "suno-state-test-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "nested", "state.json");
    const store = new FileStateStore(path);
    await Promise.all([
      store.update((state) => state.runs.push(run("first"))),
      store.update((state) => state.runs.push(run("second"))),
    ]);
    expect((await store.read()).runs.map(({ id }) => id)).toEqual(["first", "second"]);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ version: 1 });
  });
});

function run(id: string) {
  return {
    generationCount: 0,
    history: [],
    id,
    localDay: "2026-07-19",
    mode: "observe" as const,
    startedAt: "2026-07-19T00:00:00.000Z",
    status: "completed" as const,
    updatedAt: "2026-07-19T00:00:00.000Z",
  };
}
