import type { CommandResult, ExtensionCommand } from "../../src/contracts/extension.js";

const RETRY_ATTEMPTS = 8;

export async function dispatchCommand(
  command: ExtensionCommand,
  send: () => Promise<CommandResult>,
  pause: () => Promise<void>,
): Promise<CommandResult> {
  if (command.kind === "create" && command.payload.submit) {
    // A rejected response can still mean the content script clicked. Never retry an ambiguous live send.
    return send();
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await send();
    } catch (error: unknown) {
      lastError = error;
      await pause();
    }
  }
  throw lastError;
}
