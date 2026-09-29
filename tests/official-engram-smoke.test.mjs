import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";

const testDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(testDir, "..");
const expected = JSON.parse(readFileSync(join(testDir, "fixtures", "official-engram-smoke.expected.json"), "utf8"));
const jiti = createJiti(import.meta.url, { moduleCache: false });

// Dated observation only (2026-09-21, see fixtures/official-engram-smoke.expected.json
// for sizes/digests): real `engram setup pi` with a temp stable binary downloaded
// from GitHub releases/latest and verified by exact asset size/digest, under
// env -i isolated HOME/PI dir, installed exactly one gentle-engram@semver plus
// one pi-mcp-adapter. The values below seed representative valid inputs; every
// assertion checks shapes and singleton ownership, never these versions.
const SEED_GENTLE = "npm:gentle-engram@0.1.13";
const SEED_ADAPTER = "npm:pi-mcp-adapter";

// Real-package provisioning (harness-provided, never downloaded by the test):
// JORGEX_OFFICIAL_SETUP_DIR points at an isolated agent dir prepared by a real
// `engram setup pi` with a verified stable temp binary. It must contain
// settings.json (single official pair), the MCP config selected by the installed
// adapter metadata, and npm/node_modules with the ACTUAL gentle-engram +
// pi-mcp-adapter packages. Adapters before 3.0.0 read legacy mcp.json; 3.0.0+
// read mcp-adapter.json. Pi SDK targets are labelled from their package metadata.
const officialSetupDir = process.env.JORGEX_OFFICIAL_SETUP_DIR?.trim();
const configuredPiBin = process.env.JORGEX_PI_BIN?.trim();
const configuredSdkRoot = process.env.JORGEX_PI_SDK_ROOT?.trim();
const PI_SDK_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const PI_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const ADAPTER_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function mcpConfigNameForAdapter(adapterPackage, adapterManifest) {
  if (adapterPackage?.name !== "pi-mcp-adapter" || typeof adapterPackage.version !== "string") {
    throw new Error(`JORGEX_OFFICIAL_SETUP_DIR has invalid pi-mcp-adapter metadata at ${adapterManifest}`);
  }
  const match = ADAPTER_VERSION_PATTERN.exec(adapterPackage.version);
  if (!match) throw new Error(`JORGEX_OFFICIAL_SETUP_DIR has invalid pi-mcp-adapter version at ${adapterManifest}`);
  return Number(match[1]) >= 3 ? "mcp-adapter.json" : "mcp.json";
}

function resolveRealSetup(setupDir = officialSetupDir) {
  if (!setupDir) return undefined;
  const settingsPath = join(setupDir, "settings.json");
  const gentleIndex = join(setupDir, "npm", "node_modules", "gentle-engram", "index.ts");
  const adapterIndex = join(setupDir, "npm", "node_modules", "pi-mcp-adapter", "index.ts");
  const adapterManifest = join(setupDir, "npm", "node_modules", "pi-mcp-adapter", "package.json");
  for (const path of [settingsPath, gentleIndex, adapterIndex, adapterManifest]) {
    if (!existsSync(path)) throw new Error(`JORGEX_OFFICIAL_SETUP_DIR is incomplete: missing ${path}`);
  }
  let adapterPackage;
  try {
    adapterPackage = JSON.parse(readFileSync(adapterManifest, "utf8"));
  } catch (error) {
    throw new Error(`JORGEX_OFFICIAL_SETUP_DIR has unreadable pi-mcp-adapter metadata at ${adapterManifest}: ${error?.message ?? error}`);
  }
  const mcpConfigName = mcpConfigNameForAdapter(adapterPackage, adapterManifest);
  const mcpPath = join(setupDir, mcpConfigName);
  if (!existsSync(mcpPath)) throw new Error(`JORGEX_OFFICIAL_SETUP_DIR is incomplete: missing ${mcpPath}`);

  // Preserve any other user-owned config in the isolated copy as well. The
  // selected file is authoritative for the installed adapter; copying the
  // alternate file (when present) makes duplicate legacy/current state visible
  // to the real bridge instead of silently migrating or dropping it.
  const alternateMcpConfigName = mcpConfigName === "mcp.json" ? "mcp-adapter.json" : "mcp.json";
  const configNames = [mcpConfigName, ...(existsSync(join(setupDir, alternateMcpConfigName)) ? [alternateMcpConfigName] : [])];
  return {
    dir: setupDir,
    settingsPath,
    mcpPath,
    mcpConfigName,
    configNames,
    gentleIndex,
    adapterIndex,
    adapterManifest,
    adapterPackage,
  };
}

