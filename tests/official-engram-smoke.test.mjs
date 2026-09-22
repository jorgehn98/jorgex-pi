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
// settings.json (single official pair), mcp.json (official engram server whose
// command is the verified binary), and npm/node_modules with the ACTUAL
// gentle-engram + pi-mcp-adapter packages. Pi 0.85.1 additionally needs
// JORGEX_PI_BIN (or JORGEX_PI_SDK_ROOT) per the existing harness.
const officialSetupDir = process.env.JORGEX_OFFICIAL_SETUP_DIR?.trim();
const configuredPiBin = process.env.JORGEX_PI_BIN?.trim();
const configuredSdkRoot = process.env.JORGEX_PI_SDK_ROOT?.trim();

function resolveRealSetup() {
  if (!officialSetupDir) return undefined;
  const settingsPath = join(officialSetupDir, "settings.json");
  const mcpPath = join(officialSetupDir, "mcp.json");
  const gentleIndex = join(officialSetupDir, "npm", "node_modules", "gentle-engram", "index.ts");
  const adapterIndex = join(officialSetupDir, "npm", "node_modules", "pi-mcp-adapter", "index.ts");
  for (const path of [settingsPath, mcpPath, gentleIndex, adapterIndex]) {
    if (!existsSync(path)) throw new Error(`JORGEX_OFFICIAL_SETUP_DIR is incomplete: missing ${path}`);
  }
  return { dir: officialSetupDir, settingsPath, mcpPath, gentleIndex, adapterIndex };
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

function resolvePiTargets() {
  const sdkRoot = configuredSdkRoot || (configuredPiBin ? resolveSdkRootFromBin(configuredPiBin) : undefined);
  const has851 = sdkRoot && existsSync(join(sdkRoot, "package.json"));
  return [
    { name: "0.84.2", sdkRoot: undefined },
    ...(has851 ? [{ name: "0.85.1", sdkRoot }] : []),
  ];
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
  writeFileSync(join(agentDir, "mcp.json"), mcpBytes);
  const mcp = JSON.parse(mcpBytes);
  const engramBin = mcp.mcpServers?.engram?.command;
  assert.equal(typeof engramBin, "string", "provisioned mcp.json must carry the official engram server command");
  assert.ok(existsSync(engramBin), `provisioned engram binary must exist: ${engramBin}`);
  try {
    execFileSync(engramBin, ["--version"], { encoding: "utf8", timeout: 15_000 });
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
  return { sandbox, home, agentDir, cwd, xdgConfig, xdgCache, xdgData, tempDir, engramBin, fakePnpm };
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
    assert.equal(manifest.bundledDependencies?.includes("pi-mcp-adapter"), false);
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

const realSkip = !officialSetupDir
  ? "requires JORGEX_OFFICIAL_SETUP_DIR with real gentle-engram + pi-mcp-adapter installed by real `engram setup pi` (verified stable temp binary)"
  : false;

for (const target of resolvePiTargets()) {
  const targetSkip = realSkip || (target.name === "0.85.1" && !target.sdkRoot
    ? "requires JORGEX_PI_BIN for the Pi 0.85.1 loader"
    : false);
  for (const order of expected.orders) {
    test(`official smoke (real packages): Pi ${target.name} loads gentle+adapter+jorgex (${order}) with native surface and runtime-register`, { skip: targetSkip }, async () => {
      const setup = resolveRealSetup();
      const sandbox = setupRealSandbox(setup);
      try {
        const probed = runRealProbe({ sandbox, setup, sdkRoot: target.sdkRoot, order });
        const where = `${target.name}/${order}`;
        assert.deepEqual(probed.loaderErrors, [], `${where}: real loader must load gentle+adapter+jorgex without diagnostics`);
        assert.deepEqual(probed.sixMissing, [], `${where}: the six gentle reads must be present in the native surface`);
        assert.equal(probed.sixPresent.length, 6, `${where}: exactly the six reads must be observed`);
        assert.equal(probed.bootstrapRegistered, true, `${where}: bootstrap registration must land on the real adapter`);
        assert.equal(probed.prompt1HasContext7, true, `${where}: managed prompt must include Context7 after real registration`);
        assert.equal(probed.prompt1HasPolicy, true, `${where}: managed prompt must keep the policy section`);
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
        assert.equal(probed.mcpUnchanged, true, `${where}: session lifecycle must not rewrite mcp.json`);
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
    if (target.name === "0.85.1" && !target.sdkRoot) continue;
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
        `${where}: second session must keep managed Context7 (observed blocker: already-registered leak, duplicateError=${probed.secondSession.duplicateError})`,
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
