import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultSettings, loadSettings } from "../extension/src/settings.js";

describe("extension settings", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults both storage and live submissions to safe values", async () => {
    const get = vi.fn((defaults: Record<string, unknown>) => Promise.resolve(defaults));
    vi.stubGlobal("chrome", { storage: { sync: { get } } });
    await expect(loadSettings()).resolves.toEqual(defaultSettings);
    expect(defaultSettings.allowLiveSubmissions).toBe(false);
  });

  it("treats corrupt or merely truthy live settings as disabled", async () => {
    const get = vi.fn().mockResolvedValue({
      allowLiveSubmissions: "true",
      baseUrl: 17,
      token: null,
    });
    vi.stubGlobal("chrome", { storage: { sync: { get } } });
    await expect(loadSettings()).resolves.toEqual(defaultSettings);
  });
});
