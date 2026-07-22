import { describe, expect, it, vi } from "vitest";

import { dispatchCommand } from "../extension/src/command-dispatch.js";
import type { ExtensionCommand } from "../src/contracts/extension.js";

describe("extension command dispatch", () => {
  it("never retries an ambiguous live send even when the response is lost", async () => {
    let externalExecutions = 0;
    const send = vi.fn(() => {
      externalExecutions += 1;
      return Promise.reject(new Error("Response channel closed after content execution."));
    });
    const pause = vi.fn(() => Promise.resolve());
    await expect(dispatchCommand(liveCommand(), send, pause)).rejects.toThrow("channel closed");
    expect(externalExecutions).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(pause).not.toHaveBeenCalled();
  });

  it("retries safe inspection messages when content script is still loading", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("No receiver"))
      .mockResolvedValueOnce({
        kind: "inspect",
        quota: { observedAt: "2026-07-19T22:30:00.000Z", state: "available" },
      });
    const result = await dispatchCommand(
      {
        id: "inspect-1",
        kind: "inspect",
        payload: { expectedMode: "observe" },
        runId: "run-1",
      },
      send,
      () => Promise.resolve(),
    );
    expect(result.kind).toBe("inspect");
    expect(send).toHaveBeenCalledTimes(2);
  });
});

function liveCommand(): ExtensionCommand {
  return {
    id: "create-1",
    kind: "create",
    payload: {
      draft: {
        instrumental: true,
        lyricsField: "[Intro: strings]",
        styleField: "Instrumental tango.",
        title: "Test",
      },
      submit: true,
    },
    runId: "run-1",
  };
}
