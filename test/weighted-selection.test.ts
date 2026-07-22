import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { chooseWeighted } from "../src/domain/weighted-selection.js";
import { SequenceRandom } from "./support/fixtures.js";

describe("chooseWeighted", () => {
  it("maps cumulative intervals including zero-weight entries", () => {
    const items = [
      { id: "never", weight: 0 },
      { id: "small", weight: 1 },
      { id: "large", weight: 3 },
    ];

    expect(chooseWeighted(items, new SequenceRandom(0)).id).toBe("small");
    expect(chooseWeighted(items, new SequenceRandom(0.249_999)).id).toBe("small");
    expect(chooseWeighted(items, new SequenceRandom(0.25)).id).toBe("large");
    expect(chooseWeighted(items, new SequenceRandom(0.999_999)).id).toBe("large");
  });

  it("never selects a zero-weight item for arbitrary valid samples", () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 0.999_999, noNaN: true }), (sample) => {
        const selected = chooseWeighted(
          [
            { id: "zero-a", weight: 0 },
            { id: "positive", weight: 4 },
            { id: "zero-b", weight: 0 },
          ],
          new SequenceRandom(sample),
        );
        expect(selected.id).toBe("positive");
      }),
    );
  });

  it("falls back to the last selectable item after floating-point underflow", () => {
    const selected = chooseWeighted(
      [
        { id: "tiny", weight: Number.MIN_VALUE },
        { id: "never", weight: 0 },
      ],
      new SequenceRandom(0.999_999_999_999_999_9),
    );
    expect(selected.id).toBe("tiny");
  });

  it.each([
    [[], "empty"],
    [[{ weight: -1 }], "non-negative"],
    [[{ weight: Number.NaN }], "finite"],
    [[{ weight: 0 }], "positive"],
  ] as const)("rejects invalid collection %#", (items, message) => {
    expect(() => chooseWeighted(items, new SequenceRandom(0))).toThrow(message);
  });

  it.each([-0.1, 1, Number.NaN])("rejects invalid random sample %s", (sample) => {
    expect(() => chooseWeighted([{ weight: 1 }], new SequenceRandom(sample))).toThrow("[0, 1)");
  });
});
