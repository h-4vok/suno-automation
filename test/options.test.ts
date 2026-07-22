// @vitest-environment happy-dom

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const optionsHtml = await readFile(resolve(process.cwd(), "extension/options.html"), "utf8");
const optionsBody = /<body>([\s\S]*?)<\/body>/u
  .exec(optionsHtml)?.[1]
  ?.replace(/<script[\s\S]*?<\/script>/gu, "");
if (optionsBody === undefined) {
  throw new Error("Could not read the options page body.");
}

describe("extension options connection status", () => {
  beforeEach(() => {
    vi.resetModules();
    document.body.innerHTML = optionsBody;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows a connected coordinator and requests an immediate poll", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ accepted: true });
    stubChrome(sendMessage);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 200 })));

    await import("../extension/src/options.js");

    await vi.waitFor(() => {
      expect(output().value).toBe("Coordinator connected. Poll requested.");
    });
    expect(output().dataset.state).toBe("connected");
    expect(sendMessage).toHaveBeenCalledWith({ kind: "poll-now" });
    expect(document.querySelector("#packageVersion")?.textContent).toContain("v0.1.5");
  });

  it("shows an offline coordinator without requesting browser work", async () => {
    const sendMessage = vi.fn();
    stubChrome(sendMessage);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    await import("../extension/src/options.js");

    await vi.waitFor(() => {
      expect(output().value).toContain("Coordinator offline");
    });
    expect(output().dataset.state).toBe("offline");
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

function stubChrome(sendMessage: ReturnType<typeof vi.fn>): void {
  vi.stubGlobal("chrome", {
    runtime: { getManifest: () => ({ version: "0.1.5" }), sendMessage },
    storage: {
      sync: {
        get: vi.fn().mockResolvedValue({
          allowLiveSubmissions: false,
          baseUrl: "http://127.0.0.1:4317",
          token: "test-token",
        }),
        set: vi.fn().mockResolvedValue(undefined),
      },
    },
  });
}

function output(): HTMLOutputElement {
  const element = document.querySelector("#status");
  if (!(element instanceof HTMLOutputElement)) {
    throw new Error("Missing status output.");
  }
  return element;
}
