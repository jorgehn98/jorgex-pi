import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const testDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(testDir, "..");
const expected = readJson(join(testDir, "fixtures", "mcp-engram.expected.json"));
const jiti = createJiti(import.meta.url, { moduleCache: false });

test("the exact MCP adapter and its reviewed deep config seam are package-local", async () => {
  const manifest = readJson(join(root, "package.json"));
  const component = readJson(join(root, "contract", "components.v1.json")).components
    .find(({ name }) => name === expected.adapter.name);
  assert.equal(manifest.dependencies?.[expected.adapter.name], expected.adapter.version);
  assert.equal(manifest.bundledDependencies?.includes(expected.adapter.name), true);
  assert.deepEqual(
    { status: component?.status, version: component?.version, integrity: component?.integrity },
    { status: "active", version: expected.adapter.version, integrity: expected.adapter.integrity },
  );
  const adapterEntry = import.meta.resolve(expected.adapter.name);
  const deepConfig = new URL(`./${expected.adapter.deepConfigPath}`, adapterEntry);
  assert.equal(existsSync(fileURLToPath(deepConfig)), true, "the pinned tarball must retain config.ts beside its entrypoint");
  const deepModule = await jiti.import(deepConfig.href);
  assert.equal(typeof deepModule.loadMcpConfig, "function", "JorgeX must merge the adapter's reviewed ambient snapshot instead of reimplementing discovery");
});

