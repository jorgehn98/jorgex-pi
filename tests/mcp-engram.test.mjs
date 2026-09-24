import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, win32 } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(testDir, "..");
const expected = readJson(join(testDir, "fixtures", "mcp-engram.expected.json"));
const expectedContext7Config = {
  url: expected.context7.url,
  auth: expected.context7.auth,
  lifecycle: expected.context7.lifecycle,
  directTools: expected.context7.directTools,
};

test("the official bridge owns no bundled adapter and verifies over the external event bus", async () => {
  const manifest = readJson(join(root, "package.json"));
  const contract = readJson(join(root, "contract", "jorgex-pi.v1.json"));
  const inventory = readJson(join(root, "contract", "components.v1.json"));
  const names = inventory.components.map(({ name }) => name);
  assert.equal(manifest.dependencies?.["pi-mcp-adapter"], undefined, "jorgex-pi must not depend on its own adapter copy");
  assert.equal(manifest.dependencies?.["gentle-engram"], undefined, "jorgex-pi must not bundle gentle-engram; setup owns it");
  assert.ok(
    manifest.bundledDependencies === undefined || !manifest.bundledDependencies.includes("pi-mcp-adapter"),
    "bundledDependencies must not claim the external adapter",
  );
  assert.equal(names.includes("pi-mcp-adapter"), false, "components must not list the external adapter as owned");
  assert.equal(names.includes("gentle-engram"), false, "components must not claim gentle-engram as owned");
  assert.ok(contract.capabilities.includes(expected.bridge.capability), "contract must declare the official bridge capability");
  assert.ok(contract.capabilities.includes(expected.bridge.runtimeToolsCapability), "contract must keep the runtime tools capability");
  assert.equal(contract.capabilities.includes("mcp-adapter-v1"), false, "owned mcp-adapter-v1 must retire with the bundled transport");
  assert.equal(expected.bridge.event, "pi-mcp-adapter:runtime-register:v1", "bridge event stays versioned");
  assert.equal(expected.bridge.version, 1, "bridge request version stays 1");
  const bridgeSource = readFileSync(join(root, "extensions", "mcp-engram.ts"), "utf8");
  const bootstrapSource = readFileSync(join(root, "extensions", "bootstrap.ts"), "utf8");
  assert.doesNotMatch(bridgeSource, /createMcpAdapter/, "bridge must not keep the bundled factory fallback");
  assert.doesNotMatch(bootstrapSource, /createMcpAdapter/, "bootstrap must register via runtime-register, not the bundled factory");
  assert.doesNotMatch(bridgeSource, /import\.meta\.resolve\(["']pi-mcp-adapter["']\)/, "bridge must not runtime-import its own adapter copy");
});

test("Context7 inspection recognizes a direct Pi config without importing or rewriting it", async () => {
  const { inspectContext7Config } = await import("../extensions/context7-config.mjs");
  const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-context7-inspection-"));
  const home = join(sandbox, "home");
  const agentDir = join(sandbox, "agent");
  const configPath = join(agentDir, "mcp.json");
  const env = {
    HOME: home,
    USERPROFILE: home,
    PI_CODING_AGENT_DIR: agentDir,
    XDG_CONFIG_HOME: join(sandbox, "xdg-config"),
  };
  mkdirSync(agentDir, { recursive: true });

  try {
    const missing = inspectContext7Config({ env, cwd: sandbox, platform: process.platform });
    assert.equal(missing.state, "missing", "absent official packages fail closed as missing (total gate)");
    assert.equal(missing.source, "pi-global-settings");

    const previousBytes = `{
  // User-owned MCP configuration must remain byte-identical.
  "mcpServers": {
    "context7": { "url": "https://example.invalid/user-context7" },
    "user-server": { "url": "https://example.invalid/foreign" },
  },
}\n`;
    const sourcePaths = [
      ["shared-global", join(home, ".config", "mcp", "mcp.json")],
      ["agents-global", join(home, ".agents", "mcp.json")],
      ["agents-nested-global", join(home, ".agents", "mcp", "mcp.json")],
      ["pi-global", configPath],
      ["shared-project", join(sandbox, ".mcp.json")],
      ["pi-project", join(sandbox, ".pi", "mcp.json")],
    ];
    for (const [source, sourcePath] of sourcePaths) {
      mkdirSync(dirname(sourcePath), { recursive: true });
      writeFileSync(sourcePath, previousBytes);
      const conflict = inspectContext7Config({ env, cwd: sandbox, platform: process.platform });
      assert.equal(conflict.state, "conflict", sourcePath);
      assert.equal(conflict.source, source, sourcePath);
      assert.equal(readFileSync(sourcePath, "utf8"), previousBytes, "inspection must be read-only");
      rmSync(sourcePath, { force: true });
    }

    writeFileSync(configPath, "{\n  \"imports\": [\"codex\"],\n  \"mcpServers\": {}\n}\n");
    const imported = inspectContext7Config({ env, cwd: sandbox, platform: process.platform });
    assert.equal(imported.state, "invalid", "unverifiable imported configuration must fail closed");
    assert.equal(imported.source, "pi-global");
    writeFileSync(configPath, "{ invalid json\n");
    const invalid = inspectContext7Config({ env, cwd: sandbox, platform: process.platform });
    assert.equal(invalid.state, "invalid");
    assert.equal(invalid.source, "pi-global");

    rmSync(configPath, { force: true });
    const settingsPath = join(agentDir, "settings.json");
    // The official setup owns exactly one global gentle-engram@semver plus one
    // global pi-mcp-adapter: that single pair is the required owner, never a
    // conflict. A lone adapter without its gentle pair is an incomplete setup.
    const officialBytes = `${JSON.stringify({ packages: ["npm:gentle-engram@0.1.13", "npm:pi-mcp-adapter@2.36.0"], foreign: true }, null, 2)}\n`;
    writeFileSync(settingsPath, officialBytes);
    const officialPair = inspectContext7Config({ env, cwd: sandbox, platform: process.platform });
    assert.equal(officialPair.state, "available");
    assert.equal(readFileSync(settingsPath, "utf8"), officialBytes, "official pair detection must be read-only");

    const loneBytes = `${JSON.stringify({ packages: ["npm:pi-mcp-adapter@2.27.0"], foreign: true }, null, 2)}\n`;
    writeFileSync(settingsPath, loneBytes);
    const loneAdapter = inspectContext7Config({ env, cwd: sandbox, platform: process.platform });
    assert.equal(loneAdapter.state, "missing");
    assert.equal(loneAdapter.source, "pi-global-settings");
    assert.equal(loneAdapter.code, "missing-official-packages");
    assert.equal(readFileSync(settingsPath, "utf8"), loneBytes, "incomplete setup detection must be read-only");
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("Context7 and Engram resolution expand a tilde agent directory under an isolated HOME", async () => {
  const { inspectContext7Config } = await import("../extensions/context7-config.mjs");
  const { resolveConfiguredEngramBinary, resolveMcpEngramConfig } = await import("../extensions/mcp-engram.ts");
  const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-mcp-tilde-agent-"));
  const home = join(sandbox, "home");
  const resolvedAgentDir = join(home, ".pi", "agent");
  const tildeAgentDir = "~/.pi/agent";
  const configPath = join(resolvedAgentDir, "mcp.json");
  const fakeBin = join(sandbox, process.platform === "win32" ? "engram.exe" : "engram");
  const manifest = readJson(join(root, "package.json"));
  const env = {
    HOME: home,
    USERPROFILE: home,
    PI_CODING_AGENT_DIR: tildeAgentDir,
  };
  const previousConfig = {
    mcpServers: {
      context7: { url: "https://example.invalid/user-context7" },
      foreign: { url: "https://example.invalid/foreign" },
      engram: { command: fakeBin, args: ["mcp", "--tools=agent"], lifecycle: "lazy", directTools: false },
    },
  };
  const previousBytes = `${JSON.stringify(previousConfig, null, 2)}\n`;
  mkdirSync(resolvedAgentDir, { recursive: true });
  writeFileSync(configPath, previousBytes);
  writeFileSync(join(resolvedAgentDir, "settings.json"), JSON.stringify({ packages: ["npm:gentle-engram@0.1.13", "npm:pi-mcp-adapter@2.36.0"] }));
  writeFileSync(fakeBin, "fake binary; never execute\n");
  chmodSync(fakeBin, 0o755);
  writeReceipt(
    join(home, ".jorgex-stack", "pi-receipt.json"),
    createReceipt({
      source: `npm:jorgex-pi@${manifest.version}`,
      version: manifest.version,
      codingAgentDir: resolvedAgentDir,
      binary: fakeBin,
    }),
  );

  try {
    const context7 = inspectContext7Config({ env, cwd: sandbox, platform: process.platform });
    assert.equal(context7.state, "conflict");
    assert.equal(context7.source, "pi-global");
    assert.equal(readFileSync(configPath, "utf8"), previousBytes);

    assert.equal(
      resolveConfiguredEngramBinary({ env, platform: process.platform }),
      fakeBin,
      "the managed receipt must match Pi's tilde-normalized agent directory",
    );
    const bridge = await resolveMcpEngramConfig({
      env,
      platform: process.platform,
      cwd: sandbox,
    });
    assert.equal(bridge.state, "managed");
    assert.equal(bridge.context7?.state, "conflict");
    assert.equal(bridge.config.mcpServers.context7, undefined);
    assert.equal(bridge.config.mcpServers.engram.command, fakeBin);
    assert.deepEqual(bridge.config.mcpServers.engram.args, ["mcp", "--tools=agent"]);
    assert.equal(existsSync(join(sandbox, "~")), false, "tilde expansion must not write a literal relative directory");
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("managed Engram registers anonymous Context7 over HTTP and keeps an optional key as an env reference", async () => {
  const { resolveMcpEngramConfig } = await import("../extensions/mcp-engram.ts");
  const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-mcp-context7-config-"));
  const fakeBin = join(sandbox, process.platform === "win32" ? "engram.exe" : "engram");
  writeFileSync(fakeBin, "fake binary; never execute\n");
  chmodSync(fakeBin, 0o755);
  const agentDir = join(sandbox, "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:gentle-engram@0.1.13", "npm:pi-mcp-adapter@2.36.0"] }));
  writeFileSync(join(agentDir, "mcp.json"), `${JSON.stringify({ mcpServers: { engram: { command: fakeBin, args: ["mcp", "--tools=agent"], lifecycle: "lazy", directTools: false } } }, null, 2)}\n`);
  try {
    const anonymous = await resolveMcpEngramConfig({
      resolveEngramBinary: () => fakeBin,
      env: { HOME: join(sandbox, "home"), PI_CODING_AGENT_DIR: agentDir },
    });
    assert.equal(anonymous.state, "managed");
    assert.equal(anonymous.context7?.state, "available", "Context7 must be available for managed registration when no prior definition exists");
    assert.deepEqual(anonymous.config.mcpServers.context7, expectedContext7Config);
    assert.equal("headers" in anonymous.config.mcpServers.context7, false, "an absent key must omit the HTTP header");
    assert.doesNotMatch(JSON.stringify(anonymous.config), /CONTEXT7_API_KEY|fixture-context7-token/);

    const emptyKey = await resolveMcpEngramConfig({
      resolveEngramBinary: () => fakeBin,
      env: { HOME: join(sandbox, "home"), PI_CODING_AGENT_DIR: agentDir, CONTEXT7_API_KEY: "  " },
    });
    assert.equal(emptyKey.context7?.state, "available");
    assert.equal("headers" in emptyKey.config.mcpServers.context7, false, "an empty key must not create an empty HTTP header");

    const keyed = await resolveMcpEngramConfig({
      resolveEngramBinary: () => fakeBin,
      env: { HOME: join(sandbox, "home"), PI_CODING_AGENT_DIR: agentDir, CONTEXT7_API_KEY: "fixture-context7-token" },
    });
    assert.equal(keyed.state, "managed");
    assert.equal(keyed.context7?.state, "available");
    assert.deepEqual(keyed.config.mcpServers.context7, {
      ...expectedContext7Config,
      headers: { CONTEXT7_API_KEY: "${CONTEXT7_API_KEY}" },
    });
    assert.equal(JSON.stringify(keyed.config).includes("fixture-context7-token"), false, "the runtime key must never be persisted in managed config");
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("a previous homonymous Context7 config is preserved and blocks only managed Context7 activation", async () => {
  const { resolveMcpEngramConfig } = await import("../extensions/mcp-engram.ts");
  const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-mcp-context7-conflict-"));
  const agentDir = join(sandbox, "agent");
  const configPath = join(agentDir, "mcp.json");
  const fakeBin = join(sandbox, process.platform === "win32" ? "engram.exe" : "engram");
  const previousConfig = {
    mcpServers: {
      context7: { url: "https://example.invalid/user-context7" },
      "user-server": { url: "https://example.invalid/foreign" },
      engram: { command: fakeBin, args: ["mcp", "--tools=agent"], lifecycle: "lazy", directTools: false },
    },
  };
  const previousBytes = `${JSON.stringify(previousConfig, null, 2)}\n`;
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(configPath, previousBytes);
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:gentle-engram@0.1.13", "npm:pi-mcp-adapter@2.36.0"] }));
  writeFileSync(fakeBin, "fake binary; never execute\n");
  chmodSync(fakeBin, 0o755);

  try {
    const result = await resolveMcpEngramConfig({
      resolveEngramBinary: () => fakeBin,
      env: { HOME: join(sandbox, "home"), PI_CODING_AGENT_DIR: agentDir },
    });
    assert.equal(result.state, "managed", "an unrelated managed Engram bridge must remain available");
    assert.equal(result.config.mcpServers.context7, undefined, "a homonymous Context7 definition must not be imported or overwritten");
    assert.equal(result.config.mcpServers["user-server"], undefined, "ambient MCP servers must stay outside the isolated managed config");
    assert.equal(result.context7?.state, "conflict", "the per-server conflict must be diagnosable");
    assert.equal(readFileSync(configPath, "utf8"), previousBytes, "conflict detection must not rewrite the user's MCP config");
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("official Context7 definitions register over the event bus with directTools:false and env-only key", async () => {
  const { resolveMcpEngramConfig } = await import("../extensions/mcp-engram.ts");
  const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-mcp-context7-official-"));
  const fakeBin = join(sandbox, process.platform === "win32" ? "engram.exe" : "engram");
  writeFileSync(fakeBin, "fake binary; never execute\n");
  chmodSync(fakeBin, 0o755);
  const agentDir = join(sandbox, "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:gentle-engram@0.1.13", "npm:pi-mcp-adapter@2.36.0"] }));
  writeFileSync(join(agentDir, "mcp.json"), `${JSON.stringify({ mcpServers: { engram: { command: fakeBin, args: ["mcp", "--tools=agent"], lifecycle: "lazy", directTools: false } } }, null, 2)}\n`);
  try {
    for (const scenario of [
      { name: "anonymous", key: undefined },
      { name: "optional key", key: "fixture-context7-token" },
    ]) {
      const env = scenario.key === undefined
        ? { HOME: join(sandbox, "home"), PI_CODING_AGENT_DIR: agentDir }
        : { HOME: join(sandbox, "home"), PI_CODING_AGENT_DIR: agentDir, CONTEXT7_API_KEY: scenario.key };
      const result = await resolveMcpEngramConfig({ resolveEngramBinary: () => fakeBin, env });
      assert.equal(result.state, "managed", `${scenario.name} must resolve managed`);
      assert.equal(result.config.mcpServers.context7?.directTools, false, `${scenario.name} runtime definition must request directTools:false`);
      assert.equal(result.config.mcpServers.context7?.lifecycle, "lazy", `${scenario.name} runtime definition stays lazy`);
      assert.equal(result.config.mcpServers.context7?.url, expected.context7.url, `${scenario.name} keeps the canonical endpoint`);
      if (scenario.key === undefined) {
        assert.equal("headers" in (result.config.mcpServers.context7 ?? {}), false, "absent key must omit the header");
      } else {
        assert.deepEqual(result.config.mcpServers.context7?.headers, { CONTEXT7_API_KEY: "${CONTEXT7_API_KEY}" }, "key stays an env reference");
        assert.equal(JSON.stringify(result.config).includes("fixture-context7-token"), false, "runtime key must never persist");
      }
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("managed Engram resolves the direct official binary config containing Engram and Context7", async () => {
  const { resolveMcpEngramConfig } = await import("../extensions/mcp-engram.ts");
  const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-mcp-merge-"));
  const fakeBin = join(sandbox, process.platform === "win32" ? "engram.exe" : "engram");
  mkdirSync(dirname(fakeBin), { recursive: true });
  writeFileSync(fakeBin, "fake binary; never execute\n");
  chmodSync(fakeBin, 0o755);
  const agentDir = join(sandbox, "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:gentle-engram@0.1.13", "npm:pi-mcp-adapter@2.36.0"] }));
  writeFileSync(join(agentDir, "mcp.json"), `${JSON.stringify({ mcpServers: { engram: { command: fakeBin, args: ["mcp", "--tools=agent"], lifecycle: "lazy", directTools: false } } }, null, 2)}\n`);
  try {
    const result = await resolveMcpEngramConfig({
      resolveEngramBinary: () => fakeBin,
      env: { HOME: "/safe/home", PI_CODING_AGENT_DIR: agentDir, NODE_OPTIONS: "--require hostile", ENGRAM_CLOUD_TOKEN: "must-not-pass" },
    });
    assert.equal(result.state, "managed");
    assert.deepEqual(result.config, {
      mcpServers: {
        context7: expectedContext7Config,
        engram: {
          command: fakeBin,
          args: ["mcp", "--tools=agent"],
          lifecycle: "lazy",
          directTools: false,
          toolPrefix: "none",
          excludeTools: expected.engramProfile.excludedTools,
        },
      },
    });
    assert.deepEqual(Object.keys(result.config), ["mcpServers"], "official config must not carry imports or ambient adapter settings");
    assert.deepEqual(Object.keys(result.config.mcpServers).sort(), ["context7", "engram"], "the official bridge must never discover or adopt ambient servers");
    assert.equal(isAbsolute(result.config.mcpServers.engram.command), true);
    assert.equal(JSON.stringify(result.config).includes("must-not-pass"), false, "hostile env values must never leak into the official config");
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("official bridge carries no child-only adapter settings in any context", async () => {
  const { resolveMcpEngramConfig } = await import("../extensions/mcp-engram.ts");
  const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-mcp-engram-child-"));
  const fakeBin = join(sandbox, process.platform === "win32" ? "engram.exe" : "engram");
  writeFileSync(fakeBin, "fake binary; never execute\n");
  chmodSync(fakeBin, 0o755);
  const defaultAgentDir = join(sandbox, "home", ".pi", "agent");
  mkdirSync(defaultAgentDir, { recursive: true });
  writeFileSync(join(defaultAgentDir, "mcp.json"), `${JSON.stringify({ mcpServers: { engram: { command: fakeBin, args: ["mcp", "--tools=agent"], lifecycle: "lazy", directTools: false } } }, null, 2)}\n`);
  writeFileSync(join(defaultAgentDir, "settings.json"), JSON.stringify({ packages: ["npm:gentle-engram@0.1.13", "npm:pi-mcp-adapter@2.36.0"] }));
  try {
    const parent = await resolveMcpEngramConfig({
      resolveEngramBinary: () => fakeBin,
      env: { HOME: join(sandbox, "home") },
    });
    assert.equal(parent.state, "managed");
    assert.equal("settings" in parent.config, false, "parent config must not carry child-only adapter settings");

    const child = await resolveMcpEngramConfig({
      resolveEngramBinary: () => fakeBin,
      env: { HOME: join(sandbox, "home"), PI_SUBAGENT_CHILD_AGENT: "engram" },
    });
    assert.equal(child.state, "managed");
    assert.equal("settings" in child.config, false, "official bridge has no adapter settings to hide in the child");
    assert.equal(child.config.mcpServers.engram.directTools, false, "child keeps official direct tools disabled");
    assert.equal(child.config.mcpServers.engram.toolPrefix, "none", "child keeps the official tool prefix");
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("managed Engram leaves the optional Pi Chrome DevTools server absent without a handoff", async () => {
  const { resolveMcpEngramConfig } = await import("../extensions/mcp-engram.ts");
  const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-mcp-devtools-absent-"));
  const agentDir = join(sandbox, "agent");
  const fakeBin = join(sandbox, process.platform === "win32" ? "engram.exe" : "engram");
  writeFileSync(fakeBin, "fake binary; never execute\n");
  chmodSync(fakeBin, 0o755);
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "mcp.json"), `${JSON.stringify({ mcpServers: { engram: { command: fakeBin, args: ["mcp", "--tools=agent"], lifecycle: "lazy", directTools: false } } }, null, 2)}\n`);
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:gentle-engram@0.1.13", "npm:pi-mcp-adapter@2.36.0"] }));
  try {
    const result = await resolveMcpEngramConfig({
      resolveEngramBinary: () => fakeBin,
      env: { PI_CODING_AGENT_DIR: agentDir },
    });
    assert.equal(result.state, "managed");
    assert.equal(result.config.mcpServers["chrome-devtools"], undefined);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("managed Engram adds the exact optional Pi Chrome DevTools handoff", async () => {
  const { resolveMcpEngramConfig } = await import("../extensions/mcp-engram.ts");
  const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-mcp-devtools-valid-"));
  const agentDir = join(sandbox, "agent");
  const handoffPath = join(agentDir, "jorgex-pi", "devtools.v1.json");
  const fakeBin = join(sandbox, process.platform === "win32" ? "engram.exe" : "engram");
  const pnpmPath = join(sandbox, process.platform === "win32" ? "pnpm.cmd" : "pnpm");
  const args = [
    "dlx",
    "chrome-devtools-mcp@1.6.0",
    "--isolated",
    "--redact-network-headers",
    "--no-performance-crux",
    "--no-usage-statistics",
  ];
  writeFileSync(fakeBin, "fake binary; never execute\n");
  writeFileSync(pnpmPath, "fake pnpm; never execute\n");
  chmodSync(fakeBin, 0o755);
  chmodSync(pnpmPath, 0o755);
  mkdirSync(dirname(handoffPath), { recursive: true });
  writeFileSync(handoffPath, `${JSON.stringify({ schemaVersion: 1, enabled: true, command: pnpmPath, args })}\n`);
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:gentle-engram@0.1.13", "npm:pi-mcp-adapter@2.36.0"] }));
  writeFileSync(join(agentDir, "mcp.json"), `${JSON.stringify({ mcpServers: { engram: { command: fakeBin, args: ["mcp", "--tools=agent"], lifecycle: "lazy", directTools: false } } }, null, 2)}\n`);
  try {
    const result = await resolveMcpEngramConfig({
      resolveEngramBinary: () => fakeBin,
      env: { PI_CODING_AGENT_DIR: agentDir },
    });
    assert.equal(result.state, "managed");
    assert.deepEqual(result.config.mcpServers["chrome-devtools"], {
      command: pnpmPath,
      args,
      lifecycle: "lazy",
      directTools: false,
    });
    assert.deepEqual(Object.keys(result.config.mcpServers).sort(), ["chrome-devtools", "context7", "engram"]);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("managed Engram accepts only a local Node launcher in the DevTools v2 handoff", async () => {
  const { resolveMcpEngramConfig } = await import("../extensions/mcp-engram.ts");
  const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-mcp-devtools-local-"));
  const agentDir = join(sandbox, "agent");
  const handoffPath = join(agentDir, "jorgex-pi", "devtools.v1.json");
  const engramBin = join(sandbox, process.platform === "win32" ? "engram.exe" : "engram");
  const nodeBin = process.execPath;
  const launcher = join(sandbox, "managed-devtools.mjs");
  const args = [launcher, "--isolated", "--redact-network-headers", "--no-performance-crux", "--no-usage-statistics"];
  writeFileSync(engramBin, "fake binary; never execute\n");
  chmodSync(engramBin, 0o755);
  writeFileSync(launcher, "// local fixture; never execute\n");
  mkdirSync(dirname(handoffPath), { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:gentle-engram@0.1.13", "npm:pi-mcp-adapter@2.36.0"] }));
  writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: {
    engram: { command: engramBin, args: ["mcp", "--tools=agent"], lifecycle: "lazy", directTools: false },
  } }));
  const input = { schemaVersion: 2, enabled: true, command: nodeBin, args };
  const resolve = () => resolveMcpEngramConfig({ resolveEngramBinary: () => engramBin, env: { PI_CODING_AGENT_DIR: agentDir } });
  try {
    writeFileSync(handoffPath, `${JSON.stringify(input)}\n`);
    const accepted = await resolve();
    assert.equal(accepted.state, "managed");
    assert.deepEqual(accepted.config.mcpServers["chrome-devtools"], {
      command: nodeBin, args, lifecycle: "lazy", directTools: false,
    });
    const contract = readJson(join(root, "contract", "jorgex-pi.v1.json"));
    assert.ok(contract.capabilities.includes("chrome-devtools-local-handoff-v1"));
    assert.ok(contract.capabilities.includes("chrome-devtools-handoff-v1"));

    for (const [label, candidate] of [
      ["registry invocation", { ...input, args: ["dlx", "chrome-devtools-mcp@1.10.1", ...args.slice(1)] }],
      ["missing local script", { ...input, args: [join(sandbox, "absent.mjs"), ...args.slice(1)] }],
      ["relative local script", { ...input, args: ["managed-devtools.mjs", ...args.slice(1)] }],
      ["missing privacy flag", { ...input, args: args.slice(0, -1) }],
      ["extra privacy flag", { ...input, args: [...args, "--unsafe"] }],
      ["extra field", { ...input, integrity: "untrusted" }],
      ["unknown schema", { ...input, schemaVersion: 3 }],
    ]) {
      writeFileSync(handoffPath, `${JSON.stringify(candidate)}\n`);
      const rejected = await resolve();
      assert.equal(rejected.state, "failed", `${label} must fail closed`);
      assert.equal(rejected.config.mcpServers["chrome-devtools"], undefined);
      assert.match(rejected.reason ?? "", /devtools|handoff|invalid|absolute|schema/i);
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("Stack-observed chrome-devtools-mcp 1.10.1 handoff resolves managed with exact safe flags", async () => {
  const { resolveMcpEngramConfig } = await import("../extensions/mcp-engram.ts");
  const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-mcp-devtools-observed-"));
  const agentDir = join(sandbox, "agent");
  const handoffPath = join(agentDir, "jorgex-pi", "devtools.v1.json");
  const fakeBin = join(sandbox, process.platform === "win32" ? "engram.exe" : "engram");
  const pnpmPath = join(sandbox, process.platform === "win32" ? "pnpm.cmd" : "pnpm");
  const OBSERVED_ARGS = [
    "dlx",
    "chrome-devtools-mcp@1.10.1",
    "--isolated",
    "--redact-network-headers",
    "--no-performance-crux",
    "--no-usage-statistics",
  ];
  writeFileSync(fakeBin, "fake binary; never execute\n");
  writeFileSync(pnpmPath, "fake pnpm; never execute\n");
  chmodSync(fakeBin, 0o755);
  chmodSync(pnpmPath, 0o755);
  mkdirSync(dirname(handoffPath), { recursive: true });
  writeFileSync(join(agentDir, "mcp.json"), `${JSON.stringify({ mcpServers: { engram: { command: fakeBin, args: ["mcp", "--tools=agent"], lifecycle: "lazy", directTools: false } } }, null, 2)}\n`);
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:gentle-engram@0.1.13", "npm:pi-mcp-adapter@2.36.0"] }));
  try {
    for (const [label, args, command] of [
      ["latest stays rejected", ["dlx", "chrome-devtools-mcp@latest", "--isolated", "--redact-network-headers", "--no-performance-crux", "--no-usage-statistics"], undefined],
      ["range stays rejected", ["dlx", "chrome-devtools-mcp@^1.10.1", "--isolated", "--redact-network-headers", "--no-performance-crux", "--no-usage-statistics"], undefined],
      ["missing version stays rejected", ["dlx", "chrome-devtools-mcp", "--isolated", "--redact-network-headers", "--no-performance-crux", "--no-usage-statistics"], undefined],
      ["leading-zero version stays rejected", ["dlx", "chrome-devtools-mcp@01.10.1", "--isolated", "--redact-network-headers", "--no-performance-crux", "--no-usage-statistics"], undefined],
      ["whitespace version stays rejected", ["dlx", "chrome-devtools-mcp@1.10.1 ", "--isolated", "--redact-network-headers", "--no-performance-crux", "--no-usage-statistics"], undefined],
      ["shell metacharacters stay rejected", ["dlx", "chrome-devtools-mcp@1.10.1;whoami", "--isolated", "--redact-network-headers", "--no-performance-crux", "--no-usage-statistics"], undefined],
      ["unexpected source stays rejected", ["dlx", "evil-devtools-mcp@1.10.1", "--isolated", "--redact-network-headers", "--no-performance-crux", "--no-usage-statistics"], undefined],
      ["extra args stay rejected", [...OBSERVED_ARGS, "--unexpected"], undefined],
      ["relative command stays rejected", OBSERVED_ARGS, "pnpm"],
      ["missing executable stays rejected", OBSERVED_ARGS, join(sandbox, "missing-pnpm")],
    ]) {
      writeFileSync(handoffPath, `${JSON.stringify({ schemaVersion: 1, enabled: true, command: command ?? pnpmPath, args })}\n`);
      const rejected = await resolveMcpEngramConfig({
        resolveEngramBinary: () => fakeBin,
        env: { PI_CODING_AGENT_DIR: agentDir },
      });
      assert.equal(rejected.state, "failed", `${label} must fail closed`);
      assert.equal(rejected.config.mcpServers["chrome-devtools"], undefined, label);
    }
    writeFileSync(handoffPath, `${JSON.stringify({ schemaVersion: 1, enabled: true, command: pnpmPath, args: OBSERVED_ARGS })}\n`);
    const observed = await resolveMcpEngramConfig({
      resolveEngramBinary: () => fakeBin,
      env: { PI_CODING_AGENT_DIR: agentDir },
    });
    assert.equal(observed.state, "managed", "observed 1.10.1 exact handoff must resolve managed");
    assert.deepEqual(observed.config.mcpServers["chrome-devtools"], {
      command: pnpmPath,
      args: OBSERVED_ARGS,
      lifecycle: "lazy",
      directTools: false,
    });
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("an invalid Pi Chrome DevTools handoff fails closed with a diagnostic", async () => {
  const { resolveMcpEngramConfig } = await import("../extensions/mcp-engram.ts");
  const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-mcp-devtools-invalid-"));
  const agentDir = join(sandbox, "agent");
  const handoffPath = join(agentDir, "jorgex-pi", "devtools.v1.json");
  const fakeBin = join(sandbox, process.platform === "win32" ? "engram.exe" : "engram");
  const pnpmPath = join(sandbox, process.platform === "win32" ? "pnpm.cmd" : "pnpm");
  const args = [
    "dlx",
    "chrome-devtools-mcp@1.6.0",
    "--isolated",
    "--redact-network-headers",
    "--no-performance-crux",
    "--no-usage-statistics",
  ];
  writeFileSync(fakeBin, "fake binary; never execute\n");
  writeFileSync(pnpmPath, "fake pnpm; never execute\n");
  chmodSync(fakeBin, 0o755);
  chmodSync(pnpmPath, 0o755);
  mkdirSync(dirname(handoffPath), { recursive: true });
  writeFileSync(join(agentDir, "mcp.json"), `${JSON.stringify({ mcpServers: { engram: { command: fakeBin, args: ["mcp", "--tools=agent"], lifecycle: "lazy", directTools: false } } }, null, 2)}\n`);
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:gentle-engram@0.1.13", "npm:pi-mcp-adapter@2.36.0"] }));
  try {
    for (const [label, contents] of [
      ["unreadable JSON", "{not-json\n"],
      ["different flags", JSON.stringify({ schemaVersion: 1, enabled: true, command: pnpmPath, args: [...args, "--unexpected"] })],
      ["relative command", JSON.stringify({ schemaVersion: 1, enabled: true, command: "pnpm", args })],
    ]) {
      writeFileSync(handoffPath, contents);
      const result = await resolveMcpEngramConfig({
        resolveEngramBinary: () => fakeBin,
        env: { PI_CODING_AGENT_DIR: agentDir },
      });
      assert.equal(result.state, "failed", `${label} must fail closed`);
      assert.equal(result.config.mcpServers["chrome-devtools"], undefined);
      assert.match(result.reason ?? "", /devtools|handoff|chrome|invalid|absolute|JSON/i, `${label} needs a diagnostic`);
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("missing or failed Engram resolution preserves the isolated Context7 registration and its diagnosis", async () => {
  const { resolveMcpEngramConfig } = await import("../extensions/mcp-engram.ts");
  const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-mcp-missing-engram-"));
  const agentDir = join(sandbox, "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:gentle-engram@0.1.13", "npm:pi-mcp-adapter@2.36.0"] }));
  const env = { HOME: join(sandbox, "home"), PI_CODING_AGENT_DIR: agentDir };
  try {
    const missing = await resolveMcpEngramConfig({ resolveEngramBinary: () => undefined, env });
    assert.equal(missing.state, "missing");
    assert.equal(missing.context7?.state, "available");
    assert.deepEqual(missing.config, { mcpServers: { context7: expectedContext7Config } });

    const failed = await resolveMcpEngramConfig({ resolveEngramBinary: () => { throw new Error("resolver failed"); }, env });
    assert.equal(failed.state, "failed");
    assert.equal(failed.context7?.state, "available");
    assert.deepEqual(failed.config, { mcpServers: { context7: expectedContext7Config } });
    assert.match(failed.reason ?? "", /resolver failed/);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("managed Engram resolves only an absolute native ENGRAM_BIN and never searches PATH", async () => {
  const { resolveConfiguredEngramBinary } = await import("../extensions/mcp-engram.ts");
  assert.equal(typeof resolveConfiguredEngramBinary, "function", "binary policy must expose a deterministic platform seam");
  const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-engram-resolution-"));
  const windows = prepareWindowsFixture(sandbox);
  const nativeBin = win32.join(windows.home, "engram.exe");
  const rejectedBins = ["engram.cmd", "engram.bat", "engram.ps1", "engram.txt", "engram"]
    .map((name) => win32.join(windows.home, name));
  writeFileSync(nativeBin, "native fixture\n");
  chmodSync(nativeBin, 0o755);
  for (const path of rejectedBins) {
    writeFileSync(path, "non-native fixture\n");
    chmodSync(path, 0o755);
  }
  try {
    assert.equal(resolveConfiguredEngramBinary({ env: { PATH: sandbox }, platform: "linux" }), undefined, "PATH fallback is outside the managed bridge contract");
    assert.throws(() => resolveConfiguredEngramBinary({ env: { ENGRAM_BIN: "engram" }, platform: "linux" }), /absolute/i);
    assert.equal(resolveConfiguredEngramBinary({ env: { ENGRAM_BIN: nativeBin }, platform: "win32" }), nativeBin);
    for (const path of rejectedBins) {
      assert.throws(
        () => resolveConfiguredEngramBinary({ env: { ENGRAM_BIN: path }, platform: "win32" }),
        /native|\.exe|cmd|bat|ps1/i,
        `Windows must reject non-native executable path ${path}`,
      );
    }
  } finally {
    windows.restore();
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("managed Engram falls back only to the exact installed Stack receipt", async () => {
  const { resolveConfiguredEngramBinary } = await import("../extensions/mcp-engram.ts");
  const manifest = readJson(join(root, "package.json"));
  const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-engram-receipt-"));
  const windows = prepareWindowsFixture(sandbox);
  const home = windows.home;
  const agentDir = win32.join(home, "agent");
  const receiptPath = win32.join(home, ".jorgex-stack", "pi-receipt.json");
  const nativeBin = win32.join(home, "engram.exe");
  const explicitBin = win32.join(home, "explicit-engram.exe");
  const nonNativeBin = win32.join(home, "engram.cmd");
  const exactSource = `npm:jorgex-pi@${manifest.version}`;
  const env = { USERPROFILE: home, PATH: sandbox, PI_CODING_AGENT_DIR: agentDir };
  writeFileSync(nativeBin, "native fixture\n");
  writeFileSync(explicitBin, "explicit fixture\n");
  writeFileSync(nonNativeBin, "non-native fixture\n");
  chmodSync(nativeBin, 0o755);
  chmodSync(explicitBin, 0o755);
  chmodSync(nonNativeBin, 0o755);
  try {
    const exactReceipt = createReceipt({ source: exactSource, version: manifest.version, codingAgentDir: agentDir, binary: nativeBin });
    writeReceipt(receiptPath, exactReceipt);
    assert.equal(
      resolveConfiguredEngramBinary({ env: { ...env, ENGRAM_BIN: explicitBin }, platform: "win32" }),
      explicitBin,
      "a valid absolute ENGRAM_BIN must take precedence over the managed receipt",
    );

    assert.throws(
      () => resolveConfiguredEngramBinary({ env: { ...env, ENGRAM_BIN: win32.join(home, "missing-engram.exe") }, platform: "win32" }),
      /executable|permission|ENGRAM_BIN/i,
      "an invalid explicit ENGRAM_BIN must throw and never fall through to the managed receipt",
    );

    for (const { label, mutation } of [
      { label: "state", mutation: (receipt) => ({ ...receipt, state: "installing" }) },
      { label: "source", mutation: (receipt) => ({ ...receipt, candidate: { ...receipt.candidate, package: { ...receipt.candidate.package, source: "npm:jorgex-pi@0.0.0" } } }) },
      { label: "version", mutation: (receipt) => ({ ...receipt, candidate: { ...receipt.candidate, package: { ...receipt.candidate.package, version: "0.0.0" } } }) },
      { label: "scope kind", mutation: (receipt) => ({ ...receipt, scope: { ...receipt.scope, kind: "sandbox" } }) },
      { label: "scope directory", mutation: (receipt) => ({ ...receipt, scope: { ...receipt.scope, codingAgentDir: win32.join(home, "other-agent") } }) },
      { label: "Windows binary", mutation: (receipt) => ({ ...receipt, engram: { ...receipt.engram, binary: nonNativeBin } }) },
    ]) {
      writeReceipt(receiptPath, mutation(exactReceipt));
      assert.equal(
        resolveConfiguredEngramBinary({ env, platform: "win32" }),
        undefined,
        `${label} must not enable the bridge`,
      );
    }

    writeFileSync(receiptPath, "{not-json\n");
    assert.equal(resolveConfiguredEngramBinary({ env, platform: "win32" }), undefined, "a corrupt receipt must fail closed");
    rmSync(receiptPath, { force: true });
    assert.equal(resolveConfiguredEngramBinary({ env, platform: "win32" }), undefined, "PATH must remain outside the managed bridge contract");
    writeReceipt(receiptPath, exactReceipt);
    assert.equal(
      resolveConfiguredEngramBinary({ env, platform: "win32" }),
      nativeBin,
      "an installed Stack receipt must provide the native executable when ENGRAM_BIN is absent",
    );
  } finally {
    windows.restore();
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("managed Engram accepts an exact Windows Stack receipt at Pi's default agent directory", async () => {
  const { resolveConfiguredEngramBinary } = await import("../extensions/mcp-engram.ts");
  const manifest = readJson(join(root, "package.json"));
  const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-engram-windows-receipt-"));
  const windows = prepareWindowsFixture(sandbox);
  const home = windows.home;
  const agentDir = win32.join(home, ".pi", "agent");
  const receiptPath = win32.join(home, ".jorgex-stack", "pi-receipt.json");
  const nativeBin = win32.join(home, "engram.exe");
  try {
    if (process.platform === "win32") mkdirSync(dirname(receiptPath), { recursive: true });
    writeFileSync(nativeBin, "native fixture\n");
    chmodSync(nativeBin, 0o755);
    writeFileSync(
      receiptPath,
      `${JSON.stringify(createReceipt({
        source: `npm:jorgex-pi@${manifest.version}`,
        version: manifest.version,
        codingAgentDir: agentDir,
        binary: nativeBin,
      }))}\n`,
    );
    assert.equal(
      resolveConfiguredEngramBinary({ env: { USERPROFILE: home }, platform: "win32" }),
      nativeBin,
      "a native Windows receipt must use USERPROFILE and Pi's default .pi/agent directory",
    );
  } finally {
    windows.restore();
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("the official gentle profile exposes exactly the six reviewed read-only Engram tools", async () => {
  const { resolveMcpEngramConfig } = await import("../extensions/mcp-engram.ts");
  const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-mcp-gentle-profile-"));
  const agentDir = join(sandbox, "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "mcp.json"), `${JSON.stringify({ mcpServers: { engram: { command: resolve(process.execPath), args: ["mcp", "--tools=agent"], lifecycle: "lazy", directTools: false } } }, null, 2)}\n`);
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:gentle-engram@0.1.13", "npm:pi-mcp-adapter@2.36.0"] }));
  let managed;
  try {
    managed = await resolveMcpEngramConfig({
      resolveEngramBinary: () => resolve(process.execPath),
      env: { HOME: join(sandbox, "home"), PI_CODING_AGENT_DIR: agentDir },
    });
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
  const server = managed.config.mcpServers.engram;
  assert.deepEqual(server.args, [...expected.server.args], "official server keeps the exact provider args");
  assert.equal(server.lifecycle, expected.server.lifecycle, "official server stays lazy");
  assert.equal(server.directTools, false, "official server disables direct tools for the event bus");
  assert.equal(server.toolPrefix, expected.server.toolPrefix, "official server keeps the neutral tool prefix");
  assert.deepEqual(expected.engramProfile.tools.slice().sort(), [
    "mem_context",
    "mem_current_project",
    "mem_doctor",
    "mem_get_observation",
    "mem_search",
    "mem_suggest_topic_key",
  ], "gentle profile stays exactly the six official reads");
  assert.equal(expected.engramProfile.tools.length, 6, "gentle profile never restores the 17-tool bundled set");
  assert.deepEqual(expected.engramProfile.excludedTools, ["mem_capture_passive"], "passive capture stays excluded");
  assert.equal(expected.engramProfile.tools.includes("mem_capture_passive"), false, "passive capture never joins the gentle reads");
  for (const blocked of ["mem_save", "mem_session_summary", "mem_update", "bash", "subagent"]) {
    assert.equal(expected.engramProfile.tools.includes(blocked), false, `gentle reads must not include ${blocked}`);
  }
  const shimPath = join(root, "extensions", "engram-child.ts");
  assert.equal(existsSync(shimPath), false, "no package-local Engram child shim may remain; gentle-engram loads ambiently");
  const agentSource = readFileSync(join(root, "agents", "engram.md"), "utf8");
  assert.doesNotMatch(agentSource, /engram-child/, "agent must not reference the shim");
});

test("executable ENGRAM_BIN without official mcp.json server must not resolve managed", async () => {
  const { resolveMcpEngramConfig } = await import("../extensions/mcp-engram.ts");
  const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-mcp-bin-without-official-"));
  const agentDir = join(sandbox, "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:gentle-engram@0.1.13", "npm:pi-mcp-adapter@2.36.0"] }));
  const fakeBin = join(sandbox, "engram");
  writeFileSync(fakeBin, "fake binary; never execute\n");
  chmodSync(fakeBin, 0o755);
  const env = { HOME: join(sandbox, "home"), PI_CODING_AGENT_DIR: agentDir, ENGRAM_BIN: fakeBin };
  try {
    // No mcp.json: `engram setup pi` never created the official Engram server.
    const missingFile = await resolveMcpEngramConfig({ env, platform: "linux", cwd: sandbox });
    assert.ok(["missing", "failed"].includes(missingFile.state), `executable binary without mcp.json must not resolve managed (got ${missingFile.state})`);
    assert.equal(missingFile.config.mcpServers.engram, undefined, "no managed Engram server without official mcp.json");

    // mcp.json without the official engram server is the same incomplete setup.
    writeFileSync(join(agentDir, "mcp.json"), `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`);
    const missingServer = await resolveMcpEngramConfig({ env, platform: "linux", cwd: sandbox });
    assert.ok(["missing", "failed"].includes(missingServer.state), `executable binary without official engram server must not resolve managed (got ${missingServer.state})`);
    assert.equal(missingServer.config.mcpServers.engram, undefined, "an executable binary never substitutes the official mcp.json server");
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function createReceipt({ source, version, codingAgentDir, binary }) {
  return {
    schemaVersion: 1,
    state: "installed",
    candidate: {
      package: { name: "jorgex-pi", source, version },
      tarball: { bytes: 1, sha256: "a", sha512: "b" },
      provenance: { commit: "reviewed" },
    },
    scope: { kind: "real", codingAgentDir },
    engram: { binary },
  };
}

function writeReceipt(path, receipt) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(receipt)}\n`);
}

function prepareWindowsFixture(sandbox) {
  const previousCwd = process.cwd();
  const home = process.platform === "win32" ? join(sandbox, "home") : "C:\\Users\\JorgeXPiTest";
  if (process.platform === "win32") mkdirSync(home, { recursive: true });
  else process.chdir(sandbox);
  return { home, restore: () => process.chdir(previousCwd) };
}

function createMcpAdapterHarness() {
  const eventHandlers = new Map();
  const lifecycleHandlers = new Map();
  const tools = new Map();
  const add = (map, name, handler) => map.set(name, [...(map.get(name) ?? []), handler]);
  let activeTools = [];
  const events = {
    on(name, handler) { add(eventHandlers, name, handler); },
    emit() {},
  };
  const api = {
    events,
    on(name, handler) { add(lifecycleHandlers, name, handler); },
    registerFlag() {},
    getFlag() { return undefined; },
    registerTool(tool) {
      tools.set(tool.name, tool);
      activeTools = [...new Set([...activeTools, tool.name])];
    },
    registerCommand() {},
    getActiveTools: () => [...activeTools],
    getAllTools: () => [...tools.values()],
    setActiveTools(names) { activeTools = [...names]; },
    sendMessage() {},
  };
  return {
    api,
    async emitLifecycle(name, event, context) {
      for (const handler of lifecycleHandlers.get(name) ?? []) await handler(event, context);
    },
    async executeTool(name, params, context) {
      const tool = tools.get(name);
      assert.ok(tool?.execute, `${name} must be registered as an executable Pi tool`);
      return tool.execute(`fixture-${name}`, params, undefined, undefined, context);
    },
  };
}

function captureEnvironment(keys) {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function restoreEnvironment(environment) {
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
