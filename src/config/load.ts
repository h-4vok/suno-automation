import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "yaml";

import { AppConfigSchema, type AppConfig } from "./schema.js";

export async function loadConfig(path: string): Promise<AppConfig> {
  const absolutePath = resolve(path);
  const contents = await readFile(absolutePath, "utf8");
  return AppConfigSchema.parse(parse(contents));
}

export function requiredEnvironmentVariable(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`Required environment variable ${name} is not set.`);
  }
  return value;
}
