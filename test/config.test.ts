import { describe, expect, it } from "vitest";

import { AppConfigSchema } from "../src/config/schema.js";
import { makeConfig } from "./support/fixtures.js";

describe("AppConfigSchema", () => {
  it("defaults to observe mode", () => {
    const base = makeConfig();
    const parsed = AppConfigSchema.parse({
      ...base,
      automation: {
        instrumentalFeatureChance: base.automation.instrumentalFeatureChance,
        maxGenerationsPerDay: base.automation.maxGenerationsPerDay,
      },
    });
    expect(parsed.automation.mode).toBe("observe");
  });

  it("accepts equal weights without requiring a ranking", () => {
    const base = makeConfig();
    const parsed = AppConfigSchema.parse({
      ...base,
      styles: [base.styles[0], { ...base.styles[0], id: "second" }],
    });
    expect(parsed.styles.map(({ weight }) => weight)).toEqual([1, 1]);
  });

  it("rejects configurations that can never select a style", () => {
    const base = makeConfig();
    expect(() =>
      AppConfigSchema.parse({ ...base, styles: [{ ...base.styles[0], weight: 0 }] }),
    ).toThrow("positive weight");
  });

  it("requires selectable instruments only for positive feature chance", () => {
    const base = makeConfig();
    expect(() =>
      AppConfigSchema.parse({
        ...base,
        automation: { ...base.automation, instrumentalFeatureChance: 0.1 },
        instruments: [],
      }),
    ).toThrow("requires an instrument");
    expect(
      AppConfigSchema.parse({
        ...base,
        automation: { ...base.automation, instrumentalFeatureChance: 0 },
        instruments: [],
      }).instruments,
    ).toEqual([]);
  });
});
