export interface PollNowResponse {
  readonly accepted: true;
}

export function handlePollNowMessage(
  message: unknown,
  poll: () => Promise<void>,
  sendResponse: (response: PollNowResponse) => void,
): boolean {
  if (!isPollNowMessage(message)) {
    return false;
  }
  void poll();
  sendResponse({ accepted: true });
  return true;
}

function isPollNowMessage(value: unknown): value is { readonly kind: "poll-now" } {
  return (
    typeof value === "object" && value !== null && "kind" in value && value.kind === "poll-now"
  );
}