function resolveSdkRootFromBin(piBin) {
  let directory = dirname(resolve(piBin));
  try {
    const linkTarget = readlinkSync(piBin);
    directory = dirname(resolve(dirname(piBin), linkTarget));
  } catch {
    // fall through to bin directory walk
  }
  let current = directory;
  while (true) {
    const candidate = join(current, "dist", "index.js");
    if (existsSync(candidate)) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function readPiSdkVersion(sdkRoot) {
  const manifestPath = join(sdkRoot, "package.json");
  if (!existsSync(manifestPath)) throw new Error(`configured Pi SDK is incomplete: missing ${manifestPath}`);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`configured Pi SDK metadata is unreadable at ${manifestPath}: ${error?.message ?? error}`);
  }
  if (manifest?.name !== PI_SDK_PACKAGE_NAME || typeof manifest.version !== "string" || !PI_VERSION_PATTERN.test(manifest.version)) {
    throw new Error(`configured Pi SDK metadata is invalid at ${manifestPath}`);
  }
  return manifest.version;
}

function resolvePiTargets() {
  const localSdkRoot = resolve(root, "node_modules", "@earendil-works", "pi-coding-agent");
  const localVersion = readPiSdkVersion(localSdkRoot);
  const targets = [{ name: localVersion, sdkRoot: undefined }];
  const configuredRoot = configuredSdkRoot
    ? resolve(configuredSdkRoot)
    : (configuredPiBin ? resolveSdkRootFromBin(configuredPiBin) : undefined);
  if (configuredSdkRoot || configuredPiBin) {
    if (!configuredRoot) throw new Error("configured Pi binary does not resolve to a Pi SDK root");
    const configuredVersion = readPiSdkVersion(configuredRoot);
    if (configuredVersion !== localVersion) targets.push({ name: configuredVersion, sdkRoot: configuredRoot });
  }
  return targets;
}

function setupSandbox() {
  const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-official-smoke-"));
  const home = join(sandbox, "home");
  const agentDir = join(sandbox, "agent");
  const cwd = join(sandbox, "workspace");
  const xdgConfig = join(sandbox, "xdg-config");
  const xdgCache = join(sandbox, "xdg-cache");
  const xdgData = join(sandbox, "xdg-data");
  const tempDir = join(sandbox, "temp");
  for (const path of [home, agentDir, cwd, xdgConfig, xdgCache, xdgData, tempDir]) {
    mkdirSync(path, { recursive: true });
  }
  const fakeBin = join(sandbox, "engram");
  writeFileSync(fakeBin, "fake binary; never execute\n");
  chmodSync(fakeBin, 0o755);
  const fakePnpm = join(sandbox, "pnpm");
  writeFileSync(fakePnpm, "fake pnpm; never execute\n");
  chmodSync(fakePnpm, 0o755);
  const handoffPath = join(agentDir, "jorgex-pi", "devtools.v1.json");
  mkdirSync(dirname(handoffPath), { recursive: true });
  writeFileSync(
    handoffPath,
    `${JSON.stringify({ schemaVersion: 1, enabled: true, command: fakePnpm, args: [...expected.devtools.args] })}\n`,
  );
  writeFileSync(
    join(agentDir, "settings.json"),
    `${JSON.stringify({ packages: [SEED_GENTLE, SEED_ADAPTER] }, null, 2)}\n`,
  );
  const adapterDir = join(agentDir, "npm", "node_modules", "pi-mcp-adapter");
  mkdirSync(adapterDir, { recursive: true });
  writeFileSync(join(adapterDir, "package.json"), JSON.stringify({ name: "pi-mcp-adapter", version: "2.36.0" }));
  writeFileSync(
    join(agentDir, "mcp.json"),
    `${JSON.stringify({ mcpServers: { engram: { command: fakeBin, args: ["mcp", "--tools=agent"], lifecycle: "lazy", directTools: false } } }, null, 2)}\n`,
  );
  return { sandbox, home, agentDir, cwd, xdgConfig, xdgCache, xdgData, tempDir, fakeBin, fakePnpm, handoffPath };
}

