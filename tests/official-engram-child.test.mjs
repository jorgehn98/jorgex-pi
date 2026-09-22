import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(testDir, "..");

test("engram-child shim is not a packaged asset or agent requirement", () => {
  assert.equal(
    existsSync(join(root, "extensions", "engram-child.ts")),
    false,
    "extensions/engram-child.ts must not exist; gentle-engram loads ambiently",
  );
  const agentSource = readFileSync(join(root, "agents", "engram.md"), "utf8");
  assert.doesNotMatch(
    agentSource,
    /engram-child/,
    "engram agent must not reference a package-local child shim",
  );
  const contract = JSON.parse(readFileSync(join(root, "contract", "runtime-agents.v1.json"), "utf8"));
  const engramEntry = contract.agents.find(({ name }) => name === "engram");
  assert.deepEqual(
    engramEntry?.subagentOnlyExtensions ?? [],
    [],
    "generated contract must not require the Engram shim",
  );
  const generatorSource = readFileSync(join(root, "scripts", "generate-runtime-agents.mjs"), "utf8");
  assert.doesNotMatch(
    generatorSource,
    /engram-child/,
    "generator must not reintroduce the package-local shim",
  );
});

test("child sets no MCP_DIRECT_TOOLS and loads no JorgeX Engram selector", () => {
  assert.equal(
    existsSync(join(root, "extensions", "engram-child.ts")),
    false,
    "no child shim may exist to wire MCP_DIRECT_TOOLS",
  );
  const extensionSources = readdirSync(join(root, "extensions"))
    .filter((name) => name.endsWith(".ts") || name.endsWith(".mjs"))
    .map((name) => ({ name, source: readFileSync(join(root, "extensions", name), "utf8") }));
  for (const { name, source } of extensionSources) {
    assert.doesNotMatch(
      source,
      /ENGRAM_CHILD_ALLOWED_TOOLS/,
      `${name} must not carry a JorgeX six-read selector`,
    );
    assert.doesNotMatch(
      source,
      /MCP_DIRECT_TOOLS\s*=\s*["'](__none__|engram\/)/,
      `${name} must not establish MCP_DIRECT_TOOLS for the child`,
    );
  }
  const agentSource = readFileSync(join(root, "agents", "engram.md"), "utf8");
  const toolsLine = agentSource.split("\n").find((line) => line.startsWith("tools:"));
  assert.equal(toolsLine, undefined, "engram agent must omit tools so normal extensions/tools including official gentle-engram load unchanged; empty tools: would emit --no-tools");
});

test("engram agent keeps general shell/subdelegation restrictions without an Engram selector", () => {
  const agentSource = readFileSync(join(root, "agents", "engram.md"), "utf8");
  assert.match(agentSource, /maxSubagentDepth:\s*0/, "general subdelegation restriction remains");
  assert.equal(
    agentSource.split("\n").some((line) => line.startsWith("tools:")),
    false,
    "engram agent must omit tools; empty tools: would emit --no-tools and block ambient gentle-engram",
  );
  assert.equal(
    agentSource.includes("subagentOnlyExtensions: ../extensions/engram-child.ts"),
    false,
    "general restrictions remain without the package-local shim",
  );
});
