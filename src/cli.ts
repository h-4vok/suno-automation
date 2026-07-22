import "dotenv/config";

import { loadConfig, requiredEnvironmentVariable } from "./config/load.js";
import { createApplication } from "./main.js";

const [command = "serve", argument] = process.argv.slice(2);
const configPath =
  argument ??
  process.env.SUNO_CONFIG_PATH ??
  (command === "validate-config" ? undefined : "config/config.yaml");

try {
  if (command === "validate-config") {
    if (configPath === undefined) {
      throw new Error("Usage: validate-config <path>");
    }
    const config = await loadConfig(configPath);
    process.stdout.write(
      `Valid config: ${config.styles.length.toString()} styles, ${config.instruments.length.toString()} instruments, mode=${config.automation.mode}\n`,
    );
  } else if (command === "run" || command === "status") {
    if (configPath === undefined) {
      throw new Error("A config path is required.");
    }
    const config = await loadConfig(configPath);
    const token = requiredEnvironmentVariable(config.server.extensionTokenEnv);
    const endpoint =
      command === "run"
        ? `http://${config.server.host}:${config.server.port.toString()}/api/v1/runs`
        : `http://${config.server.host}:${config.server.port.toString()}/api/v1/status`;
    const response = await fetch(endpoint, {
      ...(command === "run" ? { body: JSON.stringify({ reason: "manual" }) } : {}),
      headers: {
        Authorization: `Bearer ${token}`,
        ...(command === "run" ? { "Content-Type": "application/json" } : {}),
      },
      method: command === "run" ? "POST" : "GET",
    });
    process.stdout.write(`${await response.text()}\n`);
    if (!response.ok) {
      process.exitCode = 1;
    }
  } else if (command === "serve") {
    if (configPath === undefined) {
      throw new Error("A config path is required.");
    }
    const application = await createApplication(configPath);
    const shutdown = async (): Promise<void> => {
      application.scheduler.stop();
      await application.server.close();
    };
    process.once("SIGINT", () => void shutdown());
    process.once("SIGTERM", () => void shutdown());
  } else {
    throw new Error(`Unknown command ${command}.`);
  }
} catch (error: unknown) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
