import { checkCoordinatorConnection, type CoordinatorConnection } from "./coordinator-client.js";
import { defaultSettings, loadSettings, type ExtensionSettings } from "./settings.js";

const baseUrl = requireElement("baseUrl", HTMLInputElement);
const token = requireElement("token", HTMLInputElement);
const allowLiveSubmissions = requireElement("allowLiveSubmissions", HTMLInputElement);
const save = requireElement("save", HTMLButtonElement);
const status = requireElement("status", HTMLOutputElement);
const packageVersion = requireElement("packageVersion", HTMLParagraphElement);

packageVersion.textContent = `Extension v${chrome.runtime.getManifest().version} · load extension/dist`;

void loadSettings().then(async (settings) => {
  baseUrl.value = settings.baseUrl;
  token.value = settings.token;
  allowLiveSubmissions.checked = settings.allowLiveSubmissions;
  await showConnection(settings, true);
});

save.addEventListener("click", () => {
  void saveAndCheck();
});

async function saveAndCheck(): Promise<void> {
  const settings: ExtensionSettings = {
    allowLiveSubmissions: allowLiveSubmissions.checked,
    baseUrl: baseUrl.value.trim() || defaultSettings.baseUrl,
    token: token.value.trim(),
  };
  save.disabled = true;
  await chrome.storage.sync.set(settings);
  await showConnection(settings, true);
  save.disabled = false;
}

async function showConnection(
  settings: ExtensionSettings,
  pollWhenConnected: boolean,
): Promise<void> {
  status.dataset.state = "checking";
  status.value = "Checking coordinator...";
  const connection = await checkCoordinatorConnection(settings.baseUrl, settings.token);
  status.dataset.state = connection.state;
  status.value = connectionMessage(connection);
  if (connection.state === "connected" && pollWhenConnected) {
    await chrome.runtime.sendMessage({ kind: "poll-now" });
    status.value = "Coordinator connected. Poll requested.";
  }
}

function connectionMessage(connection: CoordinatorConnection): string {
  switch (connection.state) {
    case "connected":
      return "Coordinator connected.";
    case "missing-token":
      return "Paste the extension token, then Save.";
    case "offline":
      return "Coordinator offline. Start it with `pnpm start`; this is not an extension error.";
    case "unauthorized":
      return "Token mismatch. Copy it again with `pnpm get-extension-token`.";
    case "error":
      return `Coordinator returned HTTP ${connection.status.toString()}.`;
  }
}

function requireElement<T extends HTMLElement>(id: string, constructor: new () => T): T {
  const element = document.querySelector(`#${id}`);
  if (!(element instanceof constructor)) {
    throw new Error(`Missing #${id}.`);
  }
  return element;
}
