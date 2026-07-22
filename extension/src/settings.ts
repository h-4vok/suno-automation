export interface ExtensionSettings {
  readonly allowLiveSubmissions: boolean;
  readonly baseUrl: string;
  readonly token: string;
}

export const defaultSettings: ExtensionSettings = {
  allowLiveSubmissions: false,
  baseUrl: "http://127.0.0.1:4317",
  token: "",
};

export async function loadSettings(): Promise<ExtensionSettings> {
  const stored = await chrome.storage.sync.get({ ...defaultSettings });
  const baseUrl = typeof stored.baseUrl === "string" ? stored.baseUrl : defaultSettings.baseUrl;
  const token = typeof stored.token === "string" ? stored.token : defaultSettings.token;
  return {
    allowLiveSubmissions: stored.allowLiveSubmissions === true,
    baseUrl: baseUrl.replace(/\/$/u, ""),
    token,
  };
}