function setupRealSandbox(setup) {
  const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-official-real-"));
  const home = join(sandbox, "home");
  const agentDir = join(sandbox, "agent");
  const cwd = join(sandbox, "workspace");
  const xdgConfig = join(sandbox, "xdg-config");
  const xdgCache = join(sandbox, "xdg-cache");
  const xdgData = join(sandbox, "xdg-data");
  const tempDir = join(sandbox, "temp");
  for (const path of [home, agentDir, cwd, xdgConfig, xdgCache, xdgData, tempDir]) {
    mkdirSync(path, { recursive: true });
  }
  // Byte-identical copy of the real setup state: the packages under test are
  // the ACTUAL installed files, referenced by path in the probe.
  const settingsBytes = readFileSync(setup.settingsPath, "utf8");
  const mcpBytes = readFileSync(setup.mcpPath, "utf8");
  const settings = JSON.parse(settingsBytes);
  const gentleCount = (settings.packages ?? []).filter((entry) => {
    const source = typeof entry === "string" ? entry : entry?.source;
    return typeof source === "string" && /^npm:gentle-engram@\d+\.\d+\.\d+/.test(source);
  }).length;
  const adapterCount = (settings.packages ?? []).filter((entry) => {
    const source = typeof entry === "string" ? entry : entry?.source;
    return typeof source === "string" && /^npm:pi-mcp-adapter(@[^/\s]+)?$/.test(source);
  }).length;
  assert.equal(gentleCount, 1, `provisioned setup must own exactly one gentle package: ${settingsBytes}`);
  assert.equal(adapterCount, 1, `provisioned setup must own exactly one adapter package: ${settingsBytes}`);
  writeFileSync(join(agentDir, "settings.json"), settingsBytes);
  for (const configName of setup.configNames) {
    writeFileSync(join(agentDir, configName), readFileSync(join(setup.dir, configName), "utf8"));
  }
  const adapterDir = join(agentDir, "npm", "node_modules", "pi-mcp-adapter");
  mkdirSync(adapterDir, { recursive: true });
  writeFileSync(join(adapterDir, "package.json"), readFileSync(setup.adapterManifest));
  const mcp = JSON.parse(mcpBytes);
  const engramBin = mcp.mcpServers?.engram?.command;
  assert.equal(typeof engramBin, "string", `provisioned ${setup.mcpConfigName} must carry the official engram server command`);
  assert.ok(existsSync(engramBin), `provisioned engram binary must exist: ${engramBin}`);
  try {
    execFileSync(engramBin, ["--version"], {
      encoding: "utf8",
      timeout: 15_000,
      cwd: cwd,
      env: {
        HOME: home,
        USERPROFILE: home,
        PI_CODING_AGENT_DIR: agentDir,
        XDG_CONFIG_HOME: xdgConfig,
        XDG_CACHE_HOME: xdgCache,
        XDG_DATA_HOME: xdgData,
        TEMP: tempDir,
        TMP: tempDir,
        TMPDIR: tempDir,
        PATH: "/usr/bin:/bin",
      },
    });
  } catch (error) {
    throw new Error(`provisioned engram binary is not executable: ${engramBin}`);
  }
  const fakePnpm = join(sandbox, "pnpm");
  writeFileSync(fakePnpm, "fake pnpm; never execute\n");
  chmodSync(fakePnpm, 0o755);
  const handoffPath = join(agentDir, "jorgex-pi", "devtools.v1.json");
  mkdirSync(dirname(handoffPath), { recursive: true });
  writeFileSync(
    handoffPath,
    `${JSON.stringify({ schemaVersion: 1, enabled: true, command: fakePnpm, args: [...expected.devtools.args] })}\n`,
  );
  return { sandbox, home, agentDir, cwd, xdgConfig, xdgCache, xdgData, tempDir, engramBin, fakePnpm, mcpConfigName: setup.mcpConfigName };
}

function makeSetupPathFixture(adapterVersion, configName) {
  const setupDir = mkdtempSync(join(tmpdir(), "jorgex-pi-official-config-path-"));
  const adapterDir = join(setupDir, "npm", "node_modules", "pi-mcp-adapter");
  const gentleDir = join(setupDir, "npm", "node_modules", "gentle-engram");
  mkdirSync(adapterDir, { recursive: true });
  mkdirSync(gentleDir, { recursive: true });
  writeFileSync(join(setupDir, "settings.json"), `${JSON.stringify({ packages: [SEED_GENTLE, SEED_ADAPTER] })}\n`);
  writeFileSync(join(gentleDir, "index.ts"), "export default {};\n");
  writeFileSync(join(adapterDir, "index.ts"), "export default {};\n");
  writeFileSync(join(adapterDir, "package.json"), `${JSON.stringify({ name: "pi-mcp-adapter", version: adapterVersion })}\n`);
  writeFileSync(join(setupDir, configName), "{}\n");
  return setupDir;
}

