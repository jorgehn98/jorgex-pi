import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(testDir, "..");

test("Pi 0.84.2 loads the package bootstrap before binding runtime actions and its guard starts fail-closed", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-loader-"));
  try {
    const isolation = {
      home: join(sandbox, "home"),
      agentDir: join(sandbox, "agent"),
      xdgConfig: join(sandbox, "xdg-config"),
      tempRoot: join(sandbox, "pi-subagents-temp"),
      emptyBin: join(sandbox, "empty-bin"),
      engramBin: join(sandbox, process.platform === "win32" ? "fake-engram.exe" : "fake-engram"),
    };
    for (const path of [isolation.home, isolation.agentDir, isolation.xdgConfig, isolation.tempRoot, isolation.emptyBin]) {
      mkdirSync(path, { recursive: true });
    }
    const userSettings = '{"theme":"dark"}\n';
    writeFileSync(join(isolation.agentDir, "settings.json"), userSettings);
    const fakeServer = readFileSync(join(testDir, "fixtures", "fake-engram-mcp.mjs"), "utf8");
    writeFakeEngram(isolation.engramBin, sandbox, fakeServer);
    const env = {
      ...allowedHostEnv(),
      ENGRAM_BIN: isolation.engramBin,
      HOME: isolation.home,
      USERPROFILE: isolation.home,
      PATH: isolation.emptyBin,
      PI_CODING_AGENT_DIR: isolation.agentDir,
      PI_SUBAGENTS_TEMP_ROOT: isolation.tempRoot,
      XDG_CACHE_HOME: join(sandbox, "xdg-cache"),
      XDG_CONFIG_HOME: isolation.xdgConfig,
      XDG_DATA_HOME: join(sandbox, "xdg-data"),
      TEMP: join(sandbox, "temp"),
      TMP: join(sandbox, "temp"),
      TMPDIR: join(sandbox, "temp"),
    };
    mkdirSync(env.TMPDIR, { recursive: true });
    assert.equal(Object.hasOwn(env, "PI_PACKAGE_DIR"), false, "PI_PACKAGE_DIR must remain the Pi binary's read-only package root");
    const output = execFileSync(process.execPath, [join(testDir, "fixtures", "load-bootstrap-with-pi.mjs"), root], {
      cwd: sandbox,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const loaded = JSON.parse(output);
    assert.deepEqual(loaded.errors, [], "the package bootstrap must not call runtime actions during Pi extension loading");
    assert.equal(loaded.extensionCount, 2, "the root package manifest must load the bootstrap and TUI branding extensions");
    assert.deepEqual(loaded.themeNames, ["JorgeX"], "the real Pi loader must load the package's opt-in JorgeX theme");
    assert.deepEqual(loaded.themeDiagnostics, [], "the package theme must load without Pi diagnostics");
    assert.equal(loaded.settingsBytes, userSettings, "loading branding must preserve existing Pi settings byte-for-byte");
    assert.equal(loaded.guard?.block, true, "the real Pi runner must see the JorgeX guard before session health");
    assert.equal(loaded.guard?.terminate, true, "the pre-health guard must terminate the blocked tool batch");
    assert.deepEqual(loaded.engramToolNames, [
      "mem_compare", "mem_context", "mem_current_project", "mem_doctor", "mem_get_observation", "mem_judge", "mem_pin",
      "mem_review", "mem_save", "mem_save_prompt", "mem_search", "mem_session_end", "mem_session_start",
      "mem_session_summary", "mem_suggest_topic_key", "mem_unpin", "mem_update",
    ], "the real Pi runner must register exactly the 17 reviewed direct Engram tools");
    assert.equal(loaded.engramToolNames.includes("mem_capture_passive"), false);
    assert.equal(loaded.realGoal.commandNames.filter((name) => name === "goal").length, 1, "the real packaged companion must register exactly one /goal command");
    assert.equal(loaded.realGoal.commandNames.filter((name) => name === "jorgex:header").length, 1, "the real Pi loader must register the reversible JorgeX header command");
    assert.deepEqual(
      loaded.realGoal.toolNames.filter((name) => name.startsWith("goal_")),
      ["goal_blocked", "goal_complete", "goal_wait"],
      "the real packaged companion must register exactly the reviewed Goal tools",
    );
    assert.ok(loaded.realGoal.sentUserMessageCount >= 1, "starting the real Goal must enqueue its owned continuation without a provider");
    assert.match(loaded.realGoal.prompt, /<goal_id>/i, "the real active Goal must contribute its system prompt");
    assert.match(loaded.realGoal.prompt, /Use Web Access/i, "JorgeX routing must remain in the real prompt chain");
    assert.ok(loaded.realGoal.prompt.indexOf("<goal_id>") < loaded.realGoal.prompt.indexOf("Use Web Access"), "Goal state must precede final JorgeX routing");
    assert.deepEqual(
      loaded.realGoal.managedRunEvents,
      [{ type: "error", runId: "loader-rpc", operation: "start", error: { code: "RPC_DISABLED", message: "Managed run RPC is disabled." } }],
      "the real missing-config default must leave managed-run RPC disabled and responsive",
    );
    assert.deepEqual(loaded.isolation, { ...isolation, path: isolation.emptyBin, piPackageDirConfigured: false });

    const receiptRoot = join(sandbox, "receipt-engram");
    const receiptIsolation = {
      HOME: join(receiptRoot, "home"),
      USERPROFILE: join(receiptRoot, "home"),
      PATH: join(receiptRoot, "empty-bin"),
      PI_CODING_AGENT_DIR: join(receiptRoot, "agent"),
      PI_SUBAGENTS_TEMP_ROOT: join(receiptRoot, "pi-subagents-temp"),
      XDG_CACHE_HOME: join(receiptRoot, "xdg-cache"),
      XDG_CONFIG_HOME: join(receiptRoot, "xdg-config"),
      XDG_DATA_HOME: join(receiptRoot, "xdg-data"),
      TEMP: join(receiptRoot, "temp"),
      TMP: join(receiptRoot, "temp"),
      TMPDIR: join(receiptRoot, "temp"),
    };
    for (const path of Object.values(receiptIsolation)) mkdirSync(path, { recursive: true });
    const receiptBin = join(receiptRoot, process.platform === "win32" ? "engram.exe" : "engram");
    writeFakeEngram(receiptBin, receiptRoot, fakeServer);
    const packageManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    mkdirSync(join(receiptIsolation.HOME, ".jorgex-stack"), { recursive: true });
    writeFileSync(
      join(receiptIsolation.HOME, ".jorgex-stack", "pi-receipt.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        state: "installed",
        candidate: {
          package: { name: "jorgex-pi", version: packageManifest.version, source: `npm:jorgex-pi@${packageManifest.version}` },
          tarball: { bytes: 1, sha256: "a", sha512: "b" },
          provenance: { commit: "reviewed" },
        },
        scope: { kind: "real", codingAgentDir: receiptIsolation.PI_CODING_AGENT_DIR },
        engram: { binary: receiptBin },
      })}\n`,
    );
    const { resolveConfiguredEngramBinary } = await import("../extensions/mcp-engram.ts");
    assert.equal(
      resolveConfiguredEngramBinary({ env: { ...allowedHostEnv(), ...receiptIsolation } }),
      receiptBin,
      "the exact Stack receipt must resolve its native Engram binary before Pi loads",
    );
    const receiptOutput = execFileSync(process.execPath, [join(testDir, "fixtures", "load-bootstrap-with-pi.mjs"), root], {
      cwd: receiptRoot,
      env: { ...allowedHostEnv(), ...receiptIsolation },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const receiptLoaded = JSON.parse(receiptOutput);
    assert.deepEqual(
      receiptLoaded.engramToolNames,
      loaded.engramToolNames,
      "the real Pi loader must register the reviewed Engram tools from the exact Stack receipt without ENGRAM_BIN",
    );

    const missingRoot = join(sandbox, "missing-engram");
    const missingIsolation = {
      HOME: join(missingRoot, "home"),
      USERPROFILE: join(missingRoot, "home"),
      PATH: join(missingRoot, "empty-bin"),
      PI_CODING_AGENT_DIR: join(missingRoot, "agent"),
      PI_SUBAGENTS_TEMP_ROOT: join(missingRoot, "pi-subagents-temp"),
      XDG_CACHE_HOME: join(missingRoot, "xdg-cache"),
      XDG_CONFIG_HOME: join(missingRoot, "xdg-config"),
      XDG_DATA_HOME: join(missingRoot, "xdg-data"),
      TEMP: join(missingRoot, "temp"),
      TMP: join(missingRoot, "temp"),
      TMPDIR: join(missingRoot, "temp"),
    };
    for (const path of Object.values(missingIsolation)) mkdirSync(path, { recursive: true });
    const missingOutput = execFileSync(process.execPath, [join(testDir, "fixtures", "load-bootstrap-with-pi.mjs"), root], {
      cwd: missingRoot,
      env: { ...allowedHostEnv(), ...missingIsolation },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const missing = JSON.parse(missingOutput);
    assert.deepEqual(missing.engramToolNames, [], "missing Engram must not expose memory tools");
    assert.equal(missing.realGoal.toolNames.includes("mcp"), false, "missing Engram must not register the generic MCP proxy");
    assert.equal(missing.realGoal.toolNames.includes("mcpScript"), false, "missing Engram must not register the generic MCP script tool");
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

function allowedHostEnv() {
  const allowed = {};
  for (const key of ["PATHEXT", "SYSTEMROOT", "SystemRoot", "COMSPEC", "ComSpec", "WINDIR", "windir"]) {
    if (process.env[key] !== undefined) allowed[key] = process.env[key];
  }
  return allowed;
}

function writeFakeEngram(binary, cwd, fakeServer) {
  if (process.platform === "win32") {
    copyFileSync(process.execPath, binary);
    writeFileSync(join(cwd, "mcp"), fakeServer);
    return;
  }
  writeFileSync(binary, `#!${process.execPath}\n${fakeServer}`);
  chmodSync(binary, 0o755);
}
