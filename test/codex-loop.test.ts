import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "..");

async function executableRepositoryText(): Promise<string> {
  const workflowDirectory = resolve(repositoryRoot, ".github", "workflows");
  const scriptDirectory = resolve(repositoryRoot, "scripts");
  const workflowFiles = (await readdir(workflowDirectory)).filter((file) =>
    /\.(yaml|yml)$/i.test(file),
  );
  const scriptFiles = (await readdir(scriptDirectory)).filter((file) =>
    /\.(mjs|ps1|ts)$/i.test(file),
  );
  const files = [
    ...workflowFiles.map((file) => readFile(resolve(workflowDirectory, file), "utf8")),
    ...scriptFiles.map((file) => readFile(resolve(scriptDirectory, file), "utf8")),
    readFile(resolve(repositoryRoot, "package.json"), "utf8"),
  ];
  return (await Promise.all(files)).join("\n");
}

describe("Codex execution boundary", () => {
  it("does not expose a GitHub Actions trigger for Codex Cloud", async () => {
    const executableText = await executableRepositoryText();

    expect(executableText).not.toMatch(/openai\/codex-action/i);
    expect(executableText).not.toMatch(/OPENAI_API_KEY/i);
    expect(executableText).not.toMatch(/codex-ready/i);
  });
});
