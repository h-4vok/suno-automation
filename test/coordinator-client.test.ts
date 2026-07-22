import { describe, expect, it, vi } from "vitest";

import {
  checkCoordinatorConnection,
  CoordinatorUnavailableError,
  reportPollFailure,
} from "../extension/src/coordinator-client.js";

describe("extension coordinator client", () => {
  it("classifies a rejected localhost request as offline", async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));

    await expect(
      checkCoordinatorConnection("http://127.0.0.1:4317", "test-token", fetcher),
    ).resolves.toEqual({ state: "offline" });
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:4317/api/v1/status",
      expect.objectContaining({
        headers: { Authorization: "Bearer test-token" },
      }),
    );
  });

  it("distinguishes a token mismatch from an unavailable server", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));

    await expect(
      checkCoordinatorConnection("http://127.0.0.1:4317", "wrong-token", fetcher),
    ).resolves.toEqual({ state: "unauthorized" });
  });

  it("does not call the network without a token", async () => {
    const fetcher = vi.fn();

    await expect(checkCoordinatorConnection("http://127.0.0.1:4317", "", fetcher)).resolves.toEqual(
      { state: "missing-token" },
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reports a reachable authenticated coordinator", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));

    await expect(
      checkCoordinatorConnection("http://127.0.0.1:4317", "test-token", fetcher),
    ).resolves.toEqual({ state: "connected" });
  });

  it("preserves an unexpected coordinator status for the UI", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));

    await expect(
      checkCoordinatorConnection("http://127.0.0.1:4317/", "test-token", fetcher),
    ).resolves.toEqual({ state: "error", status: 503 });
    expect(fetcher).toHaveBeenCalledWith("http://127.0.0.1:4317/api/v1/status", expect.any(Object));
  });

  it("keeps an unavailable coordinator out of Brave's extension error list", () => {
    const logger = { error: vi.fn(), info: vi.fn() };

    reportPollFailure(new CoordinatorUnavailableError(new TypeError("Failed to fetch")), logger);

    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      "Suno coordinator is offline; the extension will retry automatically.",
    );
  });

  it("still surfaces unexpected polling defects as extension errors", () => {
    const logger = { error: vi.fn(), info: vi.fn() };
    const defect = new Error("Malformed coordinator response");

    reportPollFailure(defect, logger);

    expect(logger.error).toHaveBeenCalledWith("Suno assistant poll failed", defect);
  });
});
