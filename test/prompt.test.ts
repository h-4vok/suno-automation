import { describe, expect, it } from "vitest";

import { buildSongRequest, SONGWRITER_SYSTEM_INSTRUCTION } from "../src/gemini/prompt.js";
import { makeConfig } from "./support/fixtures.js";

describe("Gemini prompt", () => {
  it("keeps instrumental and bracket-only constraints in system and request", () => {
    const config = makeConfig();
    const style = config.styles[0];
    const instrument = config.instruments[0];
    if (style === undefined || instrument === undefined) {
      throw new Error("Fixture must include style and instrument.");
    }
    const prompt = buildSongRequest({ instrument, style });
    expect(SONGWRITER_SYSTEM_INSTRUCTION).toMatch(/strictly instrumental/iu);
    expect(SONGWRITER_SYSTEM_INSTRUCTION).toMatch(/Never write lyrics/iu);
    expect(prompt).toContain(config.styles[0]?.prompt);
    expect(prompt).toContain(config.instruments[0]?.instruction);
    expect(prompt).toMatch(/Put no text outside brackets/iu);
  });

  it("states explicitly when no feature instrument was selected", () => {
    const config = makeConfig();
    const style = config.styles[0];
    if (style === undefined) {
      throw new Error("Fixture must include style.");
    }
    expect(buildSongRequest({ style })).toMatch(/No optional feature instrument/iu);
  });
});
