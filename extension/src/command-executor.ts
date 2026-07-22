import type { CommandResult, ExtensionCommand } from "../../src/contracts/extension.js";
import { dispatchCommand } from "./command-dispatch.js";

export interface BrowserCommandDependencies {
  getTabId(): Promise<number>;
  pause(): Promise<void>;
  reserveLiveAttempt(commandId: string): Promise<boolean>;
  send(tabId: number, command: ExtensionCommand): Promise<CommandResult>;
}

export async function executeBrowserCommand(
  command: ExtensionCommand,
  dependencies: BrowserCommandDependencies,
): Promise<CommandResult> {
  const tabId = await dependencies.getTabId();
  if (
    command.kind === "create" &&
    command.payload.submit &&
    !(await dependencies.reserveLiveAttempt(command.id))
  ) {
    return {
      details:
        "This live command was already attempted. Stopped for manual reconciliation to prevent a duplicate click.",
      kind: "create",
      outcome: "failed",
    };
  }

  return dispatchCommand(
    command,
    () => dependencies.send(tabId, command),
    () => dependencies.pause(),
  );
}
