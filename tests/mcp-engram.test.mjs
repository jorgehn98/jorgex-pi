import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, win32 } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { startFakeContext7Mcp } from "./fixtures/fake-context7-mcp.mjs";

const testDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(testDir, "..");
const expected = readJson(join(testDir, "fixtures", "mcp-engram.expected.json"));
const jiti = createJiti(import.meta.url, { moduleCache: false });
const expectedContext7Config = {
  url: expected.context7.url,
  auth: expected.context7.auth,
  lifecycle: expected.context7.lifecycle,
  directTools: expected.context7.directTools,
};

test("the exact MCP adapter exposes its package-local programmatic factory", async () => {
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
  assert.equal(existsSync(fileURLToPath(adapterEntry)), true, "the pinned adapter entrypoint must remain package-local");
  const adapter = await jiti.import(adapterEntry);
  assert.equal(typeof adapter.createMcpAdapter, "function", "JorgeX must use the adapter's public programmatic config factory");
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
    assert.equal(missing.state, "available");

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
    const settingsBytes = `${JSON.stringify({ packages: ["npm:pi-mcp-adapter@2.27.0"], foreign: true }, null, 2)}\n`;
    writeFileSync(settingsPath, settingsBytes);
    const externalAdapter = inspectContext7Config({ env, cwd: sandbox, platform: process.platform });
    assert.equal(externalAdapter.state, "conflict");
    assert.equal(externalAdapter.source, "pi-global-settings");
    assert.equal(externalAdapter.code, "external-mcp-adapter");
    assert.equal(readFileSync(settingsPath, "utf8"), settingsBytes, "external adapter detection must be read-only");
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
    },
  };
  const previousBytes = `${JSON.stringify(previousConfig, null, 2)}\n`;
  mkdirSync(resolvedAgentDir, { recursive: true });
  writeFileSync(configPath, previousBytes);
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
      nodePath: resolve(process.execPath),
      wrapperPath: join(root, "extensions", "engram-mcp-wrapper.mjs"),
      env,
      platform: process.platform,
      cwd: sandbox,
    });
    assert.equal(bridge.state, "managed");
    assert.equal(bridge.context7?.state, "conflict");
    assert.equal(bridge.config.mcpServers.context7, undefined);
    assert.equal(bridge.config.mcpServers.engram.args.at(-1), fakeBin);
    assert.equal(existsSync(join(sandbox, "~")), false, "tilde expansion must not write a literal relative directory");
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("managed Engram registers anonymous Context7 over HTTP and keeps an optional key as an env reference", async () => {
  const { resolveMcpEngramConfig } = await import("../extensions/mcp-engram.ts");
  const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-mcp-context7-config-"));
  const fakeBin = join(sandbox, process.platform === "win32" ? "engram.exe" : "engram");
  const nodePath = resolve(process.execPath);
  const wrapperPath = join(root, "extensions", "engram-mcp-wrapper.mjs");
  writeFileSync(fakeBin, "fake binary; never execute\n");
  chmodSync(fakeBin, 0o755);
  try {
    const anonymous = await resolveMcpEngramConfig({
      resolveEngramBinary: () => fakeBin,
      nodePath,
      wrapperPath,
      env: { HOME: join(sandbox, "home") },
    });
    assert.equal(anonymous.state, "managed");
    assert.equal(anonymous.context7?.state, "available", "Context7 must be available for managed registration when no prior definition exists");
    assert.deepEqual(anonymous.config.mcpServers.context7, expectedContext7Config);
    assert.equal("headers" in anonymous.config.mcpServers.context7, false, "an absent key must omit the HTTP header");
    assert.doesNotMatch(JSON.stringify(anonymous.config), /CONTEXT7_API_KEY|fixture-context7-token/);

    const emptyKey = await resolveMcpEngramConfig({
      resolveEngramBinary: () => fakeBin,
      nodePath,
      wrapperPath,
      env: { HOME: join(sandbox, "home"), CONTEXT7_API_KEY: "  " },
    });
    assert.equal(emptyKey.context7?.state, "available");
    assert.equal("headers" in emptyKey.config.mcpServers.context7, false, "an empty key must not create an empty HTTP header");

    const keyed = await resolveMcpEngramConfig({
      resolveEngramBinary: () => fakeBin,
      nodePath,
      wrapperPath,
      env: { HOME: join(sandbox, "home"), CONTEXT7_API_KEY: "fixture-context7-token" },
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
  const nodePath = resolve(process.execPath);
  const wrapperPath = join(root, "extensions", "engram-mcp-wrapper.mjs");
  const previousConfig = {
    mcpServers: {
      context7: { url: "https://example.invalid/user-context7" },
      "user-server": { url: "https://example.invalid/foreign" },
    },
  };
  const previousBytes = `${JSON.stringify(previousConfig, null, 2)}\n`;
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(configPath, previousBytes);
  writeFileSync(fakeBin, "fake binary; never execute\n");
  chmodSync(fakeBin, 0o755);

  try {
    const result = await resolveMcpEngramConfig({
      resolveEngramBinary: () => fakeBin,
      nodePath,
      wrapperPath,
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

test("the pinned adapter executes a local anonymous and optional-header Context7 call through its proxy tool", async () => {
  const adapterEntry = import.meta.resolve(expected.adapter.name);
  const { createMcpAdapter } = await jiti.import(adapterEntry);
  const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-mcp-context7-http-"));
  const previousEnvironment = captureEnvironment(["HOME", "USERPROFILE", "PI_CODING_AGENT_DIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "CONTEXT7_API_KEY"]);
  const fixture = await startFakeContext7Mcp();
  try {
    for (const scenario of [
      { name: "anonymous", key: undefined, expectedHeader: undefined },
      { name: "optional key", key: "fixture-context7-token", expectedHeader: "fixture-context7-token" },
    ]) {
      const agentDir = join(sandbox, scenario.name.replaceAll(" ", "-"), "agent");
      for (const path of [agentDir, join(sandbox, "home"), join(sandbox, "xdg-config"), join(sandbox, "xdg-cache"), join(sandbox, "xdg-data")]) {
        mkdirSync(path, { recursive: true });
      }
      process.env.HOME = join(sandbox, "home");
      process.env.USERPROFILE = process.env.HOME;
      process.env.PI_CODING_AGENT_DIR = agentDir;
      process.env.XDG_CONFIG_HOME = join(sandbox, "xdg-config");
      process.env.XDG_CACHE_HOME = join(sandbox, "xdg-cache");
      process.env.XDG_DATA_HOME = join(sandbox, "xdg-data");
      if (scenario.key === undefined) delete process.env.CONTEXT7_API_KEY;
      else process.env.CONTEXT7_API_KEY = scenario.key;

      const pi = createMcpAdapterHarness();
      createMcpAdapter({
        config: {
          mcpServers: {
            context7: {
              url: fixture.url,
              auth: false,
              lifecycle: "lazy",
              directTools: false,
              ...(scenario.key === undefined ? {} : { headers: { CONTEXT7_API_KEY: "${CONTEXT7_API_KEY}" } }),
            },
          },
        },
      })(pi.api);
      const context = { cwd: root, hasUI: false, mode: "print", signal: undefined };
      await pi.emitLifecycle("session_start", {}, context);
      const result = await pi.executeTool("mcp", {
        tool: "context7_fixture_context7",
        server: "context7",
        args: { value: scenario.name },
      }, context);
      assert.match(result.content?.[0]?.text ?? "", new RegExp(`fixture:${scenario.name}`));

      const requests = fixture.requests.splice(0);
      const call = requests.find(({ messages }) => messages.some(({ method }) => method === "tools/call"));
      assert.ok(call, `${scenario.name} must reach the local MCP HTTP fixture`);
      for (const request of requests) {
        assert.equal(request.headers["context7_api_key"], scenario.expectedHeader, `${scenario.name} must use the optional header consistently`);
      }
      await pi.emitLifecycle("session_shutdown", {}, context);
    }
  } finally {
    restoreEnvironment(previousEnvironment);
    await fixture.close();
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("managed Engram gives the adapter an isolated programmatic config containing Engram and Context7", async () => {
  const { resolveMcpEngramConfig } = await import("../extensions/mcp-engram.ts");
  const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-mcp-merge-"));
  const fakeBin = join(sandbox, process.platform === "win32" ? "engram.exe" : "engram");
  const nodePath = resolve(process.execPath);
  const wrapperPath = join(root, "extensions", "engram-mcp-wrapper.mjs");
  mkdirSync(dirname(fakeBin), { recursive: true });
  writeFileSync(fakeBin, "fake binary; never execute\n");
  chmodSync(fakeBin, 0o755);
  try {
    const result = await resolveMcpEngramConfig({
      resolveEngramBinary: () => fakeBin,
      nodePath,
      wrapperPath,
      env: { HOME: "/safe/home", NODE_OPTIONS: "--require hostile", ENGRAM_CLOUD_TOKEN: "must-not-pass" },
    });
    assert.equal(result.state, "managed");
    assert.deepEqual(result.config, {
      mcpServers: {
        context7: expectedContext7Config,
        engram: {
          command: nodePath,
          args: [wrapperPath, fakeBin],
          lifecycle: expected.server.lifecycle,
          directTools: expected.server.directTools,
          toolPrefix: expected.server.toolPrefix,
          excludeTools: expected.engramProfile.excludedTools,
        },
      },
    });
    assert.deepEqual(Object.keys(result.config), ["mcpServers"], "programmatic config must not carry imports or ambient adapter settings");
    assert.deepEqual(Object.keys(result.config.mcpServers).sort(), ["context7", "engram"], "the managed adapter must never discover or adopt ambient servers");
    assert.equal(isAbsolute(result.config.mcpServers.engram.command), true);
    assert.equal(isAbsolute(result.config.mcpServers.engram.args[0]), true);
    assert.equal(isAbsolute(result.config.mcpServers.engram.args[1]), true);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("managed Engram leaves the optional Pi Chrome DevTools server absent without a handoff", async () => {
  const { resolveMcpEngramConfig } = await import("../extensions/mcp-engram.ts");
  const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-mcp-devtools-absent-"));
  const agentDir = join(sandbox, "agent");
  const fakeBin = join(sandbox, process.platform === "win32" ? "engram.exe" : "engram");
  const nodePath = resolve(process.execPath);
  const wrapperPath = join(root, "extensions", "engram-mcp-wrapper.mjs");
  writeFileSync(fakeBin, "fake binary; never execute\n");
  chmodSync(fakeBin, 0o755);
  try {
    const result = await resolveMcpEngramConfig({
      resolveEngramBinary: () => fakeBin,
      nodePath,
      wrapperPath,
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
  const nodePath = resolve(process.execPath);
  const wrapperPath = join(root, "extensions", "engram-mcp-wrapper.mjs");
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
  try {
    const result = await resolveMcpEngramConfig({
      resolveEngramBinary: () => fakeBin,
      nodePath,
      wrapperPath,
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

test("an invalid Pi Chrome DevTools handoff fails closed with a diagnostic", async () => {
  const { resolveMcpEngramConfig } = await import("../extensions/mcp-engram.ts");
  const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-mcp-devtools-invalid-"));
  const agentDir = join(sandbox, "agent");
  const handoffPath = join(agentDir, "jorgex-pi", "devtools.v1.json");
  const fakeBin = join(sandbox, process.platform === "win32" ? "engram.exe" : "engram");
  const pnpmPath = join(sandbox, process.platform === "win32" ? "pnpm.cmd" : "pnpm");
  const nodePath = resolve(process.execPath);
  const wrapperPath = join(root, "extensions", "engram-mcp-wrapper.mjs");
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
  try {
    for (const [label, contents] of [
      ["unreadable JSON", "{not-json\n"],
      ["different flags", JSON.stringify({ schemaVersion: 1, enabled: true, command: pnpmPath, args: [...args, "--unexpected"] })],
      ["relative command", JSON.stringify({ schemaVersion: 1, enabled: true, command: "pnpm", args })],
    ]) {
      writeFileSync(handoffPath, contents);
      const result = await resolveMcpEngramConfig({
        resolveEngramBinary: () => fakeBin,
        nodePath,
        wrapperPath,
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
  const env = { HOME: join(sandbox, "home"), PI_CODING_AGENT_DIR: join(sandbox, "agent") };
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

    assert.equal(
      resolveConfiguredEngramBinary({ env: { ...env, ENGRAM_BIN: win32.join(home, "missing-engram.exe") }, platform: "win32" }),
      undefined,
      "an invalid explicit ENGRAM_BIN must not fall through to the managed receipt",
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

test("the pinned adapter metadata seam yields exactly the 17 reviewed direct Engram tools", async () => {
  const { resolveMcpEngramConfig } = await import("../extensions/mcp-engram.ts");
  const adapterEntry = import.meta.resolve(expected.adapter.name);
  const [{ resolveDirectTools }, { computeServerHash }] = await Promise.all([
    jiti.import(new URL("./direct-tools.ts", adapterEntry).href),
    jiti.import(new URL("./metadata-cache.ts", adapterEntry).href),
  ]);
  const managed = await resolveMcpEngramConfig({
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

  await lifecycle.get("session_compact")[0]({ summary: "must be discarded" }, { sessionId: "shutdown" });
  assert.equal((lifecycle.get("session_shutdown") ?? []).length, 1, "pending compaction state needs an explicit shutdown cleanup handler");
  await lifecycle.get("session_shutdown")[0]({}, { sessionId: "shutdown" });
  const afterShutdown = await lifecycle.get("before_agent_start")[0]({ systemPrompt: "Base" }, { sessionId: "shutdown" });
  assert.doesNotMatch(afterShutdown.systemPrompt, /FIRST ACTION REQUIRED/i, "a closed session must not leak recovery state into a reused id");
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