function allowedHostEnv() {
  const allowed = {};
  for (const key of ["PATH", "PATHEXT", "SYSTEMROOT", "SystemRoot", "COMSPEC", "ComSpec", "WINDIR", "windir"]) {
    if (process.env[key] !== undefined) allowed[key] = process.env[key];
  }
  return allowed;
}

function runRealProbe({ sandbox, setup, sdkRoot, order }) {
  const probe = join(testDir, "fixtures", "probe-official-real.mjs");
  const env = {
    ...allowedHostEnv(),
    HOME: sandbox.home,
    USERPROFILE: sandbox.home,
    PATH: "/usr/bin:/bin",
    PI_CODING_AGENT_DIR: sandbox.agentDir,
    JORGEX_MCP_CONFIG_NAME: sandbox.mcpConfigName,
    XDG_CONFIG_HOME: sandbox.xdgConfig,
    XDG_CACHE_HOME: sandbox.xdgCache,
    XDG_DATA_HOME: sandbox.xdgData,
    TEMP: sandbox.tempDir,
    TMP: sandbox.tempDir,
    TMPDIR: sandbox.tempDir,
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
    NO_COLOR: "1",
    ENGRAM_BIN: sandbox.engramBin,
    // Discard-port guard: gentle-engram must never spawn a server during the
    // probe; explicit ENGRAM_URL disables its startup path and every attempt
    // targets this refused port (fetch is additionally blocked below).
    ENGRAM_URL: "http://127.0.0.1:9",
  };
  if (sdkRoot) env.JORGEX_PI_SDK_ROOT = sdkRoot;
  const output = execFileSync(
    process.execPath,
    [probe, root, setup.gentleIndex, setup.adapterIndex, order],
    { cwd: sandbox.cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 },
  );
  return JSON.parse(output);
}

test("official smoke: isolated single pair resolves managed bridge with gentle profile and no bundled copy", async () => {
  const sandbox = setupSandbox();
  try {
    const { inspectContext7Config } = await import("../extensions/context7-config.mjs");
    const { resolveMcpEngramConfig } = await import("../extensions/mcp-engram.ts");

    const inspection = inspectContext7Config({ env: { HOME: sandbox.home, PI_CODING_AGENT_DIR: sandbox.agentDir }, cwd: sandbox.cwd, platform: "linux" });
    assert.equal(inspection.state, "available", `single pair ${SEED_GENTLE} + ${SEED_ADAPTER} must be the official owner (shape, not versions)`);

    const projectSettingsPath = join(sandbox.cwd, ".pi", "settings.json");
    mkdirSync(dirname(projectSettingsPath), { recursive: true });
    writeFileSync(projectSettingsPath, `${JSON.stringify({ packages: [SEED_GENTLE] })}\n`);
    const projectDup = inspectContext7Config({ env: { HOME: sandbox.home, PI_CODING_AGENT_DIR: sandbox.agentDir }, cwd: sandbox.cwd, platform: "linux" });
    assert.equal(projectDup.state, "conflict", "project gentle duplicate must fail closed");
    rmSync(projectSettingsPath, { force: true });

    writeFileSync(join(sandbox.agentDir, "settings.json"), `${JSON.stringify({ packages: [] })}\n`);
    const missing = inspectContext7Config({ env: { HOME: sandbox.home, PI_CODING_AGENT_DIR: sandbox.agentDir }, cwd: sandbox.cwd, platform: "linux" });
    assert.notEqual(missing.state, "available", "missing official packages must not look available");
    writeFileSync(join(sandbox.agentDir, "settings.json"), `${JSON.stringify({ packages: [SEED_GENTLE, SEED_ADAPTER] })}\n`);

    const settingsBefore = readFileSync(join(sandbox.agentDir, "settings.json"), "utf8");
    const managed = await resolveMcpEngramConfig({
      resolveEngramBinary: () => sandbox.fakeBin,
      env: { HOME: sandbox.home, PI_CODING_AGENT_DIR: sandbox.agentDir },
      platform: "linux",
      cwd: sandbox.cwd,
    });
    assert.equal(managed.state, "managed", "isolated fake binary + single pair must resolve managed");
    assert.deepEqual(managed.config.mcpServers.engram.args, [...expected.engramServer.args]);
    assert.equal(managed.config.mcpServers.engram.lifecycle, expected.engramServer.lifecycle);
    assert.equal(managed.config.mcpServers.engram.directTools, false);
    assert.equal(managed.config.mcpServers.engram.toolPrefix, expected.engramServer.toolPrefix);
    assert.deepEqual(managed.config.mcpServers.engram.excludeTools, [...expected.engramServer.excludedTools]);
    assert.equal(managed.config.mcpServers.context7?.url, expected.context7.url);
    assert.equal(managed.config.mcpServers.context7?.directTools, false);
    assert.equal(managed.config.mcpServers.context7?.lifecycle, expected.context7.lifecycle);
    assert.deepEqual(managed.config.mcpServers["chrome-devtools"]?.args, [...expected.devtools.args]);
    assert.equal(managed.config.mcpServers["chrome-devtools"]?.directTools, false);
    assert.equal(readFileSync(join(sandbox.agentDir, "settings.json"), "utf8"), settingsBefore, "bridge resolution must be read-only");

    const keyed = await resolveMcpEngramConfig({
      resolveEngramBinary: () => sandbox.fakeBin,
      env: { HOME: sandbox.home, PI_CODING_AGENT_DIR: sandbox.agentDir, CONTEXT7_API_KEY: "fixture-context7-token" },
      platform: "linux",
      cwd: sandbox.cwd,
    });
    assert.deepEqual(keyed.config.mcpServers.context7?.headers, { CONTEXT7_API_KEY: "${CONTEXT7_API_KEY}" });
    assert.equal(JSON.stringify(keyed.config).includes("fixture-context7-token"), false);

    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    assert.equal(manifest.dependencies?.["pi-mcp-adapter"], undefined);
    assert.equal(manifest.dependencies?.["gentle-engram"], undefined);
    assert.ok(
      manifest.bundledDependencies === undefined || !manifest.bundledDependencies.includes("pi-mcp-adapter"),
      "bundledDependencies must not claim the external adapter",
    );
    const lock = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
    assert.doesNotMatch(lock, /pi-mcp-adapter@2\.27\.0/);
    const inventory = JSON.parse(readFileSync(join(root, "contract", "components.v1.json"), "utf8"));
    assert.equal(inventory.components.some(({ name }) => name === "pi-mcp-adapter"), false);
    assert.equal(inventory.components.some(({ name }) => name === "gentle-engram"), false);
    const bridgeSource = readFileSync(join(root, "extensions", "mcp-engram.ts"), "utf8");
    const bootstrapSource = readFileSync(join(root, "extensions", "bootstrap.ts"), "utf8");
    assert.doesNotMatch(bridgeSource, /createMcpAdapter/);
    assert.doesNotMatch(bootstrapSource, /createMcpAdapter/);
  } finally {
    rmSync(sandbox.sandbox, { recursive: true, force: true });
  }
});

