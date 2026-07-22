import { describe, expect, it, vi } from "vitest";

import { executeBrowserCommand } from "../extension/src/command-executor.js";
import type { ExtensionCommand } from "../src/contracts/extension.js";

const liveCommand: ExtensionCommand = {
  id: "live-1",
  kind: "create",
  payload: {
    draft: {
      instrumental: true,
      lyricsField: "[Intro: strings]\n[Finale: ensemble]",
      styleField: "Tango",
      title: "Night",
    },
    submit: true,
  },
  runId: "run-1",
};

describe("browser command executor", () => {
  it("never sends a persisted live command twice after an ambiguous first attempt", async () => {
    const reservations = new Set<string>();
    const send = vi.fn().mockRejectedValue(new Error("response channel closed after execution"));
    const dependencies = {
      getTabId: () => Promise.resolve(7),
      pause: () => Promise.resolve(),
      reserveLiveAttempt: (id: string) => {
        if (reservations.has(id)) return Promise.resolve(false);
        reservations.add(id);
        return Promise.resolve(true);
      },
      send,
    };

    await expect(executeBrowserCommand(liveCommand, dependencies)).rejects.toThrow(
      "response channel closed",
    );
    await expect(executeBrowserCommand(liveCommand, dependencies)).resolves.toMatchObject({
      outcome: "failed",
    });
    expect(send).toHaveBeenCalledTimes(1);
  });
});
