import type { RandomSource } from "./random.js";
import type { WeightedItem } from "./types.js";

export function chooseWeighted<T extends WeightedItem>(
  items: readonly T[],
  random: RandomSource,
): T {
  if (items.length === 0) {
    throw new Error("Cannot choose from an empty weighted collection.");
  }

  const total = items.reduce((sum, item) => {
    if (!Number.isFinite(item.weight) || item.weight < 0) {
      throw new Error("Weights must be finite, non-negative numbers.");
    }
    return sum + item.weight;
  }, 0);

  if (total <= 0) {
    throw new Error("At least one item must have a positive weight.");
  }

  const sample = random.next();
  if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
    throw new Error("Random source must return a number in [0, 1).");
  }

  let cursor = sample * total;
  for (const item of items) {
    cursor -= item.weight;
    if (cursor < 0) {
      return item;
    }
  }

  // Floating-point rounding can leave a tiny positive remainder.
  const fallback = items.findLast((item) => item.weight > 0);
  if (fallback === undefined) {
    throw new Error("Weighted collection has no selectable item.");
  }
  return fallback;
}