test("official smoke harness selects the adapter-owned MCP source without migration or a major-version cap", () => {
  const cases = [
    { version: "2.36.0", configName: "mcp.json" },
    { version: "3.2.0", configName: "mcp-adapter.json" },
    { version: "4.0.0", configName: "mcp-adapter.json" },
  ];
  const sandboxes = [];
  try {
    for (const { version, configName } of cases) {
      const setupDir = makeSetupPathFixture(version, configName);
      sandboxes.push(setupDir);
      const setup = resolveRealSetup(setupDir);
      assert.equal(setup.mcpConfigName, configName, `${version} must select the config read by its adapter`);
      assert.equal(setup.mcpPath, join(setupDir, configName));
      assert.deepEqual(setup.configNames, [configName], `${version} fixture must not invent or migrate the other config`);
      assert.equal(existsSync(join(setupDir, configName === "mcp.json" ? "mcp-adapter.json" : "mcp.json")), false);
    }
  } finally {
    for (const sandbox of sandboxes) rmSync(sandbox, { recursive: true, force: true });
  }
});

const realSkip = !officialSetupDir
  ? "requires JORGEX_OFFICIAL_SETUP_DIR with real gentle-engram + pi-mcp-adapter installed by real `engram setup pi` (verified stable temp binary)"
  : false;

