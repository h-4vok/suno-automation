import type { FastifyInstance } from "fastify";

import { loadConfig, requiredEnvironmentVariable } from "./config/load.js";
import { Coordinator } from "./coordinator/coordinator.js";
import { CryptoRandomSource } from "./domain/random.js";
import type { Songwriter } from "./domain/songwriter.js";
import { systemClock } from "./domain/time.js";
import type { SongDraft } from "./domain/types.js";
import { GeminiSongwriter } from "./gemini/gemini-songwriter.js";
import { FileStateStore } from "./persistence/state.js";
import { startDailyScheduler, type Scheduler } from "./scheduler/daily-scheduler.js";
import { buildServer } from "./server/app.js";

class UnavailableSongwriter implements Songwriter {
  compose(): Promise<SongDraft> {
    return Promise.reject(
      new Error("GEMINI_API_KEY is required when automation mode is draft or live."),
    );
  }
}

export interface RunningApplication {
  readonly scheduler: Scheduler;
  readonly server: FastifyInstance;
}

export async function createApplication(configPath: string): Promise<RunningApplication> {
  const config = await loadConfig(configPath);
  const token = requiredEnvironmentVariable(config.server.extensionTokenEnv);
  const apiKey = process.env[config.gemini.apiKeyEnv]?.trim();
  const songwriter =
    apiKey === undefined || apiKey.length === 0
      ? new UnavailableSongwriter()
      : new GeminiSongwriter(apiKey, config.gemini);
  const coordinator = new Coordinator({
    clock: systemClock,
    config,
    random: new CryptoRandomSource(),
    songwriter,
    store: new FileStateStore(config.server.stateFile),
  });
  await coordinator.recoverIncompleteRuns();
  const server = buildServer({ coordinator, logger: true, token });
  await server.listen({ host: config.server.host, port: config.server.port });
  const scheduler = startDailyScheduler(config, coordinator);
  return { scheduler, server };
}
