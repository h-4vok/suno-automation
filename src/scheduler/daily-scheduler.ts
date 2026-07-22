import { Cron } from "croner";

import type { AppConfig } from "../config/schema.js";
import type { Coordinator } from "../coordinator/coordinator.js";

export interface Scheduler {
  stop(): void;
}

export function startDailyScheduler(config: AppConfig, coordinator: Coordinator): Scheduler {
  const cron = new Cron(
    config.schedule.cron,
    { protect: true, timezone: config.schedule.timezone },
    async () => {
      await coordinator.startRun({ reason: "schedule" });
    },
  );
  return { stop: () => cron.stop() };
}
