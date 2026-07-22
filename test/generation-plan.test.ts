import { describe, expect, it } from "vitest";

import { createGenerationPlan } from "../src/domain/generation-plan.js";
import type { InstrumentPreset, StylePreset } from "../src/domain/types.js";
import { SequenceRandom } from "./support/fixtures.js";

const styles: StylePreset[] = [
  { enabled: false, id: "off", name: "Off", prompt: "Disabled style prompt.", weight: 100 },
  { enabled: true, id: "on", name: "On", prompt: "Enabled style prompt.", weight: 1 },
];
const instruments: InstrumentPreset[] = [
  { id: "sax", instruction: "Add a saxophone solo section.", name: "sax", weight: 1 },
];

describe("createGenerationPlan", () => {
  it("selects only enabled styles and omits instrument when chance misses", () => {
    const plan = createGenerationPlan(
      { instrumentChance: 0.25, instruments, styles },
      new SequenceRandom(0, 0.25),
    );
    expect(plan).toEqual({ style: styles[1] });
  });

  it("uses strict chance boundary and then weighted instrument", () => {
    const plan = createGenerationPlan(
      { instrumentChance: 0.25, instruments, styles },
      new SequenceRandom(0, 0.249_999, 0),
    );
    expect(plan.instrument?.id).toBe("sax");
  });

  it("allows no instruments only when chance does not select one", () => {
    expect(
      createGenerationPlan(
        { instrumentChance: 0, instruments: [], styles },
        new SequenceRandom(0, 0),
      ),
    ).toEqual({ style: styles[1] });
    expect(() =>
      createGenerationPlan(
        { instrumentChance: 1, instruments: [], styles },
        new SequenceRandom(0, 0),
      ),
    ).toThrow("no instruments");
  });

  it.each([-0.01, 1.01])("rejects chance outside [0,1]: %s", (instrumentChance) => {
    expect(() =>
      createGenerationPlan({ instrumentChance, instruments, styles }, new SequenceRandom(0)),
    ).toThrow("between 0 and 1");
  });
});
