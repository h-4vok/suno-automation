// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

import { executeCreateCommand, inspectQuota } from "../extension/src/dom-adapter.js";

const payload = {
  draft: {
    instrumental: true as const,
    lyricsField: "[Intro: quiet strings]\n[Finale: full ensemble]",
    styleField: "Nocturnal tango, no vocals.",
    title: "Night Engine",
  },
  submit: true,
};

describe("Suno DOM adapter", () => {
  beforeEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("uses a positive remaining-credit count even when the empty composer disables Create", () => {
    document.body.innerHTML = `
      <span>50 credits</span>
      <a href="/account?source=sideNav">Upgrade to Pro</a>
      <button aria-label="Create song" disabled>Create</button>
    `;
    expect(inspectQuota().quota).toMatchObject({ availableCredits: 50, state: "available" });
  });

  it("does not treat the current Free Plan promotion or an empty form as exhausted quota", () => {
    document.body.innerHTML = `
      <button data-testid="profile-menu-button">h4vok <span>Free Plan</span></button>
      <a href="/account?source=sideNav">Upgrade to Pro</a>
      <a href="/listen-and-rank">Earn Credits</a>
      <button type="button" data-disabled="" tabindex="0" disabled aria-label="Create song" data-trigger-disabled="">
        <span>Create</span>
      </button>
    `;

    expect(inspectQuota().quota).toMatchObject({
      createButtonText: "Create",
      details:
        "Composer Create is disabled, but local form readiness and promotional upgrade links are not quota evidence; no remaining-credit count is visible.",
      state: "unknown",
    });
  });

  it.each(["0 credits", "Out of credits", "No credits remaining", "Not enough credits"])(
    "reports exhausted quota only for an explicit signal: %s",
    (message) => {
      document.body.innerHTML = `<p>${message}</p><button disabled>Create</button>`;
      expect(inspectQuota().quota.state).toBe("upgrade");
    },
  );

  it("does not infer quota from an enabled Create song action", () => {
    document.body.innerHTML = `<button aria-label="Create song">Create</button>`;
    const quota = inspectQuota().quota;
    expect(quota.state).toBe("unknown");
    expect(quota.details).toContain("local form readiness");
  });

  it("returns unknown instead of guessing when neither action exists", () => {
    document.body.innerHTML = `<main>Loading composer</main>`;
    expect(inspectQuota().quota.state).toBe("unknown");
  });

  it("fills a draft but cannot click Create while extension gate is off", async () => {
    document.body.innerHTML = composerHtml();
    const create = requireCreateButton();
    const click = vi.spyOn(create, "click");
    const result = await executeCreateCommand(payload, false);

    expect(result.outcome).toBe("drafted");
    expect(document.querySelector<HTMLInputElement>('[placeholder="Title"]')?.value).toBe(
      "Night Engine",
    );
    expect(document.querySelector<HTMLTextAreaElement>('[placeholder="Lyrics"]')?.value).toContain(
      "[Intro:",
    );
    expect(document.querySelector<HTMLInputElement>('[placeholder="Style"]')?.value).toBe(
      "Nocturnal tango, no vocals.",
    );
    expect(document.querySelector<HTMLInputElement>("#instrumental")?.checked).toBe(true);
    expect(click).not.toHaveBeenCalled();
  });

  it("clicks exactly once only with command and extension live gates", async () => {
    document.body.innerHTML = composerHtml();
    const create = requireCreateButton();
    const click = vi.spyOn(create, "click");
    expect((await executeCreateCommand(payload, true)).outcome).toBe("submitted");
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("uses the accessible Create song button before a text fallback", async () => {
    document.body.innerHTML = composerHtml().replace(
      '<button id="create">Create</button>',
      `<div id="decoy" role="button">Create</div>
       <button id="create" aria-label="Create song">Generated wrapper <span>Create</span></button>`,
    );
    const primary = requireCreateButton();
    const decoy = requireCreateElement("#decoy");
    const primaryClick = vi.spyOn(primary, "click");
    const decoyClick = vi.spyOn(decoy, "click");

    expect((await executeCreateCommand(payload, true)).outcome).toBe("submitted");
    expect(primaryClick).toHaveBeenCalledOnce();
    expect(decoyClick).not.toHaveBeenCalled();
  });

  it("reevaluates local readiness after Suno accepts the filled field values", async () => {
    document.body.innerHTML = composerHtml().replace(
      '<button id="create">Create</button>',
      '<button id="create" aria-label="Create song" disabled><span>Create</span></button>',
    );
    const create = requireCreateButton();
    const fields = Array.from(
      document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
        '[placeholder="Title"], [placeholder="Lyrics"], [placeholder="Style"]',
      ),
    );
    const updateReadiness = (): void => {
      create.disabled = fields.some((field) => field.value.length === 0);
    };
    for (const field of fields) {
      field.addEventListener("input", updateReadiness);
    }
    const click = vi.spyOn(create, "click");

    const result = await executeCreateCommand(payload, true);

    expect(result.outcome).toBe("submitted");
    expect(create.disabled).toBe(false);
    expect(click).toHaveBeenCalledOnce();
  });

  it("treats disabled Create after filling as local readiness failure, not quota exhaustion", async () => {
    document.body.innerHTML = composerHtml().replace(
      '<button id="create">Create</button>',
      '<button id="create" aria-label="Create song" disabled><span>Create</span></button>',
    );
    const create = requireCreateButton();
    const click = vi.spyOn(create, "click");

    const result = await executeCreateCommand(payload, true);

    expect(result.outcome).toBe("failed");
    expect(result.details).toContain("local form readiness, not quota evidence");
    expect(click).not.toHaveBeenCalled();
  });

  it("fails closed when a UI change introduces multiple visible Create song actions", async () => {
    document.body.innerHTML = composerHtml().replace(
      '<button id="create">Create</button>',
      `<button id="create" aria-label="Create song">Create</button>
       <button id="duplicate" aria-label="Create song">Create</button>`,
    );
    const first = requireCreateButton();
    const duplicate = requireCreateElement("#duplicate");
    const firstClick = vi.spyOn(first, "click");
    const duplicateClick = vi.spyOn(duplicate, "click");

    const result = await executeCreateCommand(payload, true);

    expect(result).toMatchObject({
      details: "Composer Create action not found.",
      outcome: "failed",
    });
    expect(firstClick).not.toHaveBeenCalled();
    expect(duplicateClick).not.toHaveBeenCalled();
  });

  it("fails closed when any required field is missing", async () => {
    document.body.innerHTML = `<input placeholder="Title"><button id="create">Create</button>`;
    const create = requireCreateButton();
    const click = vi.spyOn(create, "click");
    const result = await executeCreateCommand(payload, true);
    expect(result).toMatchObject({ outcome: "failed" });
    expect(result.details).toMatch(/lyrics, style/u);
    expect(click).not.toHaveBeenCalled();
  });

  it("cannot submit when Instrumental control is missing", async () => {
    document.body.innerHTML = `
      <input placeholder="Title">
      <textarea placeholder="Lyrics"></textarea>
      <input placeholder="Style">
      <button id="create">Create</button>
    `;
    const create = requireCreateButton();
    const click = vi.spyOn(create, "click");
    const result = await executeCreateCommand(payload, true);
    expect(result).toMatchObject({ outcome: "failed" });
    expect(result.details).toMatch(/Instrumental control/u);
    expect(click).not.toHaveBeenCalled();
  });

  it("cannot submit when Instrumental is present but cannot be enabled", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = composerHtml().replace(
      '<input id="instrumental" type="checkbox">',
      '<input id="instrumental" type="checkbox" disabled>',
    );
    const create = requireCreateButton();
    const click = vi.spyOn(create, "click");
    const pending = executeCreateCommand(payload, true);
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result).toMatchObject({ outcome: "failed" });
    expect(result.details).toMatch(/could not be enabled/u);
    expect(click).not.toHaveBeenCalled();
  });

  it.each([
    ['[placeholder="Title"]', "title"],
    ['[placeholder="Lyrics"]', "lyrics"],
    ['[placeholder="Style"]', "style"],
  ])("cannot submit when the controlled %s field rejects its value", async (selector, name) => {
    document.body.innerHTML = composerHtml();
    const field = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
    if (field === null) {
      throw new Error(`Test fixture must include ${name}.`);
    }
    field.addEventListener("input", () => {
      field.value = "";
    });
    const create = requireCreateButton();
    const click = vi.spyOn(create, "click");
    const result = await executeCreateCommand(payload, true);
    expect(result).toMatchObject({ outcome: "failed" });
    expect(result.details).toContain(name);
    expect(click).not.toHaveBeenCalled();
  });

  it("supports semantic fallback selectors without relaxing the live gate", async () => {
    document.body.innerHTML = `
      <input name="song-title">
      <div contenteditable="true" data-placeholder="Lyrics"></div>
      <textarea name="style-tags"></textarea>
      <button id="instrumental-switch" role="switch" aria-checked="false">Instrumental</button>
      <div id="create" role="button">Create</div>
    `;
    document.querySelector("#instrumental-switch")?.addEventListener("click", (event) => {
      (event.currentTarget as HTMLElement).setAttribute("aria-checked", "true");
    });
    const create = requireCreateElement();
    const click = vi.spyOn(create, "click");
    const result = await executeCreateCommand(payload, false);
    expect(result.outcome).toBe("drafted");
    expect(document.querySelector<HTMLInputElement>('[name="song-title"]')?.value).toBe(
      payload.draft.title,
    );
    expect(document.querySelector<HTMLElement>('[contenteditable="true"]')?.textContent).toBe(
      payload.draft.lyricsField,
    );
    expect(document.querySelector<HTMLTextAreaElement>('[name="style-tags"]')?.value).toBe(
      payload.draft.styleField,
    );
    expect(click).not.toHaveBeenCalled();
  });

  it("activates Custom mode before locating composer fields", async () => {
    document.body.innerHTML = `
      <button id="custom">Custom</button>
      <input placeholder="Title">
      <input placeholder="Style">
      <label>Instrumental <input id="instrumental" type="checkbox"></label>
      <button id="create">Create</button>
    `;
    document.querySelector("#custom")?.addEventListener("click", () => {
      const lyrics = document.createElement("textarea");
      lyrics.placeholder = "Lyrics";
      document.body.append(lyrics);
    });
    expect((await executeCreateCommand(payload, false)).outcome).toBe("drafted");
    expect(document.querySelector<HTMLTextAreaElement>('[placeholder="Lyrics"]')?.value).toBe(
      payload.draft.lyricsField,
    );
  });
});

function composerHtml(): string {
  return `
    <input placeholder="Title">
    <textarea placeholder="Lyrics"></textarea>
    <input placeholder="Style">
    <label>Instrumental <input id="instrumental" type="checkbox"></label>
    <button id="create">Create</button>
  `;
}

function requireCreateButton(): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>("#create");
  if (button === null) {
    throw new Error("Test fixture must include Create button.");
  }
  return button;
}

function requireCreateElement(selector = "#create"): HTMLElement {
  const element = document.querySelector<HTMLElement>(selector);
  if (element === null) {
    throw new Error("Test fixture must include Create element.");
  }
  return element;
}
