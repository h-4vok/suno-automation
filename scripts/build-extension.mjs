import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, "extension/dist");
const manifestPath = resolve(root, "extension/manifest.json");
const manifest = /** @type {unknown} */ (JSON.parse(await readFile(manifestPath, "utf8")));

if (
  typeof manifest !== "object" ||
  manifest === null ||
  !("version" in manifest) ||
  typeof manifest.version !== "string"
) {
  throw new Error("Extension manifest must contain a version.");
}
const extensionVersion = manifest.version;

await rm(output, { force: true, recursive: true });
await mkdir(output, { recursive: true });
await build({
  bundle: true,
  entryPoints: {
    content: resolve(root, "extension/src/content.ts"),
    options: resolve(root, "extension/src/options.ts"),
    "service-worker": resolve(root, "extension/src/service-worker.ts"),
  },
  format: "esm",
  minify: false,
  outdir: output,
  sourcemap: true,
  target: "chrome120",
});
await Promise.all(
  ["manifest.json", "options.html", "options.css"].map((name) =>
    cp(resolve(root, `extension/${name}`), resolve(output, name)),
  ),
);
await writeFile(
  resolve(output, "LOAD_THIS_FOLDER.txt"),
  [
    `Suno Daily Credit Assistant v${extensionVersion}`,
    "Load this directory in Brave as the unpacked extension:",
    output,
    "",
    "The extension source directory is not the installable package.",
  ].join("\n"),
  "utf8",
);

process.stdout.write(`Extension v${extensionVersion} built at ${output}\n`);
