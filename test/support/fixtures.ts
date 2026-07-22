import { AppConfigSchema, type AppConfig } from "../../src/config/schema.js";
import type { RandomSource } from "../../src/domain/random.js";

export function makeConfig(
  overrides: {
    instrumentChance?: number;
    maxGenerations?: number;
    mode?: "observe" | "draft" | "live";
  } = {},
): AppConfig {
  return AppConfigSchema.parse({
    automation: {
      instrumentalFeatureChance: overrides.instrumentChance ?? 0,
      maxGenerationsPerDay: overrides.maxGenerations ?? 5,
      mode: overrides.mode ?? "observe",
    },
    gemini: {
      apiKeyEnv: "GEMINI_API_KEY",
      maxOutputTokens: 1_000,
      model: "gemini-test",
      temperature: 1,
    },
    instruments: [
      {
        id: "sax",
        instruction: "Feature one controlled saxophone solo section.",
        name: "saxophone",
        weight: 1,
      },
    ],
    schedule: { cron: "0 23 * * *", timezone: "Europe/London" },
    server: {
      extensionTokenEnv: "TOKEN",
      host: "127.0.0.1",
      port: 4_317,
      stateFile: "runtime/test.json",
    },
    styles: [
      {
        enabled: true,
        id: "tango",
        name: "Tango",
        prompt: "Instrumental nocturnal tango with bandoneon and chamber strings.",
        weight: 1,
      },
    ],
  });
}

export class SequenceRandom implements RandomSource {
  readonly #values: number[];
  #index = 0;

  constructor(...values: number[]) {
    this.#values = values;
  }

  next(): number {
    const value = this.#values[this.#index];
    if (value === undefined) {
      throw new Error("Random sequence exhausted.");
    }
    this.#index += 1;
    return value;
  }
}