test("managed Engram merges one lazy direct server without mutating ambient MCP config", async () => {
  const { resolveMcpEngramConfig } = await import("../extensions/mcp-engram.ts");
  const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-mcp-merge-"));
  const fakeBin = join(sandbox, process.platform === "win32" ? "engram.exe" : "engram");
  const nodePath = resolve(process.execPath);
  const wrapperPath = join(root, "extensions", "engram-mcp-wrapper.mjs");
  mkdirSync(dirname(fakeBin), { recursive: true });
  writeFileSync(fakeBin, "fake binary; never execute\n");
  chmodSync(fakeBin, 0o755);
  const ambient = {
    mcpServers: { foreign: { command: "/foreign/bin", args: ["serve"], env: { KEEP: "yes" } } },
    imports: ["codex"],
    settings: { scriptMode: false, hostConfigDiscovery: "off" },
  };
  const before = structuredClone(ambient);
  try {
    const result = await resolveMcpEngramConfig({
      loadMcpConfig: () => ambient,
      resolveEngramBinary: () => fakeBin,
      nodePath,
      wrapperPath,
      env: { HOME: "/safe/home", NODE_OPTIONS: "--require hostile", ENGRAM_CLOUD_TOKEN: "must-not-pass" },
    });
    assert.equal(result.state, "managed");
    assert.deepEqual(ambient, before, "the adapter-owned ambient snapshot must remain immutable");
    assert.deepEqual(result.config.imports, before.imports);
    assert.deepEqual(result.config.settings, before.settings);
    assert.deepEqual(result.config.mcpServers.foreign, before.mcpServers.foreign);
    assert.deepEqual(result.config.mcpServers.engram, {
      command: nodePath,
      args: [wrapperPath, fakeBin],
      lifecycle: expected.server.lifecycle,
      directTools: expected.server.directTools,
      toolPrefix: expected.server.toolPrefix,
      excludeTools: expected.engramProfile.excludedTools,
    });
    assert.equal(isAbsolute(result.config.mcpServers.engram.command), true);
    assert.equal(isAbsolute(result.config.mcpServers.engram.args[0]), true);
    assert.equal(isAbsolute(result.config.mcpServers.engram.args[1]), true);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("missing or colliding Engram leaves the complete ambient MCP snapshot authoritative", async () => {
  const { resolveMcpEngramConfig } = await import("../extensions/mcp-engram.ts");
  const foreign = { command: "/user/engram", args: ["custom"], env: { OWNER: "user" } };
  const collision = { mcpServers: { engram: foreign, other: { url: "https://example.invalid/mcp" } }, settings: { scriptMode: false } };
  const collisionBefore = structuredClone(collision);
  const collided = await resolveMcpEngramConfig({ loadMcpConfig: () => collision, resolveEngramBinary: () => "/managed/engram" });
  assert.equal(collided.state, "collision");
  assert.deepEqual(collided.config, collisionBefore);
  assert.deepEqual(collision, collisionBefore);

  const ambient = { mcpServers: { other: { command: "/other" } }, imports: ["codex"] };
  const missing = await resolveMcpEngramConfig({ loadMcpConfig: () => ambient, resolveEngramBinary: () => undefined });
  assert.equal(missing.state, "missing");
  assert.deepEqual(missing.config, ambient);
  assert.equal(Object.hasOwn(missing.config.mcpServers, "engram"), false);

  const failed = await resolveMcpEngramConfig({ loadMcpConfig: () => ambient, resolveEngramBinary: () => { throw new Error("resolver failed"); } });
  assert.equal(failed.state, "failed");
  assert.deepEqual(failed.config, ambient);
  assert.match(failed.reason ?? "", /resolver failed/);
});

test("the pinned adapter metadata seam yields exactly the 17 reviewed direct Engram tools", async () => {
  const { resolveMcpEngramConfig } = await import("../extensions/mcp-engram.ts");
  const adapterEntry = import.meta.resolve(expected.adapter.name);
  const [{ resolveDirectTools }, { computeServerHash }] = await Promise.all([
    jiti.import(new URL("./direct-tools.ts", adapterEntry).href),
    jiti.import(new URL("./metadata-cache.ts", adapterEntry).href),
  ]);
  const managed = await resolveMcpEngramConfig({
    loadMcpConfig: () => ({ mcpServers: {} }),
    resolveEngramBinary: () => resolve(process.execPath),
    nodePath: resolve(process.execPath),
    wrapperPath: join(root, "extensions", "engram-mcp-wrapper.mjs"),
    env: {},
  });
  const server = managed.config.mcpServers.engram;
  const advertised = [...expected.engramProfile.tools, ...expected.engramProfile.excludedTools]
    .map((name) => ({ name, description: name, inputSchema: { type: "object", properties: {} } }));
  const cache = {
    version: 1,
    servers: {
      engram: {
        configHash: computeServerHash(server),
        cachedAt: Date.now(),
        tools: advertised,
        resources: [],
        prompts: [],
      },
    },
  };
  const direct = resolveDirectTools(managed.config, cache, "server").map(({ prefixedName }) => prefixedName);
  assert.deepEqual(direct, expected.engramProfile.tools);
  assert.equal(direct.length, 17);
  assert.equal(direct.includes("mem_capture_passive"), false);
});

test("the wrapper executes only the validated absolute Engram binary with canonical argv and an exact env allowlist", async () => {
  const { buildEngramChildSpec } = await import("../extensions/mcp-engram.ts");
  const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-engram-child-"));
  const fakeBin = resolve(sandbox, process.platform === "win32" ? "engram.exe" : "engram");
  writeFileSync(fakeBin, "fake binary; never execute\n");
  chmodSync(fakeBin, 0o755);
  const sourceEnv = Object.fromEntries(expected.childEnvKeys.map((key) => [key, `safe-${key}`]));
  Object.assign(sourceEnv, {
    PATH: "/hostile/path",
    PATHEXT: ".CMD;.EXE",
    NODE_OPTIONS: "--require hostile",
    npm_config_userconfig: "/secret/npmrc",
    ENGRAM_CLOUD_AUTOSYNC: "1",
    ENGRAM_CLOUD_TOKEN: "secret",
    ENGRAM_CLOUD_SERVER: "https://secret.invalid",
    DATABASE_URL: "secret",
    HTTP_PROXY: "secret",
    JWT_SECRET: "secret",
  });
  try {
    const child = buildEngramChildSpec({ binary: fakeBin, env: sourceEnv });
    assert.deepEqual(child, {
      file: fakeBin,
      args: expected.server.args,
      options: {
        env: Object.fromEntries(expected.childEnvKeys.map((key) => [key, `safe-${key}`])),
        shell: false,
      },
    });
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("one compaction produces one ordered Engram recovery instruction", async () => {
  const { registerEngramCompactionRecovery } = await import("../extensions/mcp-engram.ts");
  const lifecycle = new Map();
  const pi = { on(name, handler) { lifecycle.set(name, [...(lifecycle.get(name) ?? []), handler]); } };
  registerEngramCompactionRecovery(pi, { isAvailable: () => true });
  assert.equal((lifecycle.get("session_compact") ?? []).length, 1);
  assert.equal((lifecycle.get("before_agent_start") ?? []).length, 1);
  await lifecycle.get("session_compact")[0]({ summary: "compacted work" }, { sessionId: "one" });
  const first = await lifecycle.get("before_agent_start")[0]({ systemPrompt: "Base" }, { sessionId: "one" });
  assert.match(first.systemPrompt, /FIRST ACTION REQUIRED/i);
  assert.match(first.systemPrompt, /mem_session_summary/);
  assert.match(first.systemPrompt, /mem_context/);
  assert.ok(first.systemPrompt.indexOf("mem_session_summary") < first.systemPrompt.indexOf("mem_context"));
  const second = await lifecycle.get("before_agent_start")[0]({ systemPrompt: "Base" }, { sessionId: "one" });
  assert.doesNotMatch(second.systemPrompt, /FIRST ACTION REQUIRED/i, "the recovery instruction must be consumed exactly once");
});

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
