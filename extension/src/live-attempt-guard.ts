const STORAGE_KEY = "attemptedLiveCommandIds";
const DEFAULT_HISTORY_LIMIT = 100;

export interface AttemptStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export async function reserveLiveAttempt(
  storage: AttemptStorage,
  commandId: string,
  historyLimit = DEFAULT_HISTORY_LIMIT,
): Promise<boolean> {
  const stored = await storage.get(STORAGE_KEY);
  const rawHistory = stored[STORAGE_KEY];
  const history = Array.isArray(rawHistory)
    ? rawHistory.filter((value): value is string => typeof value === "string")
    : [];
  if (history.includes(commandId)) {
    return false;
  }
  const next = [...history, commandId].slice(-historyLimit);
  await storage.set({ [STORAGE_KEY]: next });
  return true;
}
