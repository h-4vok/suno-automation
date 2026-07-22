import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("extension action", () => {
  it("opens the configuration UI when the toolbar icon is clicked", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../extension/manifest.json", import.meta.url), "utf8"),
    ) as { action?: { default_popup?: string }; options_page?: string };

    expect(manifest.options_page).toBe("options.html");
    expect(manifest.action?.default_popup).toBe("options.html");
  });
});
