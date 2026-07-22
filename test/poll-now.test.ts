import { describe, expect, it, vi } from "vitest";

import { handlePollNowMessage } from "../extension/src/poll-now.js";

describe("immediate extension poll", () => {
  it("starts a poll and acknowledges the popup request", () => {
    const poll = vi.fn().mockResolvedValue(undefined);
    const sendResponse = vi.fn();

    expect(handlePollNowMessage({ kind: "poll-now" }, poll, sendResponse)).toBe(true);
    expect(poll).toHaveBeenCalledOnce();
    expect(sendResponse).toHaveBeenCalledWith({ accepted: true });
  });

  it("ignores unrelated or malformed extension messages", () => {
    const poll = vi.fn();
    const sendResponse = vi.fn();

    for (const message of [undefined, null, "poll-now", {}, { kind: "other" }]) {
      expect(handlePollNowMessage(message, poll, sendResponse)).toBe(false);
    }
    expect(poll).not.toHaveBeenCalled();
    expect(sendResponse).not.toHaveBeenCalled();
  });
});