for (const target of resolvePiTargets()) {
  const targetSkip = realSkip;
  for (const order of expected.orders) {
    test(`official smoke (real packages): Pi ${target.name} loads gentle+adapter+jorgex (${order}) with native surface and runtime-register`, { skip: targetSkip }, async () => {
      const setup = resolveRealSetup();
      const sandbox = setupRealSandbox(setup);
      try {
        const probed = runRealProbe({ sandbox, setup, sdkRoot: target.sdkRoot, order });
        const where = `${target.name}/${order}`;
        const diagnostics = JSON.stringify(probed.diagnostics ?? {});
        assert.equal(probed.piVersion, target.name, `${where}: test label must match the SDK package actually loaded by the probe; diagnostics=${diagnostics}`);
        assert.deepEqual(probed.loaderErrors, [], `${where}: real loader must load gentle+adapter+jorgex without diagnostics`);
        assert.deepEqual(probed.diagnostics?.extensionErrors ?? [], [], `${where}: intended Pi lifecycle must not emit extension errors; diagnostics=${diagnostics}`);
        assert.deepEqual(probed.diagnostics?.notifications ?? [], [], `${where}: intended Pi lifecycle must not emit error notifications; diagnostics=${diagnostics}`);
        assert.deepEqual(probed.sixMissing, [], `${where}: the six gentle reads must be present in the native surface`);
        assert.equal(probed.sixPresent.length, 6, `${where}: exactly the six reads must be observed`);
        assert.deepEqual(probed.secondSession.sixMissing, [], `${where}: replacement runner must also expose all six gentle reads`);
        assert.equal(probed.secondSession.sixPresent.length, 6, `${where}: replacement runner must not mask a first-runner tool loss`);
        assert.equal(probed.bootstrapRegistered, true, `${where}: bootstrap registration must land on the real adapter`);
        assert.equal(probed.prompt1HasContext7, true, `${where}: managed prompt must include Context7 after real registration; diagnostics=${diagnostics}`);
        assert.equal(probed.prompt1HasPolicy, true, `${where}: managed prompt must keep the policy section; diagnostics=${diagnostics}`);
        assert.equal(probed.officialHeading, "## Engram Persistent Memory — Protocol", `${where}: probe must use the stable official heading without snapshotting provider internals`);
        for (const [label, eng] of [["main", probed.mainEngram], ["child", probed.childEngram]]) {
          assert.equal(eng.officialHeadingCount, 1, `${where}: ${label} final prompt must contain the official Engram protocol exactly once`);
          assert.equal(eng.hasJorgeXEngramMarker, false, `${where}: ${label} final prompt must contain no JorgeX Engram marker`);
          assert.equal(eng.hasJorgeXEngramBlock, false, `${where}: ${label} final prompt must contain no JorgeX Engram block`);
        }
        // Real adapter contract (observed, not the retired fictional shape):
        // { ok: true, registration: { dispose } }, snapshots via runtime-snapshot:v1.
        assert.equal(probed.probeResultShape.present, true, `${where}: real adapter must answer runtime-register`);
        assert.equal(probed.probeResultShape.ok, true, `${where}: real registration must be ok`);
        assert.equal(probed.probeResultShape.hasRegDispose, "function", `${where}: real result must carry registration.dispose`);
        assert.equal(probed.probeResultShape.hasTopDispose, "undefined", `${where}: real result carries no top-level dispose`);
        for (const [label, snapshot] of [["context7", probed.snapshotContext7], ["chrome-devtools", probed.snapshotDevtools]]) {
          assert.equal(snapshot.ok, true, `${where}: real ${label} snapshot must resolve: ${snapshot.error ?? "ok"}`);
          assert.equal(snapshot.directTools, false, `${where}: real ${label} snapshot must keep directTools:false`);
          assert.equal(snapshot.runtime, true, `${where}: real ${label} snapshot must be runtime-scoped`);
          assert.equal(snapshot.persisted, false, `${where}: real ${label} snapshot must never persist`);
        }
        assert.equal(probed.dispose1, "ok", `${where}: registration.dispose must work`);
        assert.equal(probed.dispose2, "ok-idempotent", `${where}: registration.dispose must be idempotent`);
        assert.equal(probed.reRegisterAfterDispose, true, `${where}: re-registration after dispose must succeed`);
        assert.equal(probed.settingsUnchanged, true, `${where}: session lifecycle must not rewrite settings.json`);
        assert.equal(probed.mcpUnchanged, true, `${where}: session lifecycle must not rewrite ${sandbox.mcpConfigName}`);
        assert.ok(
          (probed.fetchHosts ?? []).every((host) => host === "127.0.0.1:9"),
          `${where}: the only fetch targets may be the discard-port guard: ${JSON.stringify(probed.fetchHosts)}`,
        );
        assert.ok(probed.isolation.home.startsWith(sandbox.sandbox), `${where}: must run under isolated HOME`);
        assert.ok(probed.isolation.agentDir.startsWith(sandbox.sandbox), `${where}: must run under isolated agent dir`);
        assert.equal(probed.isolation.piPackageDirConfigured, false, "PI_PACKAGE_DIR must remain unset");
      } finally {
        rmSync(sandbox.sandbox, { recursive: true, force: true });
      }
    });
  }
}

