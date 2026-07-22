import { describe, expect, it, vi } from "vitest";

import { getOrCreateSunoCreateTab, SUNO_CREATE_URL } from "../extension/src/suno-tab.js";

describe("Suno Create tab selection", () => {
  it("prefers an existing Create tab over another Suno page", async () => {
    const create = vi.fn();
    const waitForComplete = vi.fn().mockResolvedValue(undefined);

    await expect(
      getOrCreateSunoCreateTab({
        create,
        query: vi.fn().mockResolvedValue([
          { id: 4, status: "complete", url: "https://suno.com/me" },
          { id: 9, status: "complete", url: "https://suno.com/create" },
        ]),
        waitForComplete,
      }),
    ).resolves.toBe(9);
    expect(create).not.toHaveBeenCalled();
    expect(waitForComplete).toHaveBeenCalledWith(9);
  });

  it("opens a background Create tab instead of inspecting an unrelated Suno page", async () => {
    const create = vi.fn().mockResolvedValue({ id: 12, url: SUNO_CREATE_URL });
    const waitForComplete = vi.fn().mockResolvedValue(undefined);

    await expect(
      getOrCreateSunoCreateTab({
        create,
        query: vi
          .fn()
          .mockResolvedValue([{ id: 4, status: "complete", url: "https://suno.com/home" }]),
        waitForComplete,
      }),
    ).resolves.toBe(12);
    expect(create).toHaveBeenCalledWith({ active: false, url: SUNO_CREATE_URL });
    expect(waitForComplete).toHaveBeenCalledWith(12);
  });

  it("reuses the www Create route with a trailing slash and query string", async () => {
    const create = vi.fn();
    const waitForComplete = vi.fn().mockResolvedValue(undefined);

    await expect(
      getOrCreateSunoCreateTab({
        create,
        query: vi.fn().mockResolvedValue([{ id: 7, url: "https://www.suno.com/create/?ref=test" }]),
        waitForComplete,
      }),
    ).resolves.toBe(7);
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects lookalike hosts and nested routes", async () => {
    const create = vi.fn().mockResolvedValue({ id: 14, url: SUNO_CREATE_URL });

    await expect(
      getOrCreateSunoCreateTab({
        create,
        query: vi.fn().mockResolvedValue([
          { id: 5, url: "https://suno.com.example.test/create" },
          { id: 6, url: "https://suno.com/create/song" },
        ]),
        waitForComplete: vi.fn().mockResolvedValue(undefined),
      }),
    ).resolves.toBe(14);
    expect(create).toHaveBeenCalledWith({ active: false, url: SUNO_CREATE_URL });
  });

  it("fails closed when Brave does not return a tab id", async () => {
    await expect(
      getOrCreateSunoCreateTab({
        create: vi.fn().mockResolvedValue({ url: SUNO_CREATE_URL }),
        query: vi.fn().mockResolvedValue([]),
        waitForComplete: vi.fn(),
      }),
    ).rejects.toThrow("tab id");
  });
});
