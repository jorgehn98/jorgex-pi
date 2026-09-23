import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const testDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(testDir, "..");
const configuredPi = process.env.JORGEX_PI_BIN?.trim();
const skipReason = configuredPi
  ? false
  : "requires JORGEX_PI_BIN for the real Pi host smoke (tested in this execution only; not a claim for all future versions)";
// NOTE: JORGEX_PI_PACKAGE_DIR is intentionally ignored here. This smoke always
// packs the worktree root fresh and installs the tarball via the configured
// host binary into the test's own isolated agentDir, so the RPC runs against
// freshly npm-resolved companions instead of the worktree's frozen CI deps.

test("experience settings use the native contract in local control and configured host (tested in this execution only)", { skip: skipReason }, async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-settings-compat-"));
  const localSdk = await import("@earendil-works/pi-coding-agent");

  try {
    const packageManifest = readJson(join(root, "package.json"));
    assert.equal(packageManifest.devDependencies?.["@earendil-works/pi-coding-agent"], "0.84.2");
    const versionEnvironment = isolatedEnv({
      home: join(sandbox, "version-home"),
      agentDir: join(sandbox, "version-agent"),
      cwd: sandbox,
      xdgConfig: join(sandbox, "version-xdg-config"),
      xdgCache: join(sandbox, "version-xdg-cache"),
      xdgData: join(sandbox, "version-xdg-data"),
      tempDir: join(sandbox, "version-temp"),
    });
    for (const path of [
      versionEnvironment.HOME,
      versionEnvironment.PI_CODING_AGENT_DIR,
      versionEnvironment.XDG_CONFIG_HOME,
      versionEnvironment.XDG_CACHE_HOME,
      versionEnvironment.XDG_DATA_HOME,
      versionEnvironment.TMPDIR,
    ]) mkdirSync(path, { recursive: true });
    const hostVersion = readPiVersion(configuredPi, versionEnvironment);
    assert.match(hostVersion, /^\d+\.\d+\.\d+/, "configured host must report a semver version (tested in this execution only)");
    const versions = [
      { name: "0.84.2", sdk: localSdk },
      {
        name: hostVersion,
        sdk: await import(pathToFileURL(resolveSdkModule(configuredPi, "core/settings-manager.js")).href),
      },
    ];

    for (const { name, sdk } of versions) {
      const agentDir = join(sandbox, name, "agent");
      const cwd = join(sandbox, name, "workspace");
      const settingsPath = join(agentDir, "settings.json");
      const projectSettingsPath = join(cwd, ".pi", "settings.json");
      mkdirSync(agentDir, { recursive: true });
      mkdirSync(join(cwd, ".pi"), { recursive: true });
      writeJson(settingsPath, {
        theme: "JorgeX",
        quietStartup: true,
        hideThinkingBlock: true,
        defaultThinkingLevel: "high",
      });
      writeJson(projectSettingsPath, {
        theme: "project-theme",
        quietStartup: false,
        hideThinkingBlock: false,
        defaultThinkingLevel: "low",
      });

      const settingsManager = sdk.SettingsManager.create(cwd, agentDir);
      assert.deepEqual(
        pickExperienceSettings(settingsManager.getGlobalSettings()),
        { theme: "JorgeX", quietStartup: true, hideThinkingBlock: true },
        `${name} must read all three global experience settings`,
      );
      assert.equal(settingsManager.getGlobalSettings().defaultThinkingLevel, "high", `${name} must preserve the global thinking level`);
      assert.equal(settingsManager.getTheme(), "project-theme", `${name} must preserve project theme precedence`);
      assert.equal(settingsManager.getQuietStartup(), false, `${name} must preserve project quietStartup precedence`);
      assert.equal(settingsManager.getHideThinkingBlock(), false, `${name} must preserve project hideThinkingBlock precedence`);
      assert.equal(settingsManager.getDefaultThinkingLevel(), "low", `${name} must preserve project defaultThinkingLevel precedence`);
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("configured host loads the freshly installed JorgeX package and exposes its real RPC contract (tested in this execution only)", { skip: skipReason }, async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-host-compat-"));
  const home = join(sandbox, "home");
  const agentDir = join(sandbox, "agent");
  const cwd = join(sandbox, "workspace");
  const xdgConfig = join(sandbox, "xdg-config");
  const xdgCache = join(sandbox, "xdg-cache");
  const xdgData = join(sandbox, "xdg-data");
  const tempDir = join(sandbox, "temp");
  const npmCache = join(sandbox, "npm-cache");
  const packDir = join(sandbox, "pack");
  const markers = join(sandbox, "markers.jsonl");
  const fakeEngram = join(sandbox, process.platform === "win32" ? "engram.exe" : "engram");
  const probe = join(testDir, "fixtures", "pi-sdk-compatibility-probe.mjs");

  for (const path of [home, agentDir, cwd, xdgConfig, xdgCache, xdgData, tempDir, npmCache, packDir]) {
    mkdirSync(path, { recursive: true });
  }
  writeJson(join(agentDir, "settings.json"), { packages: [] });

  try {
    assert.ok(existsSync(configuredPi), `configured Pi binary must exist: ${configuredPi}`);
    const hostVersion = readPiVersion(configuredPi, isolatedEnv({ home, agentDir, cwd, xdgConfig, xdgCache, xdgData, tempDir }));
    assert.match(hostVersion, /^\d+\.\d+\.\d+/, "configured host must report a semver version (tested in this execution only)");
    const rootManifest = readJson(join(root, "package.json"));
    assert.equal(rootManifest.name, "jorgex-pi", "the real smoke must load the JorgeX Pi package");
    const rootContract = readJson(join(root, "contract", "jorgex-pi.v1.json"));
    assert.equal(rootManifest.version, rootContract.package?.version, "the smoke package must match the root contract version");

    // Fresh product: pack the worktree root with pnpm (never npm/npx) and let
    // the configured host resolve companions via its native npm acquisition
    // into this sandbox's isolated agentDir. NEVER the personal ~/.pi.
    const tarball = packTarball(packDir);
    const installEnv = {
      ...allowedHostEnv(),
      HOME: home,
      TEMP: sandbox,
      TMP: sandbox,
      TMPDIR: sandbox,
      XDG_CACHE_HOME: xdgCache,
      XDG_CONFIG_HOME: xdgConfig,
      XDG_DATA_HOME: xdgData,
      PI_CODING_AGENT_DIR: agentDir,
      PI_TELEMETRY: "0",
      NPM_CONFIG_AUDIT: "false",
      NPM_CONFIG_CACHE: npmCache,
      NPM_CONFIG_FUND: "false",
      NPM_CONFIG_UPDATE_NOTIFIER: "false",
      NO_COLOR: "1",
    };
    execFileSync(configuredPi, ["install", `npm:jorgex-pi@file:${tarball}`, "--no-approve"], {
      cwd,
      env: installEnv,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: process.platform === "win32" ? 180_000 : 120_000,
    });
    const npmRoot = join(agentDir, "npm", "node_modules");
    const installedDir = join(npmRoot, "jorgex-pi");
    const installedManifest = readJson(join(installedDir, "package.json"));
    assert.equal(installedManifest.name, "jorgex-pi", `host ${hostVersion} install must produce the JorgeX Pi package`);
    assert.equal(installedManifest.version, rootManifest.version, `host ${hostVersion} installed version must match the packed root version`);
    assert.equal(installedManifest.version, rootContract.package?.version, `host ${hostVersion} installed version must match the root contract version`);
    const installedVersions = {};
    for (const name of Object.keys(rootManifest.dependencies ?? {})) {
      const depManifestPath = join(npmRoot, name, "package.json");
      assert.ok(existsSync(depManifestPath), `host ${hostVersion} npm-installed dep must exist at hoisted resolver path: ${name}`);
      const dep = readJson(depManifestPath);
      assert.equal(dep.name, name, `host ${hostVersion} hoisted dep name must match manifest: ${name}`);
      assert.match(String(dep.version), /^\d+\.\d+\.\d+/, `host ${hostVersion} installed version for ${name} must be readable without asserting an exact value`);
      installedVersions[name] = dep.version;
      assert.equal(
        existsSync(join(installedDir, "node_modules", name)),
        false,
        `host ${hostVersion} installed jorgex-pi must not contain nested bundled closure: ${name}`,
      );
    }
    const depSummary = `host ${hostVersion} with ${Object.entries(installedVersions).map(([name, version]) => `${name}@${version}`).join(", ")}`;

    const fakeServer = readFileSync(join(testDir, "fixtures", "fake-engram-mcp.mjs"), "utf8");
    writeFileSync(fakeEngram, `#!${process.execPath}\n${fakeServer}`);
    if (process.platform !== "win32") {
      chmodSync(fakeEngram, 0o755);
    } else {
      copyFileSync(process.execPath, fakeEngram);
      writeFileSync(join(sandbox, "mcp"), fakeServer);
    }

    writeJson(join(agentDir, "settings.json"), {
      packages: [installedDir],
    });
    const metadataCachePath = join(agentDir, "mcp-cache.json");
    if (!existsSync(metadataCachePath)) writeJson(metadataCachePath, { version: 1, servers: {} });

    const env = isolatedEnv({ home, agentDir, cwd, xdgConfig, xdgCache, xdgData, tempDir });
    env.ENGRAM_BIN = fakeEngram;
    env.JORGEX_PI_COMPAT_MARKERS = markers;

    const child = spawn(configuredPi, [
      "--mode", "rpc",
      "--no-session",
      "--no-approve",
      "--offline",
      "--no-context-files",
      "--extension", probe,
    ], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const records = [];
    let stderr = "";
    let rpcParseError;
    let lineBuffer = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      lineBuffer += chunk;
      let newline;
      while ((newline = lineBuffer.indexOf("\n")) !== -1) {
        const line = lineBuffer.slice(0, newline).replace(/\r$/, "");
        lineBuffer = lineBuffer.slice(newline + 1);
        if (line) {
          try {
            records.push(parseRpcLine(line));
          } catch (error) {
            rpcParseError = error;
          }
        }
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });

    try {
      const state = await requestRpc(child, records, "get_state");
      if (rpcParseError) throw rpcParseError;
      assert.equal(state.success, true, `Pi ${hostVersion} (${depSummary}) get_state failed: ${stderr}`);
      assert.equal(state.command, "get_state");
      assert.equal(typeof state.data.sessionId, "string");
      assert.equal(state.data.isStreaming, false);

      const commandsResponse = await requestRpc(child, records, "get_commands");
      assert.equal(commandsResponse.success, true, `Pi ${hostVersion} (${depSummary}) get_commands failed: ${stderr}`);
      const commands = commandsResponse.data.commands;
      const commandNames = commands.map((command) => command.name);
      assert.equal(new Set(commandNames).size, commandNames.length, "Pi must not duplicate slash commands across loaded companions");
      // External-bridge contract: the retired bundled adapter contributes no
      // commands. This env loads jorgex-pi alone (no provider packages), so the
      // bundled-era names must be absent; the official bridge capability below
      // replaces them instead of a bundled tool surface.
      for (const retired of ["mcp", "pi-mcp", "mcp-auth"]) {
        assert.equal(commandNames.includes(retired), false, `Pi ${hostVersion} must not expose retired bundled command ${retired}`);
      }
      assert.ok(commandNames.length >= 42, "the current JorgeX package must expose at least the reviewed 42-command surface (45 minus 3 retired bundled commands)");
      for (const name of [
        "jx-compat-probe", "permission-system", "subagents", "goal",
        "jorgex:header", "websearch", "curator", "google-account", "search", "lean-audit",
      ]) {
        assert.ok(commandNames.includes(name), `Pi ${hostVersion} (${depSummary}) must expose command ${name}`);
      }
      assert.ok(commands.every((command) => ["extension", "prompt", "skill"].includes(command.source)));

      const promptResponse = await requestRpc(child, records, "prompt", { message: "/jx-compat-probe" });
      assert.equal(promptResponse.success, true, `Pi ${hostVersion} (${depSummary}) extension prompt failed: ${stderr}`);
      const probeRecord = await waitForMarker(markers, (entry) => entry.event === "probe");
      assert.ok(probeRecord.activeTools.includes("bash"), `the probe must read active tools through Pi ${hostVersion} (${depSummary})`);
      for (const name of [
        "ask_user_question", "subagent", "web_search", "fetch_content",
        "goal_blocked", "goal_complete", "goal_wait",
      ]) {
        assert.ok(probeRecord.allTools.includes(name), `Pi ${hostVersion} (${depSummary}) must load companion tool ${name}`);
      }
      // Provider wait-role rename without a version pin: the retired
      // `subagent_wait` alias was replaced by `bg_wait`. Require the role, not
      // the alias — never waive the actual tool requirement. Permission-gating
      // of the renamed tools is pinned by the bootstrap regression test; this
      // probe exposes a single post-start snapshot, so the smoke asserts role
      // presence in allTools here.
      assert.ok(
        probeRecord.allTools.includes("subagent_wait") || probeRecord.allTools.includes("bg_wait"),
        `Pi ${hostVersion} (${depSummary}) must load the subagents wait role via subagent_wait or bg_wait; got [${[...probeRecord.allTools].sort().join(", ")}]`,
      );
      const actualEngramTools = probeRecord.allTools.filter((name) => name.startsWith("mem_")).sort();
      // External-bridge contract: Engram tools arrive only through the
      // provider-owned packages, never from the jorgex-pi bundle. This env
      // loads jorgex-pi alone, so no mem_* tool may appear here; the official
      // capability below is what replaces the retired bundled tool set.
      assert.deepEqual(actualEngramTools, [], "jorgex-pi alone must not provide Engram tools without the official provider packages");
      assert.equal(actualEngramTools.includes("mem_capture_passive"), false, "Pi must keep the passive Engram capture tool excluded");
      const bridgeContract = readJson(join(root, "contract", "jorgex-pi.v1.json"));
      assert.ok(bridgeContract.capabilities.includes("engram-official-bridge-v1"), "official bridge capability replaces the bundled adapter");
      assert.ok(bridgeContract.capabilities.includes("engram-runtime-tools-v1"), "official runtime-tools capability replaces the bundled tool set");
      assert.equal(bridgeContract.capabilities.includes("mcp-adapter-v1"), false, "owned mcp-adapter-v1 stays retired");
      assert.deepEqual(probeRecord.commands.sort(), commandNames.slice().sort(), "get_commands and the extension API must agree");

      const exit = await stopProcess(child);
      if (process.platform === "win32") {
        assert.ok(exit.code === 1 || exit.signal === "SIGTERM", `unexpected Pi shutdown; stderr: ${stderr}`);
      } else {
        assert.equal(exit.code, 143, `unexpected Pi shutdown; stderr: ${stderr}`);
      }
      const lifecycle = readMarkers(markers).map((entry) => entry.event);
      assert.ok(lifecycle.includes("session_start"), "Pi must emit session_start before serving RPC");
      assert.ok(lifecycle.includes("session_shutdown"), `Pi ${hostVersion} must run session_shutdown during SIGTERM teardown`);
      assert.equal(rpcParseError, undefined, `Pi emitted non-JSON RPC output: ${rpcParseError?.message ?? rpcParseError}`);
      const extensionErrors = records.filter((record) => record.type === "extension_error");
      assert.deepEqual(extensionErrors, [], `Pi emitted extension_error: ${JSON.stringify(extensionErrors)}`);
    } finally {
      await stopProcess(child);
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

function isolatedEnv({ home, agentDir, cwd, xdgConfig, xdgCache, xdgData, tempDir }) {
  const env = {
    HOME: home,
    USERPROFILE: home,
    PATH: process.platform === "win32" ? process.env.PATH ?? "" : "/usr/bin:/bin",
    PI_CODING_AGENT_DIR: agentDir,
    PI_CODING_AGENT_SESSION_DIR: join(agentDir, "sessions"),
    XDG_CONFIG_HOME: xdgConfig,
    XDG_CACHE_HOME: xdgCache,
    XDG_DATA_HOME: xdgData,
    TMP: tempDir,
    TMPDIR: tempDir,
    TEMP: tempDir,
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
    NO_COLOR: "1",
    NO_UPDATE_NOTIFIER: "1",
  };
  for (const key of ["PATHEXT", "SYSTEMROOT", "SystemRoot", "COMSPEC", "ComSpec", "WINDIR", "windir"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

function readPiVersion(pi, env) {
  return execFileSync(pi, ["--version"], {
    cwd: env.PI_CODING_AGENT_DIR,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
  }).trim();
}

function resolveSdkModule(piBinary, modulePath) {
  let directory = dirname(realpathSync(piBinary));
  while (directory !== dirname(directory)) {
    const candidate = join(directory, "dist", modulePath);
    if (existsSync(candidate)) return candidate;
    directory = dirname(directory);
  }
  throw new Error(`Unable to resolve Pi SDK module ${modulePath} from ${piBinary}`);
}

function packTarball(packDir) {
  const corepackEntry = join(dirname(process.execPath), "node_modules", "corepack", "dist", "corepack.js");
  const pm = existsSync(corepackEntry)
    ? { command: process.execPath, args: [corepackEntry, "pnpm"] }
    : { command: "pnpm", args: [] };
  execFileSync(pm.command, [...pm.args, "pack", "--pack-destination", packDir], {
    cwd: root,
    env: { ...process.env, NO_COLOR: "1" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const tarballs = readdirSync(packDir).filter((name) => name.endsWith(".tgz"));
  assert.equal(tarballs.length, 1);
  return join(packDir, tarballs[0]);
}

function allowedHostEnv() {
  const allowed = {};
  for (const key of ["PATH", "PATHEXT", "SYSTEMROOT", "SystemRoot", "COMSPEC", "ComSpec", "WINDIR", "windir"]) {
    if (process.env[key] !== undefined) allowed[key] = process.env[key];
  }
  return allowed;
}

function requestRpc(child, records, type, extra = {}) {
  const id = `jx-compat-${type}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  child.stdin.write(`${JSON.stringify({ id, type, ...extra })}\n`);
  return waitForRecord(records, (record) => record.type === "response" && record.id === id, 20_000);
}

function parseRpcLine(line) {
  try {
    return JSON.parse(line);
  } catch (error) {
    throw new Error(`Pi emitted non-JSON RPC output: ${line}`, { cause: error });
  }
}

function waitForRecord(records, predicate, timeoutMs) {
  const started = Date.now();
  return new Promise((resolvePromise, reject) => {
    const poll = () => {
      const match = records.find(predicate);
      if (match) return resolvePromise(match);
      if (Date.now() - started >= timeoutMs) return reject(new Error("Timed out waiting for Pi RPC output"));
      setTimeout(poll, 20);
    };
    poll();
  });
}

function waitForMarker(path, predicate) {
  const started = Date.now();
  return new Promise((resolvePromise, reject) => {
    const poll = () => {
      const match = readMarkers(path).find(predicate);
      if (match) return resolvePromise(match);
      if (Date.now() - started >= 20_000) return reject(new Error("Timed out waiting for compatibility probe"));
      setTimeout(poll, 20);
    };
    poll();
  });
}

function readMarkers(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise((resolvePromise) => child.once("exit", (code, signal) => resolvePromise({ code, signal })));
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return { code: child.exitCode, signal: child.signalCode };
  terminateProcessGroup(child, "SIGTERM");
  const graceful = await waitForExitWithin(child, 5_000);
  if (graceful) return graceful;
  terminateProcessGroup(child, "SIGKILL");
  const forced = await waitForExitWithin(child, 2_000);
  if (!forced) throw new Error("Pi did not exit after SIGKILL");
  return forced;
}

function waitForExitWithin(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return Promise.race([
    waitForExit(child),
    new Promise((resolvePromise) => setTimeout(() => resolvePromise(undefined), timeoutMs)),
  ]);
}

function terminateProcessGroup(child, signal) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function pickExperienceSettings(settings) {
  return Object.fromEntries(
    ["theme", "quietStartup", "hideThinkingBlock"]
      .filter((key) => Object.hasOwn(settings, key))
      .map((key) => [key, settings[key]]),
  );
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
