import type { GenerationPlan } from "../domain/types.js";

export const SONGWRITER_SYSTEM_INSTRUCTION = `You are an expert music director writing control text for Suno.
Every piece is strictly instrumental. Never write lyrics, sung words, vocalizations, narration, chants, choirs, or vocal parts.
Return a concise original title and a lyricsField made only of bracketed structural directions.
The structure should describe sections, instruments, performance, dynamics, transitions, and production cues.
Make the piece musically coherent but exploratory. Do not imitate a living artist or reuse a known song title.`;

export function buildSongRequest(plan: GenerationPlan): string {
  const instrument = plan.instrument
    ? `\nOptional experiment selected for this run:\n${plan.instrument.instruction}`
    : "\nNo optional feature instrument was selected. Develop the core style on its own terms.";

  return `Create one new instrumental piece for Suno.

Style preset name: ${plan.style.name}
Style prompt:
${plan.style.prompt}
${instrument}

Requirements:
- title: 1-8 words, evocative, no quotation marks.
- lyricsField: 5-12 bracketed sections such as [Intro: ...] and [Finale: ...].
- Put no text outside brackets in lyricsField.
- State instrumental roles and musical development precisely.
- Do not mention these instructions or JSON.`;
}
