export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export type CoordinatorConnection =
  | { readonly state: "connected" }
  | { readonly state: "missing-token" }
  | { readonly state: "offline" }
  | { readonly state: "unauthorized" }
  | { readonly state: "error"; readonly status: number };

export interface PollLogger {
  error(message: string, error: unknown): void;
  info(message: string): void;
}

export class CoordinatorUnavailableError extends Error {
  public constructor(cause: unknown) {
    super("Suno coordinator is unavailable.", { cause });
    this.name = "CoordinatorUnavailableError";
  }
}

export async function fetchCoordinator(
  fetcher: Fetcher,
  input: string,
  init?: RequestInit,
): Promise<Response> {
  try {
    return await fetcher(input, init);
  } catch (error: unknown) {
    throw new CoordinatorUnavailableError(error);
  }
}

export async function checkCoordinatorConnection(
  baseUrl: string,
  token: string,
  fetcher: Fetcher = fetch,
): Promise<CoordinatorConnection> {
  if (token.length === 0) {
    return { state: "missing-token" };
  }

  try {
    const response = await fetchCoordinator(
      fetcher,
      `${baseUrl.replace(/\/$/u, "")}/api/v1/status`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (response.ok) {
      return { state: "connected" };
    }
    if (response.status === 401) {
      return { state: "unauthorized" };
    }
    return { state: "error", status: response.status };
  } catch (error: unknown) {
    if (error instanceof CoordinatorUnavailableError) {
      return { state: "offline" };
    }
    throw error;
  }
}

export function reportPollFailure(error: unknown, logger: PollLogger): void {
  if (error instanceof CoordinatorUnavailableError) {
    logger.info("Suno coordinator is offline; the extension will retry automatically.");
    return;
  }
  logger.error("Suno assistant poll failed", error);
}