test("official smoke (real packages): registrations release on shutdown for the next session", { skip: realSkip }, async () => {
  const setup = resolveRealSetup();
  // Version/order matrix stays explicit: runtime registration and disposal are
  // loader- and order-independent, but the evidence must name every combo.
  const matrix = [];
  for (const target of resolvePiTargets()) {
    for (const order of expected.orders) matrix.push({ target, order });
  }
  assert.ok(matrix.length > 0, "at least one Pi loader must be provisioned for the real dispose check");
  for (const { target, order } of matrix) {
    const sandbox = setupRealSandbox(setup);
    try {
      const probed = runRealProbe({ sandbox, setup, sdkRoot: target.sdkRoot, order });
      const where = `${target.name}/${order}`;
      assert.equal(
        probed.secondSession.promptHasContext7,
        true,
        `${where}: second session must keep managed Context7 (observed blocker: already-registered leak, duplicateError=${probed.secondSession.duplicateError}); diagnostics=${JSON.stringify(probed.diagnostics ?? {})}`,
      );
      assert.equal(
        probed.secondSession.bootstrapRegistered,
        true,
        `${where}: replacement runner must register Context7 through the real bootstrap lifecycle; diagnostics=${JSON.stringify(probed.diagnostics ?? {})}`,
      );
      assert.equal(
        probed.secondSession.duplicateError,
        null,
        `${where}: re-registration after shutdown must not collide: ${probed.secondSession.duplicateError}`,
      );
    } finally {
      rmSync(sandbox.sandbox, { recursive: true, force: true });
    }
  }
});

