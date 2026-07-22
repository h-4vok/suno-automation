import { z } from "zod";

import type { AutomationMode, SunoDraft } from "../domain/types.js";

export type QuotaState = "available" | "upgrade" | "unknown";

export interface InspectCommandPayload {
  readonly expectedMode: AutomationMode;
}

export interface CreateCommandPayload {
  readonly draft: SunoDraft;
  readonly submit: boolean;
}

export type ExtensionCommand =
  | {
      readonly id: string;
      readonly kind: "inspect";
      readonly payload: InspectCommandPayload;
      readonly runId: string;
    }
  | {
      readonly id: string;
      readonly kind: "create";
      readonly payload: CreateCommandPayload;
      readonly runId: string;
    };

export const QuotaSnapshotSchema = z.object({
  availableCredits: z.number().int().nonnegative().optional(),
  createButtonText: z.string().max(120).optional(),
  details: z.string().max(500).optional(),
  observedAt: z.iso.datetime(),
  state: z.enum(["available", "upgrade", "unknown"]),
});

export const CommandResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("inspect"),
    quota: QuotaSnapshotSchema,
  }),
  z.object({
    details: z.string().max(500).optional(),
    kind: z.literal("create"),
    outcome: z.enum(["drafted", "submitted", "failed"]),
  }),
]);

export type CommandResult = z.infer<typeof CommandResultSchema>;
