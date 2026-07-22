import type { CommandResult, ExtensionCommand } from "../../src/contracts/extension.js";
import { executeBrowserCommand } from "./command-executor.js";
import { fetchCoordinator, reportPollFailure } from "./coordinator-client.js";
import { reserveLiveAttempt } from "./live-attempt-guard.js";
import { handlePollNowMessage } from "./poll-now.js";
import { loadSettings } from "./settings.js";
import { getOrCreateSunoCreateTab } from "./suno-tab.js";

const POLL_ALARM = "poll-coordinator";
let polling = false;

chrome.runtime.onInstalled.addListener(() => {
  void ensureAlarm();
});
chrome.runtime.onStartup.addListener(() => {
  void ensureAlarm();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) {
    void poll();
  }
});
chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  return handlePollNowMessage(message, poll, sendResponse);
});
void ensureAlarm().then(poll);

async function ensureAlarm(): Promise<void> {
  const existing = await chrome.alarms.get(POLL_ALARM);
  if (existing === undefined) {
    await chrome.alarms.create(POLL_ALARM, { periodInMinutes: 1 });
  }
}

async function poll(): Promise<void> {
  if (polling) {
    return;
  }
  polling = true;
  try {
    const settings = await loadSettings();
    if (settings.token.length === 0) {
      return;
    }
    const response = await fetchCoordinator(
      fetch,
      `${settings.baseUrl}/api/v1/extension/commands/next`,
      { headers: { Authorization: `Bearer ${settings.token}` } },
    );
    if (response.status === 204) {
      return;
    }
    if (!response.ok) {
      throw new Error(`Coordinator returned ${response.status.toString()}.`);
    }
    const command = ((await response.json()) as { command: ExtensionCommand }).command;
    const result = await executeInSuno(command);
    const report = await fetchCoordinator(
      fetch,
      `${settings.baseUrl}/api/v1/extension/commands/${command.id}/result`,
      {
        body: JSON.stringify(result),
        headers: {
          Authorization: `Bearer ${settings.token}`,
          "Content-Type": "application/json",
        },
        method: "POST",
      },
    );
    if (!report.ok) {
      throw new Error(`Coordinator rejected result with ${report.status.toString()}.`);
    }
  } catch (error: unknown) {
    reportPollFailure(error, console);
  } finally {
    polling = false;
  }
}

async function executeInSuno(command: ExtensionCommand): Promise<CommandResult> {
  try {
    return await executeBrowserCommand(command, {
      getTabId: getSunoCreateTabId,
      pause: async () => delay(500),
      reserveLiveAttempt: async (commandId) => reserveLiveAttempt(chrome.storage.local, commandId),
      send: async (tabId, commandToSend) => chrome.tabs.sendMessage(tabId, commandToSend),
    });
  } catch (error: unknown) {
    const details = error instanceof Error ? error.message : String(error);
    return command.kind === "inspect"
      ? { kind: "inspect", quota: { observedAt: new Date().toISOString(), state: "unknown" } }
      : { details, kind: "create", outcome: "failed" };
  }
}

async function getSunoCreateTabId(): Promise<number> {
  return getOrCreateSunoCreateTab({
    create: (options) => chrome.tabs.create(options),
    query: () => chrome.tabs.query({ url: ["https://suno.com/*", "https://www.suno.com/*"] }),
    waitForComplete: waitForTab,
  });
}

async function waitForTab(tabId: number): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") {
      return;
    }
    await delay(500);
  }
  throw new Error("Timed out waiting for Suno tab.");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
