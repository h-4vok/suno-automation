import { GoogleGenAI } from "@google/genai";
import { z } from "zod";

import type { AppConfig } from "../config/schema.js";
import type { Songwriter } from "../domain/songwriter.js";
import type { GenerationPlan, SongDraft } from "../domain/types.js";
import { buildSongRequest, SONGWRITER_SYSTEM_INSTRUCTION } from "./prompt.js";

const SongDraftSchema = z.object({
  lyricsField: z
    .string()
    .trim()
    .min(30)
    .max(5_000)
    .refine((value) => {
      const sectionCount = value.split(/\r?\n/u).length;
      return sectionCount >= 5 && sectionCount <= 12;
    }, "Instrumental structure must contain five to twelve sections.")
    .refine(
      (value) => value.split(/\r?\n/u).every((line) => /^\s*\[[^\]]+\]\s*$/u.test(line)),
      "Every non-empty structure line must be bracketed.",
    )
    .refine(
      (value) => !/\b(?:choir|chant|lyric|narration|sing|spoken|vocal|voice)\w*\b/iu.test(value),
      "Instrumental structure cannot contain vocal directions.",
    ),
  title: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .refine((value) => value.split(/\s+/u).length <= 8, "Title must contain at most eight words."),
});

const responseJsonSchema = {
  additionalProperties: false,
  properties: {
    lyricsField: {
      description: "Five to twelve newline-separated bracketed instrumental section directions.",
      type: "string",
    },
    title: { description: "An original title of one to eight words.", type: "string" },
  },
  required: ["title", "lyricsField"],
  type: "object",
} as const;

export function parseSongDraftResponse(responseText: string): SongDraft {
  return SongDraftSchema.parse(JSON.parse(responseText));
}

export class GeminiSongwriter implements Songwriter {
  readonly #client: GoogleGenAI;
  readonly #settings: AppConfig["gemini"];

  constructor(apiKey: string, settings: AppConfig["gemini"]) {
    this.#client = new GoogleGenAI({ apiKey });
    this.#settings = settings;
  }

  async compose(plan: GenerationPlan): Promise<SongDraft> {
    const response = await this.#client.models.generateContent({
      config: {
        maxOutputTokens: this.#settings.maxOutputTokens,
        responseJsonSchema,
        responseMimeType: "application/json",
        systemInstruction: SONGWRITER_SYSTEM_INSTRUCTION,
        temperature: this.#settings.temperature,
      },
      contents: buildSongRequest(plan),
      model: this.#settings.model,
    });

    if (response.text === undefined) {
      throw new Error("Gemini returned no text candidate.");
    }
    return parseSongDraftResponse(response.text);
  }
}
