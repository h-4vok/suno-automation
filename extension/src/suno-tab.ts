export const SUNO_CREATE_URL = "https://suno.com/create";

export interface BrowserTab {
  readonly id?: number | undefined;
  readonly status?: string | undefined;
  readonly url?: string | undefined;
}

export interface SunoTabDependencies {
  create(options: { readonly active: false; readonly url: string }): Promise<BrowserTab>;
  query(): Promise<readonly BrowserTab[]>;
  waitForComplete(tabId: number): Promise<void>;
}

export async function getOrCreateSunoCreateTab(dependencies: SunoTabDependencies): Promise<number> {
  const tabs = await dependencies.query();
  const existing = tabs.find(
    (tab): tab is BrowserTab & { readonly id: number } =>
      tab.id !== undefined && isSunoCreateUrl(tab.url),
  );
  if (existing !== undefined) {
    await dependencies.waitForComplete(existing.id);
    return existing.id;
  }

  const created = await dependencies.create({ active: false, url: SUNO_CREATE_URL });
  if (created.id === undefined) {
    throw new Error("Browser did not return a tab id.");
  }
  await dependencies.waitForComplete(created.id);
  return created.id;
}

function isSunoCreateUrl(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    const pathname = url.pathname.replace(/\/+$/u, "");
    return (hostname === "suno.com" || hostname === "www.suno.com") && pathname === "/create";
  } catch {
    return false;
  }
}
