import type { RandomSource } from "./random.js";
import type { GenerationPlan, InstrumentPreset, StylePreset } from "./types.js";
import { chooseWeighted } from "./weighted-selection.js";

export interface GenerationPlanOptions {
  readonly instrumentChance: number;
  readonly instruments: readonly InstrumentPreset[];
  readonly styles: readonly StylePreset[];
}

export function createGenerationPlan(
  options: GenerationPlanOptions,
  random: RandomSource,
): GenerationPlan {
  if (options.instrumentChance < 0 || options.instrumentChance > 1) {
    throw new Error("Instrument chance must be between 0 and 1.");
  }

  const enabledStyles = options.styles.filter((style) => style.enabled);
  const style = chooseWeighted(enabledStyles, random);
  const shouldFeatureInstrument = random.next() < options.instrumentChance;

  if (!shouldFeatureInstrument) {
    return { style };
  }
  if (options.instruments.length === 0) {
    throw new Error("Instrument chance selected, but no instruments are configured.");
  }

  return { instrument: chooseWeighted(options.instruments, random), style };
}
