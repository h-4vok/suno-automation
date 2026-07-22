import type { CommandResult, ExtensionCommand } from "../../src/contracts/extension.js";
import { executeCreateCommand, inspectQuota } from "./dom-adapter.js";
import { loadSettings } from "./settings.js";

chrome.runtime.onMessage.addListener(
  (message: unknown, _sender, sendResponse: (response: CommandResult) => void) => {
    if (!isExtensionCommand(message)) {
      return false;
    }
    if (message.kind === "inspect") {
      sendResponse(inspectQuota());
      return false;
    }
    void loadSettings()
      .then((settings) => executeCreateCommand(message.payload, settings.allowLiveSubmissions))
      .then(sendResponse)
      .catch((error: unknown) => {
        sendResponse({
          details: error instanceof Error ? error.message : String(error),
          kind: "create",
          outcome: "failed",
        });
      });
    return true;
  },
);

function isExtensionCommand(value: unknown): value is ExtensionCommand {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    ((value as { kind?: unknown }).kind === "inspect" ||
      (value as { kind?: unknown }).kind === "create")
  );
}
