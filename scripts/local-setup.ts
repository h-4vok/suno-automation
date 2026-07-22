import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, copyFile, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const TOKEN_KEY = "SUNO_EXTENSION_TOKEN";
const TOKEN_PLACEHOLDER = "replace-with-a-random-token";
const VALID_COMMANDS = new Set<SetupCommand>(["setup", "get-token", "rotate-token"]);

export type SetupCommand = "get-token" | "rotate-token" | "setup";

export interface SetupOptions {
  readonly command: SetupCommand;
  readonly copyToken?: (token: string) => void;
  readonly root: string;
}

export interface SetupResult {
  readonly configCreated: boolean;
  readonly environmentChanged: boolean;
  readonly rotated: boolean;
  readonly tokenCopied: boolean;
}

export type ClipboardRunner = (
  executable: string,
  arguments_: readonly string[],
  input: string,
) => number | null;

export async function runLocalSetup(options: SetupOptions): Promise<SetupResult> {
  const root = resolve(options.root);
  const configCreated = await ensureConfig(root);
  const environmentPath = resolve(root, ".env");
  const environmentTemplatePath = resolve(root, ".env.example");
  const originalEnvironment = await readOptional(environmentPath);
  const baseEnvironment = originalEnvironment ?? (await readFile(environmentTemplatePath, "utf8"));
  const currentToken = environmentValue(baseEnvironment, TOKEN_KEY);
  const mustGenerate =
    options.command === "rotate-token" ||
    currentToken === undefined ||
    currentToken.length === 0 ||
    currentToken === TOKEN_PLACEHOLDER;
  const token = mustGenerate ? randomBytes(32).toString("hex") : currentToken;
  const nextEnvironment = setEnvironmentValue(baseEnvironment, TOKEN_KEY, token);
  const environmentChanged = originalEnvironment !== nextEnvironment;

  if (environmentChanged) {
    await writeFile(environmentPath, nextEnvironment, { encoding: "utf8", mode: 0o600 });
  }
  options.copyToken?.(token);

  return {
    configCreated,
    environmentChanged,
    rotated: options.command === "rotate-token",
    tokenCopied: options.copyToken !== undefined,
  };
}

export function formatSetupResult(result: SetupResult): string {
  return (
    [
      "Local setup ready.",
      `config/config.yaml: ${result.configCreated ? "created" : "kept"}.`,
      `.env: ${result.environmentChanged ? "created or updated" : "kept"}.`,
      result.tokenCopied
        ? "Extension token copied to clipboard; it was not printed."
        : "Clipboard disabled; token was not printed.",
      result.rotated
        ? "Restart the coordinator and save the new clipboard token in the extension."
        : "Next: pnpm start",
    ].join("\n") + "\n"
  );
}

async function ensureConfig(root: string): Promise<boolean> {
  const target = resolve(root, "config", "config.yaml");
  try {
    await access(target);
    return false;
  } catch {
    await copyFile(resolve(root, "config", "config.example.yaml"), target, constants.COPYFILE_EXCL);
    return true;
  }
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

function environmentValue(environment: string, key: string): string | undefined {
  const match = new RegExp(`^${key}=(.*)$`, "mu").exec(environment)?.[1]?.trim();
  if (match === undefined) {
    return undefined;
  }
  const quoted = /^(?:"([^"]*)"|'([^']*)')$/u.exec(match);
  return quoted?.[1] ?? quoted?.[2] ?? match;
}

function setEnvironmentValue(environment: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const expression = new RegExp(`^${key}=.*$`, "mu");
  const updated = expression.test(environment)
    ? environment.replace(expression, line)
    : `${environment.trimEnd()}\n${line}`;
  return `${updated.trimEnd()}\n`;
}

export function copyTokenToClipboard(
  token: string,
  runner: ClipboardRunner = runClipboardCommand,
): void {
  const commands: readonly {
    readonly arguments: readonly string[];
    readonly executable: string;
  }[] =
    process.platform === "win32"
      ? [
          {
            arguments: [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              "Set-Clipboard -Value ([Console]::In.ReadToEnd())",
            ],
            executable: "powershell.exe",
          },
        ]
      : process.platform === "darwin"
        ? [{ arguments: [], executable: "pbcopy" }]
        : [
            { arguments: [], executable: "wl-copy" },
            { arguments: ["-selection", "clipboard"], executable: "xclip" },
          ];

  for (const candidate of commands) {
    if (runner(candidate.executable, candidate.arguments, token) === 0) {
      return;
    }
  }
  throw new Error("Could not copy the extension token to the clipboard.");
}

function runClipboardCommand(
  executable: string,
  arguments_: readonly string[],
  input: string,
): number | null {
  return spawnSync(executable, arguments_, {
    encoding: "utf8",
    input,
    windowsHide: true,
  }).status;
}

function parseArguments(arguments_: readonly string[]): {
  readonly command: SetupCommand;
  readonly copyClipboard: boolean;
  readonly root: string;
} {
  const command = arguments_[0] ?? "setup";
  if (!isSetupCommand(command)) {
    throw new Error("Usage: local-setup.ts [setup|get-token|rotate-token]");
  }
  let root = process.cwd();
  let copyClipboard = true;
  for (let index = 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--no-clipboard") {
      copyClipboard = false;
      continue;
    }
    if (argument === "--root") {
      const value = arguments_[index + 1];
      if (value === undefined) {
        throw new Error("--root requires a path.");
      }
      root = resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument ${argument ?? ""}.`);
  }
  return { command, copyClipboard, root: resolve(root) };
}

function isSetupCommand(value: string): value is SetupCommand {
  return VALID_COMMANDS.has(value as SetupCommand);
}

async function main(): Promise<void> {
  const { command, copyClipboard, root } = parseArguments(process.argv.slice(2));
  const result = await runLocalSetup({
    command,
    ...(copyClipboard ? { copyToken: copyTokenToClipboard } : {}),
    root,
  });
  process.stdout.write(formatSetupResult(result));
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  try {
    await main();
  } catch (error: unknown) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
