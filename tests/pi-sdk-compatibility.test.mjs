import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const testDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(testDir, "..");
const engramExpected = readJson(join(testDir, "fixtures", "mcp-engram.expected.json"));
const configuredPi = process.env.JORGEX_PI_BIN?.trim();
const configuredPackage = process.env.JORGEX_PI_PACKAGE_DIR?.trim() || root;
const skipReason = configuredPi && configuredPackage
  ? false
  : "requires JORGEX_PI_BIN for the real Pi 0.85.1 smoke; set JORGEX_PI_PACKAGE_DIR to use an extracted published package";

test("Pi 0.85.1 loads the published JorgeX package and exposes its real RPC contract", { skip: skipReason }, async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-085-compat-"));
  const home = join(sandbox, "home");
  const agentDir = join(sandbox, "agent");
  const cwd = join(sandbox, "workspace");
  const xdgConfig = join(sandbox, "xdg-config");
  const xdgCache = join(sandbox, "xdg-cache");
  const xdgData = join(sandbox, "xdg-data");
  const tempDir = join(sandbox, "temp");
  const markers = join(sandbox, "markers.jsonl");
  const fakeEngram = join(sandbox, process.platform === "win32" ? "engram.exe" : "engram");
  const probe = join(testDir, "fixtures", "pi-sdk-compatibility-probe.mjs");

  for (const path of [home, agentDir, cwd, xdgConfig, xdgCache, xdgData, tempDir]) {
    mkdirSync(path, { recursive: true });
  }

  try {
    assert.ok(existsSync(configuredPi), `configured Pi binary must exist: ${configuredPi}`);
    assert.ok(existsSync(configuredPackage), `configured JorgeX package must exist: ${configuredPackage}`);
    const packageManifest = readJson(join(configuredPackage, "package.json"));
    assert.equal(packageManifest.name, "jorgex-pi", "the real smoke must load the JorgeX Pi package");
    const rootContract = readJson(join(root, "contract", "jorgex-pi.v1.json"));
    assert.equal(packageManifest.version, rootContract.package?.version, "the smoke package must match the root contract version");
    assert.equal(readPiVersion(configuredPi, isolatedEnv({ home, agentDir, cwd, xdgConfig, xdgCache, xdgData, tempDir })), "0.85.1");

    const fakeServer = readFileSync(join(testDir, "fixtures", "fake-engram-mcp.mjs"), "utf8");
    writeFileSync(fakeEngram, `#!${process.execPath}\n${fakeServer}`);
    if (process.platform !== "win32") {
      chmodSync(fakeEngram, 0o755);
    } else {
      copyFileSync(process.execPath, fakeEngram);
      writeFileSync(join(sandbox, "mcp"), fakeServer);
    }

    writeJson(join(agentDir, "settings.json"), {
      packages: [configuredPackage],
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
      assert.equal(state.success, true, `Pi 0.85.1 get_state failed: ${stderr}`);
      assert.equal(state.command, "get_state");
      assert.equal(typeof state.data.sessionId, "string");
      assert.equal(state.data.isStreaming, false);

      const commandsResponse = await requestRpc(child, records, "get_commands");
      assert.equal(commandsResponse.success, true, `Pi 0.85.1 get_commands failed: ${stderr}`);
      const commands = commandsResponse.data.commands;
      const commandNames = commands.map((command) => command.name);
      assert.equal(new Set(commandNames).size, commandNames.length, "Pi must not duplicate slash commands across loaded companions");
      assert.ok(commandNames.length >= 45, "the current JorgeX package must expose at least the reviewed 45-command surface");
      for (const name of [
        "jx-compat-probe", "permission-system", "subagents", "goal", "mcp", "pi-mcp", "mcp-auth",
        "jorgex:header", "websearch", "curator", "google-account", "search", "lean-audit",
      ]) {
        assert.ok(commandNames.includes(name), `Pi 0.85.1 must expose command ${name}`);
      }
      assert.ok(commands.every((command) => ["extension", "prompt", "skill"].includes(command.source)));

      const promptResponse = await requestRpc(child, records, "prompt", { message: "/jx-compat-probe" });
      assert.equal(promptResponse.success, true, `Pi 0.85.1 extension prompt failed: ${stderr}`);
      const probeRecord = await waitForMarker(markers, (entry) => entry.event === "probe");
      assert.ok(probeRecord.activeTools.includes("bash"), "the probe must read active tools through Pi 0.85.1");
      for (const name of [
        "ask_user_question", "subagent", "subagent_wait", "web_search", "fetch_content",
        "goal_blocked", "goal_complete", "goal_wait",
      ]) {
        assert.ok(probeRecord.allTools.includes(name), `Pi 0.85.1 must load companion tool ${name}`);
      }
      const actualEngramTools = probeRecord.allTools.filter((name) => name.startsWith("mem_")).sort();
      assert.deepEqual(actualEngramTools, engramExpected.engramProfile.tools.slice().sort(), "Pi must register the complete reviewed Engram tool set");
      assert.equal(actualEngramTools.includes("mem_capture_passive"), false, "Pi must keep the passive Engram capture tool excluded");
      assert.deepEqual(probeRecord.commands.sort(), commandNames.slice().sort(), "get_commands and the extension API must agree");

      const exit = await stopProcess(child);
      if (process.platform === "win32") {
        assert.ok(exit.code === 1 || exit.signal === "SIGTERM", `unexpected Pi shutdown; stderr: ${stderr}`);
      } else {
        assert.equal(exit.code, 143, `unexpected Pi shutdown; stderr: ${stderr}`);
      }
      const lifecycle = readMarkers(markers).map((entry) => entry.event);
      assert.ok(lifecycle.includes("session_start"), "Pi must emit session_start before serving RPC");
      assert.ok(lifecycle.includes("session_shutdown"), "Pi 0.85.1 must run session_shutdown during SIGTERM teardown");
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

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
