import type { GenerationPlan, SongDraft } from "./types.js";

export interface Songwriter {
  compose(plan: GenerationPlan): Promise<SongDraft>;
}
