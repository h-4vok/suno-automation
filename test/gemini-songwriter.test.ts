import { describe, expect, it } from "vitest";

import { parseSongDraftResponse } from "../src/gemini/gemini-songwriter.js";

describe("Gemini response boundary", () => {
  it("accepts bracket-only instrumental structure", () => {
    expect(
      parseSongDraftResponse(
        JSON.stringify({
          lyricsField:
            "[Intro: bandoneon pulse and brushed drums]\n[Theme: piano states a motif]\n[Development: strings widen the harmony]\n[Bridge: saxophone bends the motif]\n[Finale: ensemble resolves softly]",
          title: "Clockwork Midnight",
        }),
      ),
    ).toMatchObject({ title: "Clockwork Midnight" });
  });

  it.each([
    "[Intro: bandoneon]\n[Theme: piano]\nSing a melody here\n[Bridge: bass]\n[Finale: strings]",
    "[Intro: bandoneon with wordless vocals]\n[Theme: piano]\n[Development: strings]\n[Bridge: bass]\n[Finale: drums]",
  ])("rejects non-instrumental output before it reaches Suno", (lyricsField) => {
    expect(() =>
      parseSongDraftResponse(JSON.stringify({ lyricsField, title: "Unsafe Draft" })),
    ).toThrow();
  });

  it.each([
    "not JSON",
    JSON.stringify({
      lyricsField: "[One: drums]\n[Two: bass]\n[Three: piano]\n[Four: strings]",
      title: "Too Short",
    }),
    JSON.stringify({
      lyricsField: "[One: drums]\n[Two: bass]\n[Three: piano]\n[Four: strings]\n[Five: guitar]",
      title: "One Two Three Four Five Six Seven Eight Nine",
    }),
  ])("rejects malformed or out-of-contract JSON", (response) => {
    expect(() => parseSongDraftResponse(response)).toThrow();
  });
});
