export type AutomationMode = "observe" | "draft" | "live";

export interface WeightedItem {
  readonly weight: number;
}

export interface StylePreset extends WeightedItem {
  readonly enabled: boolean;
  readonly id: string;
  readonly name: string;
  readonly prompt: string;
}

export interface InstrumentPreset extends WeightedItem {
  readonly id: string;
  readonly instruction: string;
  readonly name: string;
}

export interface GenerationPlan {
  readonly instrument?: InstrumentPreset;
  readonly style: StylePreset;
}

export interface SongDraft {
  readonly lyricsField: string;
  readonly title: string;
}

export interface SunoDraft extends SongDraft {
  readonly instrumental: true;
  readonly styleField: string;
}
