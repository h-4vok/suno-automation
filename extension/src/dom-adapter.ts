import type { CreateCommandPayload } from "../../src/contracts/extension.js";
import type { CommandResult } from "../../src/contracts/extension.js";

const CREATE_TEXT = /^create$/iu;
const EXHAUSTED_CREDITS_TEXT =
  /\b(?:0\s+credits?|no\s+credits?\s+remaining|out\s+of\s+credits?|not\s+enough\s+credits?)(?=\s|$|create\b)/iu;

export function inspectQuota(
  documentRoot: Document = document,
): Extract<CommandResult, { kind: "inspect" }> {
  const create = findCreateButton(documentRoot);
  const bodyText = `${documentRoot.body.innerText} ${documentRoot.body.textContent}`;
  const creditsMatch = /\b(\d{1,5})\s+credits?(?=\s|$|create\b)/iu.exec(bodyText);
  const availableCredits = creditsMatch?.[1] === undefined ? undefined : Number(creditsMatch[1]);

  if (availableCredits !== undefined && availableCredits > 0) {
    return {
      kind: "inspect",
      quota: {
        availableCredits,
        ...(create === undefined ? {} : { createButtonText: textOf(create) }),
        details: "A positive remaining-credit count is visible.",
        observedAt: new Date().toISOString(),
        state: "available",
      },
    };
  }
  if (availableCredits === 0 || EXHAUSTED_CREDITS_TEXT.test(bodyText)) {
    return {
      kind: "inspect",
      quota: {
        ...(availableCredits === undefined ? {} : { availableCredits }),
        ...(create === undefined ? {} : { createButtonText: textOf(create) }),
        details: "Suno explicitly reports that no credits remain.",
        observedAt: new Date().toISOString(),
        state: "upgrade",
      },
    };
  }
  return {
    kind: "inspect",
    quota: {
      ...(availableCredits === undefined ? {} : { availableCredits }),
      ...(create === undefined ? {} : { createButtonText: textOf(create) }),
      details:
        create === undefined
          ? "No remaining-credit count or composer Create action was found."
          : `Composer Create is ${isDisabled(create) ? "disabled" : "enabled"}, but local form readiness and promotional upgrade links are not quota evidence; no remaining-credit count is visible.`,
      observedAt: new Date().toISOString(),
      state: "unknown",
    },
  };
}

export async function executeCreateCommand(
  payload: CreateCommandPayload,
  allowLiveSubmissions: boolean,
  documentRoot: Document = document,
): Promise<Extract<CommandResult, { kind: "create" }>> {
  await ensureCustomMode(documentRoot);
  const title = findField(documentRoot, [
    'input[name*="title" i]',
    'input[placeholder*="title" i]',
  ]);
  const lyrics = findField(documentRoot, [
    'textarea[name*="lyric" i]',
    'textarea[placeholder*="lyric" i]',
    '[contenteditable="true"][data-placeholder*="lyric" i]',
  ]);
  const style = findField(documentRoot, [
    'textarea[name*="style" i]',
    'input[name*="style" i]',
    'textarea[placeholder*="style" i]',
    'input[placeholder*="style" i]',
  ]);

  const missing = [
    title === undefined ? "title" : undefined,
    lyrics === undefined ? "lyrics" : undefined,
    style === undefined ? "style" : undefined,
  ].filter((name): name is string => name !== undefined);
  if (title === undefined || lyrics === undefined || style === undefined) {
    return {
      details: `Missing Suno fields: ${missing.join(", ")}.`,
      kind: "create",
      outcome: "failed",
    };
  }

  setFieldValue(title, payload.draft.title);
  setFieldValue(lyrics, payload.draft.lyricsField);
  setFieldValue(style, payload.draft.styleField);
  // Give controlled frameworks one render turn to accept or reject the injected values.
  await new Promise((resolve) => window.setTimeout(resolve, 0));
  const rejectedFields = [
    fieldValue(title) === payload.draft.title ? undefined : "title",
    fieldValue(lyrics) === payload.draft.lyricsField ? undefined : "lyrics",
    fieldValue(style) === payload.draft.styleField ? undefined : "style",
  ].filter((name): name is string => name !== undefined);
  if (rejectedFields.length > 0) {
    return {
      details: `Suno did not retain the expected values for: ${rejectedFields.join(", ")}.`,
      kind: "create",
      outcome: "failed",
    };
  }
  if (!(await ensureInstrumentalEnabled(documentRoot))) {
    return {
      details: "Instrumental control is missing or could not be enabled.",
      kind: "create",
      outcome: "failed",
    };
  }

  if (!payload.submit || !allowLiveSubmissions) {
    return {
      details: payload.submit
        ? "Draft filled; extension live safety gate is disabled."
        : "Draft filled without submission.",
      kind: "create",
      outcome: "drafted",
    };
  }

  const createButton = findCreateButton(documentRoot);
  if (createButton === undefined) {
    return { details: "Composer Create action not found.", kind: "create", outcome: "failed" };
  }
  if (isDisabled(createButton)) {
    return {
      details:
        "Composer Create action is still disabled after fields were filled; stopped without clicking. This is local form readiness, not quota evidence.",
      kind: "create",
      outcome: "failed",
    };
  }
  createButton.click();
  return {
    details:
      "Create click dispatched with both safety gates enabled; Suno server-side acceptance is not inferred from button state.",
    kind: "create",
    outcome: "submitted",
  };
}

