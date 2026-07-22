import { z } from "zod";

const IdentifierSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export const StylePresetSchema = z.object({
  enabled: z.boolean().default(true),
  id: IdentifierSchema,
  name: z.string().trim().min(1).max(80),
  prompt: z.string().trim().min(10).max(1_500),
  weight: z.number().nonnegative(),
});

export const InstrumentPresetSchema = z.object({
  id: IdentifierSchema,
  instruction: z.string().trim().min(10).max(500),
  name: z.string().trim().min(1).max(80),
  weight: z.number().nonnegative(),
});

export const AppConfigSchema = z
  .object({
    automation: z.object({
      instrumentalFeatureChance: z.number().min(0).max(1).default(0.25),
      maxGenerationsPerDay: z.number().int().min(1).max(5).default(5),
      mode: z.enum(["observe", "draft", "live"]).default("observe"),
    }),
    gemini: z.object({
      apiKeyEnv: z.string().min(1).default("GEMINI_API_KEY"),
      maxOutputTokens: z.number().int().min(256).max(8_192).default(1_800),
      model: z.string().trim().min(1).default("gemini-3.5-flash"),
      temperature: z.number().min(0).max(2).default(1.1),
    }),
    instruments: z.array(InstrumentPresetSchema).default([]),
    schedule: z.object({
      cron: z.string().trim().min(1),
      timezone: z.string().trim().min(1),
    }),
    server: z.object({
      extensionTokenEnv: z.string().min(1).default("SUNO_EXTENSION_TOKEN"),
      host: z.literal("127.0.0.1").default("127.0.0.1"),
      port: z.number().int().min(1_024).max(65_535).default(4_317),
      stateFile: z.string().trim().min(1).default("runtime/state.json"),
    }),
    styles: z.array(StylePresetSchema).min(1),
  })
  .superRefine((config, context) => {
    const enabledStyles = config.styles.filter((style) => style.enabled);
    if (!enabledStyles.some((style) => style.weight > 0)) {
      context.addIssue({
        code: "custom",
        message: "At least one enabled style must have positive weight.",
        path: ["styles"],
      });
    }
    if (
      config.automation.instrumentalFeatureChance > 0 &&
      !config.instruments.some((instrument) => instrument.weight > 0)
    ) {
      context.addIssue({
        code: "custom",
        message: "Positive instrument chance requires an instrument with positive weight.",
        path: ["instruments"],
      });
    }
  });

export type AppConfig = z.infer<typeof AppConfigSchema>;
