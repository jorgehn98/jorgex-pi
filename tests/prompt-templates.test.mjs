import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = readJson(join(root, "package.json"));
const parity = readJson(join(root, "contract", "parity.v2.json"));
const piPackageRoot = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
const piPackage = readJson(join(piPackageRoot, "package.json"));
const { expandPromptTemplate, loadPromptTemplates } = await import(
  pathToFileURL(join(piPackageRoot, "dist", "core", "prompt-templates.js")).href,
);

test("Pi 0.84.2 discovers lean-audit and expands its supplied arguments", () => {
  assert.equal(manifest.devDependencies?.["@earendil-works/pi-coding-agent"], "0.84.2");
  assert.equal(piPackage.version, "0.84.2", "the exercised prompt-template module must be the contract's real Pi version");

  const command = parity.commands.find(({ name }) => name === "lean-audit");
  assert.ok(command, "parity v2 must publish the lean-audit command");
  const promptPath = join(root, command.targetPath);
  const templates = loadPromptTemplates({
    cwd: root,
    agentDir: join(root, ".missing-prompt-template-agent-dir"),
    promptPaths: manifest.pi.prompts.map((path) => join(root, path)),
    includeDefaults: false,
  });
  const template = templates.find(({ name }) => name === command.name);

  assert.equal(template?.filePath, promptPath, "Pi must discover the package-owned lean-audit prompt from pi.prompts");
  const expanded = expandPromptTemplate('/lean-audit src/billing "release candidate"', templates);
  assert.match(expanded, /User input \(may be empty\): src\/billing release candidate/);
  assert.doesNotMatch(expanded, /\$ARGUMENTS/, "Pi must substitute the prompt's portable argument placeholder");
});

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
