import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(testDir, "..");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

test("package claims no bundled pi-mcp-adapter and no own gentle/adapter dependency", async () => {
  const manifest = readJson(join(root, "package.json"));
  assert.equal(manifest.dependencies?.["pi-mcp-adapter"], undefined, "jorgex-pi must not depend on its own pi-mcp-adapter copy");
  assert.equal(manifest.dependencies?.["gentle-engram"], undefined, "jorgex-pi must not bundle gentle-engram; setup owns it");
  assert.ok(
    manifest.bundledDependencies === undefined || !manifest.bundledDependencies.includes("pi-mcp-adapter"),
    "bundledDependencies must not claim the external adapter",
  );
  const lock = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
  // The lock must not resolve a JorgeX-owned adapter closure entry for the package itself.
  // Provider-managed resolution happens via `engram setup pi`, not pnpm.
  assert.doesNotMatch(lock, /pi-mcp-adapter@2\.27\.0/, "lock must not pin the retired bundled adapter");
});

test("component inventory no longer owns the adapter transport", async () => {
  const inventory = readJson(join(root, "contract", "components.v1.json"));
  const names = inventory.components.map(({ name }) => name);
  assert.equal(names.includes("pi-mcp-adapter"), false, "components.v1.json must not list pi-mcp-adapter as an owned component");
  assert.equal(names.includes("gentle-engram"), false, "components.v1.json must not claim gentle-engram as owned either");
});

test("capability migrates from owned adapter to official bridge", async () => {
  const contract = readJson(join(root, "contract", "jorgex-pi.v1.json"));
  assert.ok(contract.capabilities.includes("engram-runtime-tools-v1"), "official bridge keeps engram-runtime-tools-v1");
  assert.ok(contract.capabilities.includes("engram-official-bridge-v1"), "official bridge declares engram-official-bridge-v1");
  assert.equal(contract.capabilities.includes("mcp-adapter-v1"), false, "owned mcp-adapter-v1 must retire with the bundled transport");
});

test("assets preserve official external state and never claim managed MCP writes", async () => {
  const assets = readJson(join(root, "contract", "assets.v1.json"));
  const preserved = assets.preservedExternalState ?? [];
  const has = (owner, relativePath) => preserved.some((entry) => entry.owner === owner && entry.relativePath === relativePath);
  assert.equal(has("user", "mcp.json"), true, "mcp.json stays user-owned external state");
  assert.ok(
    preserved.some(({ relativePath }) => relativePath === "mcp-cache.json"),
    "mcp cache stays preserved external state",
  );
  // Official packages, binary and DB are provider-owned and must survive cleanup/uninstall.
  assert.ok(
    preserved.some(({ relativePath }) => /gentle-engram|pi-mcp-adapter|packages/i.test(`${relativePath}`) || /global.*package|npm/i.test(JSON.stringify(preserved))),
    "official global packages stay preserved external state",
  );
  const hasAt = (owner, root, relativePath) =>
    preserved.some((entry) => entry.owner === owner && entry.root === root && entry.relativePath === relativePath);
  assert.equal(
    hasAt("engram", "HOME", ".local/bin/engram"),
    true,
    "Engram binary stays preserved external state at HOME .local/bin/engram",
  );
  assert.equal(
    hasAt("engram", "HOME", ".engram"),
    true,
    "Engram registry stays preserved external state at HOME .engram as the owned external tree",
  );
  for (const invented of [".engram/bin/engram", ".engram/engram.db", ".engram/memories"]) {
    assert.equal(
      preserved.some((entry) => entry.relativePath === invented),
      false,
      `package must not invent preserved external state at ${invented}`,
    );
  }
  for (const write of assets.managedExternalWrites ?? []) {
    assert.doesNotMatch(write.relativePath ?? "", /^mcp\.json$|^mcp-cache\.json$/, "Pi must never claim managed writes over official MCP state");
  }
});

test("cleanup/status/doctor preserve external state and use no fallback factory (source)", async () => {
  const runnerSource = readFileSync(join(root, "bin", "jorgex-pi.mjs"), "utf8");
  const bridgeSource = readFileSync(join(root, "extensions", "mcp-engram.ts"), "utf8");
  const bootstrapSource = readFileSync(join(root, "extensions", "bootstrap.ts"), "utf8");
  assert.doesNotMatch(bridgeSource, /createMcpAdapter/, "no bundled factory fallback when official setup is missing");
  assert.doesNotMatch(bootstrapSource, /createMcpAdapter/, "bootstrap must not fall back to a bundled factory");
  // Runner diagnostics must not silently install or mutate official state;
  // cleanup only removes receipt-owned lifecycle fields, never external MCP/bin/DB.
  assert.doesNotMatch(runnerSource, /unlinkSync\(.*mcp\.json|writeFileSync\(.*mcp\.json/m, "runner must never write or delete mcp.json");
  assert.ok(runnerSource.includes("cleanupLifecycle"), "runner keeps its ownership-safe cleanup seam");
});
