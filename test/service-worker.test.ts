import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface ChromeHarness {
  readonly createTab: ReturnType<typeof vi.fn>;
  readonly fetcher: ReturnType<typeof vi.fn>;
  readonly getSettings: ReturnType<typeof vi.fn>;
  readonly onMessage: (
    message: unknown,
    sender: unknown,
    respond: (value: unknown) => void,
  ) => boolean;
  readonly queryTabs: ReturnType<typeof vi.fn>;
  readonly sendTabMessage: ReturnType<typeof vi.fn>;
}

describe("extension service worker polling", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("routes a popup poll-now message to the coordinator without touching Suno when no command is leased", async () => {
    const harness = await loadServiceWorker();
    harness.getSettings.mockResolvedValue(settings("test-token"));
    harness.fetcher.mockResolvedValue(new Response(null, { status: 204 }));
    const respond = vi.fn();

    expect(harness.onMessage({ kind: "poll-now" }, {}, respond)).toBe(true);

    await vi.waitFor(() => {
      expect(harness.fetcher).toHaveBeenCalledWith(
        "http://127.0.0.1:4317/api/v1/extension/commands/next",
        expect.any(Object),
      );
    });
    expect(respond).toHaveBeenCalledWith({ accepted: true });
    expect(harness.queryTabs).not.toHaveBeenCalled();
    expect(harness.createTab).not.toHaveBeenCalled();
  });

  it("treats a stopped coordinator as an expected retry condition in the real worker", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const harness = await loadServiceWorker();
    harness.getSettings.mockResolvedValue(settings("test-token"));
    harness.fetcher.mockRejectedValue(new TypeError("Failed to fetch"));

    harness.onMessage({ kind: "poll-now" }, {}, vi.fn());

    await vi.waitFor(() => {
      expect(info).toHaveBeenCalledWith(
        "Suno coordinator is offline; the extension will retry automatically.",
      );
    });
    expect(error).not.toHaveBeenCalled();
  });

  it("still reports unexpected worker defects to Brave", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const harness = await loadServiceWorker();
    const defect = new Error("settings storage failed");
    harness.getSettings.mockRejectedValue(defect);

    harness.onMessage({ kind: "poll-now" }, {}, vi.fn());

    await vi.waitFor(() => {
      expect(error).toHaveBeenCalledWith("Suno assistant poll failed", defect);
    });
  });

  it("opens the exact background Create route only after the coordinator returns an inspect command", async () => {
    const harness = await loadServiceWorker();
    harness.getSettings.mockResolvedValue(settings("test-token"));
    let releaseLease: ((response: Response) => void) | undefined;
    harness.fetcher.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          releaseLease = resolve;
        }),
    );
    harness.fetcher.mockResolvedValueOnce(new Response(null, { status: 202 }));
    harness.queryTabs.mockResolvedValue([{ id: 4, url: "https://suno.com/home" }]);
    harness.createTab.mockResolvedValue({
      id: 12,
      status: "complete",
      url: "https://suno.com/create",
    });
    harness.sendTabMessage.mockResolvedValue({
      kind: "inspect",
      quota: { observedAt: "2026-07-22T12:00:00.000Z", state: "unknown" },
    });

    harness.onMessage({ kind: "poll-now" }, {}, vi.fn());
    await vi.waitFor(() => expect(releaseLease).toBeTypeOf("function"));
    expect(harness.queryTabs).not.toHaveBeenCalled();
    expect(harness.createTab).not.toHaveBeenCalled();

    releaseLease?.(
      new Response(
        JSON.stringify({
          command: {
            attempt: 1,
            id: "00000000-0000-4000-8000-000000000001",
            kind: "inspect",
            leaseUntil: "2026-07-22T12:00:00.000Z",
          },
        }),
        { headers: { "Content-Type": "application/json" }, status: 200 },
      ),
    );

    await vi.waitFor(() => {
      expect(harness.createTab).toHaveBeenCalledWith({
        active: false,
        url: "https://suno.com/create",
      });
    });
    expect(harness.queryTabs).toHaveBeenCalledOnce();
    expect(harness.sendTabMessage).toHaveBeenCalledWith(
      12,
      expect.objectContaining({ kind: "inspect" }),
    );
  });
});

async function loadServiceWorker(): Promise<ChromeHarness> {
  let onMessage:
    ((message: unknown, sender: unknown, respond: (value: unknown) => void) => boolean) | undefined;
  const getSettings = vi.fn().mockResolvedValue(settings(""));
  const queryTabs = vi.fn();
  const createTab = vi.fn();
  const sendTabMessage = vi.fn();
  const fetcher = vi.fn();

  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("chrome", {
    alarms: {
      create: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue({ name: "poll-coordinator" }),
      onAlarm: { addListener: vi.fn() },
    },
    runtime: {
      onInstalled: { addListener: vi.fn() },
      onMessage: {
        addListener: vi.fn((listener: Exclude<typeof onMessage, undefined>) => {
          onMessage = listener;
        }),
      },
      onStartup: { addListener: vi.fn() },
    },
    storage: {
      local: { get: vi.fn(), set: vi.fn() },
      sync: { get: getSettings },
    },
    tabs: {
      create: createTab,
      get: vi.fn().mockResolvedValue({ id: 12, status: "complete" }),
      query: queryTabs,
      sendMessage: sendTabMessage,
    },
  });

  await import("../extension/src/service-worker.js");
  await vi.waitFor(() => expect(getSettings).toHaveBeenCalled());
  await new Promise((resolve) => setImmediate(resolve));
  if (onMessage === undefined) {
    throw new Error("Service worker did not register its message listener.");
  }
  return { createTab, fetcher, getSettings, onMessage, queryTabs, sendTabMessage };
}

function settings(token: string): {
  allowLiveSubmissions: boolean;
  baseUrl: string;
  token: string;
} {
  return { allowLiveSubmissions: false, baseUrl: "http://127.0.0.1:4317", token };
}
