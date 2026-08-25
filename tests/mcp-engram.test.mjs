import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, win32 } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const testDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(testDir, "..");
const expected = readJson(join(testDir, "fixtures", "mcp-engram.expected.json"));
const jiti = createJiti(import.meta.url, { moduleCache: false });

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

test("managed Engram gives the adapter an isolated programmatic config containing only Engram", async () => {
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
    assert.deepEqual(Object.keys(result.config.mcpServers), ["engram"], "the managed adapter must never discover or adopt ambient servers");
    assert.equal(isAbsolute(result.config.mcpServers.engram.command), true);
    assert.equal(isAbsolute(result.config.mcpServers.engram.args[0]), true);
    assert.equal(isAbsolute(result.config.mcpServers.engram.args[1]), true);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("missing or failed Engram resolution leaves an empty isolated adapter config", async () => {
  const { resolveMcpEngramConfig } = await import("../extensions/mcp-engram.ts");
  const missing = await resolveMcpEngramConfig({ resolveEngramBinary: () => undefined });
  assert.equal(missing.state, "missing");
  assert.deepEqual(missing.config, { mcpServers: {} });

  const failed = await resolveMcpEngramConfig({ resolveEngramBinary: () => { throw new Error("resolver failed"); } });
  assert.equal(failed.state, "failed");
  assert.deepEqual(failed.config, { mcpServers: {} });
  assert.match(failed.reason ?? "", /resolver failed/);
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