function fieldValue(element: HTMLElement): string {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    return element.value;
  }
  return element.textContent;
}

function interactiveElements(documentRoot: Document): HTMLElement[] {
  return Array.from(
    documentRoot.querySelectorAll<HTMLElement>('button, [role="button"], input[type="submit"]'),
  ).filter(isProbablyVisible);
}

function findCreateButton(documentRoot: Document): HTMLElement | undefined {
  const primary = Array.from(
    documentRoot.querySelectorAll<HTMLElement>('button[aria-label="Create song"]'),
  ).filter(isProbablyVisible);
  if (primary.length > 0) {
    return primary.length === 1 ? primary[0] : undefined;
  }
  const fallback = interactiveElements(documentRoot).filter((element) =>
    CREATE_TEXT.test(textOf(element)),
  );
  return fallback.length === 1 ? fallback[0] : undefined;
}

function isProbablyVisible(element: HTMLElement): boolean {
  return (
    !element.hidden &&
    element.getAttribute("aria-hidden") !== "true" &&
    element.style.display !== "none"
  );
}

function textOf(element: HTMLElement): string {
  return (
    element.innerText ||
    element.textContent ||
    (element as HTMLInputElement).value ||
    ""
  ).trim();
}

function isDisabled(element: HTMLElement): boolean {
  return (
    ("disabled" in element && (element as HTMLButtonElement).disabled) ||
    element.getAttribute("aria-disabled") === "true"
  );
}

async function ensureCustomMode(documentRoot: Document): Promise<void> {
  if (findField(documentRoot, ['textarea[name*="lyric" i]', 'textarea[placeholder*="lyric" i]'])) {
    return;
  }
  const custom = interactiveElements(documentRoot).find((element) =>
    /^custom$/iu.test(textOf(element)),
  );
  custom?.click();
  if (custom !== undefined) {
    await waitFor(
      () =>
        findField(documentRoot, [
          'textarea[name*="lyric" i]',
          'textarea[placeholder*="lyric" i]',
        ]) !== undefined,
      5_000,
    );
  }
}

function findField(documentRoot: Document, selectors: readonly string[]): HTMLElement | undefined {
  for (const selector of selectors) {
    const field = documentRoot.querySelector<HTMLElement>(selector);
    if (field !== null && isProbablyVisible(field)) {
      return field;
    }
  }
  return undefined;
}

function setFieldValue(element: HTMLElement, value: string): void {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    const prototype =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    // Native setter is intentionally detached so React's controlled input state receives the update.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter !== undefined) {
      Reflect.apply(setter, element, [value]);
    }
  } else {
    element.textContent = value;
  }
  element.dispatchEvent(
    new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }),
  );
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

async function ensureInstrumentalEnabled(documentRoot: Document): Promise<boolean> {
  const label = Array.from(
    documentRoot.querySelectorAll<HTMLElement>("label, button, [role=switch]"),
  )
    .filter(isProbablyVisible)
    .find((element) => /instrumental/iu.test(textOf(element)));
  if (label === undefined) {
    return false;
  }
  const checkbox = label.matches('input[type="checkbox"]')
    ? (label as HTMLInputElement)
    : label.querySelector<HTMLInputElement>('input[type="checkbox"]');
  const isEnabled = (): boolean =>
    checkbox?.checked === true ||
    label.getAttribute("aria-checked") === "true" ||
    label.dataset.state === "checked";
  if (isEnabled()) {
    return true;
  }
  (checkbox ?? label).click();
  return waitFor(isEnabled, 1_000);
}

async function waitFor(predicate: () => boolean, timeoutMilliseconds: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => window.setTimeout(resolve, 100));
  }
  return predicate();
}
