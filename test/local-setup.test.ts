import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { copyTokenToClipboard, formatSetupResult, runLocalSetup } from "../scripts/local-setup.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const setupScript = join(repositoryRoot, "scripts", "local-setup.ts");
const tsxCli = fileURLToPath(import.meta.resolve("tsx/cli"));
let temporaryRoot: string;

describe("local setup command", () => {
  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), "suno-local-setup-"));
    await mkdir(join(temporaryRoot, "config"));
    await copyFile(join(repositoryRoot, ".env.example"), join(temporaryRoot, ".env.example"));
    await copyFile(
      join(repositoryRoot, "config", "config.example.yaml"),
      join(temporaryRoot, "config", "config.example.yaml"),
    );
  });

  afterEach(async () => {
    const resolvedTemporaryRoot = resolve(temporaryRoot);
    const resolvedSystemTemp = `${resolve(tmpdir())}${sep}`;
    if (!resolvedTemporaryRoot.startsWith(resolvedSystemTemp)) {
      throw new Error("Refusing to remove a test directory outside the system temp folder.");
    }
    await rm(resolvedTemporaryRoot, { force: true, recursive: true });
  });

  it("creates safe local files, preserves the token, and rotates only explicitly", async () => {
    let copiedToken = "";
    const first = await runLocalSetup({
      command: "setup",
      copyToken: (token) => {
        copiedToken = token;
      },
      root: temporaryRoot,
    });
    const firstEnvironment = await readFile(join(temporaryRoot, ".env"), "utf8");
    const firstToken = requireToken(firstEnvironment);

    expect(copiedToken).toBe(firstToken);
    expect(formatSetupResult(first)).not.toContain(firstToken);
    expect(firstToken).toMatch(/^[a-f\d]{64}$/u);
    await expect(readFile(join(temporaryRoot, "config", "config.yaml"), "utf8")).resolves.toBe(
      await readFile(join(repositoryRoot, "config", "config.example.yaml"), "utf8"),
    );

    await writeFile(join(temporaryRoot, "config", "config.yaml"), "user: configuration\n");
    await runLocalSetup({ command: "get-token", root: temporaryRoot });
    expect(requireToken(await readFile(join(temporaryRoot, ".env"), "utf8"))).toBe(firstToken);
    await expect(readFile(join(temporaryRoot, "config", "config.yaml"), "utf8")).resolves.toBe(
      "user: configuration\n",
    );

    const rotated = await runLocalSetup({ command: "rotate-token", root: temporaryRoot });
    const rotatedToken = requireToken(await readFile(join(temporaryRoot, ".env"), "utf8"));
    expect(rotatedToken).not.toBe(firstToken);
    expect(formatSetupResult(rotated)).not.toContain(rotatedToken);
  });

  it("runs through the packaged command entry without leaking the token", async () => {
    const result = await execFileAsync(
      process.execPath,
      [tsxCli, setupScript, "setup", "--root", temporaryRoot, "--no-clipboard"],
      { encoding: "utf8" },
    );
    const token = requireToken(await readFile(join(temporaryRoot, ".env"), "utf8"));
    const packageJson = JSON.parse(
      await readFile(join(repositoryRoot, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };

    expect(result.stdout).toContain("Local setup ready.");
    expect(result.stdout).not.toContain(token);
    expect(packageJson.scripts?.["setup:local"]).toBe("tsx scripts/local-setup.ts setup");
    expect(packageJson.scripts?.["get-extension-token"]).toBe(
      "tsx scripts/local-setup.ts get-token",
    );
  });

  it("passes the token through stdin rather than exposing it in process arguments", () => {
    const token = "a".repeat(64);
    const calls: { arguments_: readonly string[]; executable: string; input: string }[] = [];

    copyTokenToClipboard(token, (executable, arguments_, input) => {
      calls.push({ arguments_, executable, input });
      return 0;
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe(token);
    expect(calls[0]?.arguments_.join(" ")).not.toContain(token);
    expect(calls[0]?.executable.length).toBeGreaterThan(0);
  });

  it("keeps a quoted valid token unchanged and reports that clipboard use was disabled", async () => {
    const token = "b".repeat(64);
    await writeFile(join(temporaryRoot, ".env"), `SUNO_EXTENSION_TOKEN='${token}'\nOTHER=value\n`);
    await writeFile(join(temporaryRoot, "config", "config.yaml"), "preserved: true\n");

    const result = await runLocalSetup({ command: "get-token", root: temporaryRoot });

    expect(result).toEqual({
      configCreated: false,
      environmentChanged: true,
      rotated: false,
      tokenCopied: false,
    });
    const environment = await readFile(join(temporaryRoot, ".env"), "utf8");
    expect(requireToken(environment)).toBe(token);
    expect(formatSetupResult(result)).toContain("Clipboard disabled");
  });

  it("fails explicitly if every supported clipboard command rejects the token", () => {
    const token = "c".repeat(64);
    const attempted: string[] = [];

    expect(() =>
      copyTokenToClipboard(token, (executable) => {
        attempted.push(executable);
        return 1;
      }),
    ).toThrow("Could not copy the extension token to the clipboard.");
    expect(attempted).not.toHaveLength(0);
  });
});

function requireToken(environment: string): string {
  const token = /^SUNO_EXTENSION_TOKEN=(.+)$/mu.exec(environment)?.[1]?.trim();
  if (token === undefined) {
    throw new Error("Expected generated extension token.");
  }
  return token;
}