test("explicitly set invalid JORGEX_OFFICIAL_SETUP_DIR must fail the smoke lane, while absent env may skip", async () => {
  const smokeSource = readFileSync(join(root, "tests", "official-engram-smoke.test.mjs"), "utf8");
  assert.match(smokeSource, /requires JORGEX_OFFICIAL_SETUP_DIR/, "absent env may skip with a documented reason");

  const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-official-setup-invalid-"));
  try {
    for (const path of [
      join(sandbox, "settings.json"),
      join(sandbox, "mcp.json"),
      join(sandbox, "npm", "node_modules", "gentle-engram", "index.ts"),
      join(sandbox, "npm", "node_modules", "pi-mcp-adapter", "index.ts"),
    ]) {
      assert.equal(existsSync(path), false, `invalid fixture must miss ${path}`);
    }
    assert.equal(
      /\?\s*`invalid JORGEX_OFFICIAL_SETUP_DIR:/.test(smokeSource),
      false,
      "explicitly set invalid setup must fail the smoke lane, never convert to skip success",
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("official smoke: child uses ambient gentle-engram with no JorgeX gate, selector, or env wiring", async () => {
  assert.equal(existsSync(join(root, "extensions", "engram-child.ts")), false, "extensions/engram-child.ts must not exist; gentle-engram loads ambiently");
  const agentSource = readFileSync(join(root, "agents", "engram.md"), "utf8");
  assert.doesNotMatch(agentSource, /engram-child/, "engram agent must not reference a package-local shim");
  assert.match(agentSource, /maxSubagentDepth:\s*0/, "general subdelegation restriction remains");
  assert.equal(
    agentSource.split("\n").some((line) => line.startsWith("tools:")),
    false,
    "engram agent must omit tools so ambient gentle-engram loads; empty tools: would emit --no-tools",
  );
  for (const name of ["bootstrap.ts", "mcp-engram.ts"]) {
    const source = readFileSync(join(root, "extensions", name), "utf8");
    assert.doesNotMatch(source, /ENGRAM_CHILD_ALLOWED_TOOLS/, `${name} must not carry a JorgeX selector`);
    assert.doesNotMatch(source, /MCP_DIRECT_TOOLS\s*=\s*["'](__none__|engram\/)/, `${name} must not wire MCP_DIRECT_TOOLS for the child`);
  }
});

// T63: real probe role-loading seam must fail visibly when agents/engram.md
// is missing/unreadable/empty; no artificial fallback is accepted. Focal RED
// without a real provider: executes the probe's actual role snippet (verbatim
// slice between markers) against isolated temp role roots at the real
// filesystem boundary. Real non-empty composition stays byte-real (control).
function loadT63ProbeRoleSnippet() {
  const probePath = join(root, "tests", "fixtures", "probe-official-real.mjs");
  const probeSource = readFileSync(probePath, "utf8");
  const start = probeSource.indexOf("let engramChildBase");
  const end = probeSource.indexOf("const childPrompt");
  assert.notEqual(start, -1, "probe must keep the role seam marker 'let engramChildBase'");
  assert.notEqual(end, -1, "probe must keep the child prompt marker 'const childPrompt'");
  assert.ok(end > start, "probe role seam must precede the child prompt");
  return probeSource.slice(start, end);
}

function runT63ProbeRoleSeam(roleRoot) {
  const snippet = loadT63ProbeRoleSnippet();
  const runner = new Function("root", "join", "readFileSync", `${snippet}\nreturn engramChildBase;`);
  return runner(roleRoot, join, readFileSync);
}

function makeT63RoleRoot() {
  const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-t63-"));
  mkdirSync(join(sandbox, "agents"), { recursive: true });
  return sandbox;
}

function cleanupT63RoleRoot(sandbox) {
  try {
    chmodSync(join(sandbox, "agents", "engram.md"), 0o644);
  } catch {
    // Missing or already removed; cleanup below still applies.
  }
  rmSync(sandbox, { recursive: true, force: true });
}

test("T63: non-empty agents/engram.md is used byte-real as child base (control)", () => {
  const sandbox = makeT63RoleRoot();
  try {
    const realBytes = readFileSync(join(root, "agents", "engram.md"), "utf8");
    assert.ok(realBytes.trim().length > 0, "repo fixture must carry a real non-empty role");
    writeFileSync(join(sandbox, "agents", "engram.md"), realBytes);
    const base = runT63ProbeRoleSeam(sandbox);
    assert.equal(base, realBytes, "real non-empty role must be used byte-real, never synthesized");
    assert.notEqual(base, "Engram child base policy", "real role must not collapse to the artificial fallback");
  } finally {
    cleanupT63RoleRoot(sandbox);
  }
});

test("T63: missing/empty/unreadable agents/engram.md aborts probe role seam without fallback", () => {
  const failures = [];
  const checkAbort = (label, setup) => {
    const sandbox = makeT63RoleRoot();
    try {
      const skipReason = setup(sandbox);
      if (skipReason) return `skipped ${label}: ${skipReason}`;
      try {
        const base = runT63ProbeRoleSeam(sandbox);
        failures.push(`${label}: expected abort with diagnostic, got fallback base=${JSON.stringify(String(base).slice(0, 80))}`);
      } catch (error) {
        const message = String(error?.message ?? error);
        if (!/agents\/engram\.md/.test(message)) {
          failures.push(`${label}: diagnostic must name agents/engram.md, got ${message.slice(0, 200)}`);
        } else if (!/missing|unreadable|empty|ENOENT|EACCES|EPERM/i.test(message)) {
          failures.push(`${label}: diagnostic must name missing/unreadable/empty, got ${message.slice(0, 200)}`);
        }
      }
      return undefined;
    } finally {
      cleanupT63RoleRoot(sandbox);
    }
  };

  const skipped = [];
  const noteSkip = (reason) => {
    if (reason) skipped.push(reason);
  };

  noteSkip(checkAbort("missing", (sandbox) => undefined));
  noteSkip(checkAbort("empty:0-byte", (sandbox) => {
    writeFileSync(join(sandbox, "agents", "engram.md"), "");
    return undefined;
  }));
  noteSkip(checkAbort("empty:whitespace", (sandbox) => {
    writeFileSync(join(sandbox, "agents", "engram.md"), "  \n\t\n");
    return undefined;
  }));
  noteSkip(checkAbort("unreadable", (sandbox) => {
    if (process.platform === "win32") return "chmod 000 is not portable on Windows";
    writeFileSync(join(sandbox, "agents", "engram.md"), "real role bytes\n");
    chmodSync(join(sandbox, "agents", "engram.md"), 0o000);
    try {
      readFileSync(join(sandbox, "agents", "engram.md"), "utf8");
      return "still readable after chmod 000 (root or permissive fs); portable skip";
    } catch {
      return undefined;
    }
  }));

  assert.equal(failures.length, 0, `T63 RED: probe role seam must abort with diagnostic, never fall back:\n${failures.join("\n")}${skipped.length ? `\n${skipped.join("\n")}` : ""}`);
});

test("T63: probe carries no artificial child fallback", () => {
  const probeSource = readFileSync(join(root, "tests", "fixtures", "probe-official-real.mjs"), "utf8");
  assert.doesNotMatch(probeSource, /Engram child base policy/, "probe must not synthesize a child base; missing/unreadable/empty must abort with diagnostic");
});
