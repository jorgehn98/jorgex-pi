import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(testDir, "..");
const probePath = join(testDir, "fixtures", "probe-engram-child.mjs");

test("engram child ships no package-local shim in the installed copy", () => {
  const sandbox = setupSandbox();
  try {
    const probed = runProbe(sandbox);
    assert.equal(probed.worktree.shimExists, false, "extensions/engram-child.ts must not exist; gentle-engram loads ambiently");
    assert.equal(probed.installed.shimExists, false, "installed package copy must not ship the shim");
    assert.equal(probed.worktree.agentReferencesShim, false, "engram agent must not reference a package-local shim");
    assert.equal(probed.installed.agentReferencesShim, false, "installed agent copy must not reference the shim");
    assert.deepEqual(probed.worktree.contractSubagentOnlyExtensions, [], "generated contract must not require the shim");
    assert.equal(probed.worktree.generatorReferencesShim, false, "generator must not reintroduce the shim");
  } finally {
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});

test("engram child sets no MCP_DIRECT_TOOLS and loads no JorgeX selector in isolation", () => {
  const sandbox = setupSandbox();
  try {
    const probed = runProbe(sandbox);
    assert.equal(probed.isolation.hasMcpDirectTools, false, "child must not establish MCP_DIRECT_TOOLS");
    assert.equal(probed.isolation.hasSubagentMcpDirectTools, false, "child must not carry a JorgeX MCP direct-tools selector");
    assert.deepEqual(probed.worktree.extensionsWithSelector, [], "no extension may carry ENGRAM_CHILD_ALLOWED_TOOLS");
    assert.deepEqual(probed.worktree.extensionsWithDirectToolsWiring, [], "no extension may wire MCP_DIRECT_TOOLS for the child");
    assert.equal(probed.worktree.agentHasToolsLine, false, "engram agent must omit tools so ambient gentle-engram loads; empty tools: would emit --no-tools");
    assert.equal(probed.worktree.contractHasTools, false, "contract must omit engram tools; empty tools: [] would emit --no-tools");
    assert.equal(probed.worktree.contractHasSubagentOnlyExtensions, false, "contract must not require a package-local shim");
    assert.equal(probed.worktree.contractMaxSubagentDepth, 0, "general subdelegation restriction remains");
  } finally {
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});

test("engram child probe stays isolated without network or real HOME", () => {
  const sandbox = setupSandbox();
  try {
    const probed = runProbe(sandbox);
    assert.equal(probed.isolation.piPackageDirConfigured, false, "PI_PACKAGE_DIR must remain the Pi binary read-only root");
    assert.ok(probed.isolation.home.startsWith(sandbox.root), "probe must run under isolated HOME");
    assert.ok(probed.isolation.agentDir.startsWith(sandbox.root), "probe must run under isolated PI_CODING_AGENT_DIR");
    assert.equal(probed.isolation.path, sandbox.emptyBin, "probe must run with an isolated empty PATH");
    for (const [label, value] of [
      ["XDG_CACHE_HOME", probed.isolation.xdgCache],
      ["XDG_CONFIG_HOME", probed.isolation.xdgConfig],
      ["XDG_DATA_HOME", probed.isolation.xdgData],
      ["TEMP", probed.isolation.temp],
      ["TMP", probed.isolation.tmp],
      ["TMPDIR", probed.isolation.tmpdir],
      ["PI_SUBAGENTS_TEMP_ROOT", probed.isolation.subagentsTemp],
    ]) {
      assert.ok((value ?? "").startsWith(sandbox.root), `${label} must stay under the isolated sandbox`);
    }
    assert.equal(probed.fetchCount, 0, "probe must not use the network");
  } finally {
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});

function setupSandbox() {
  const sandboxRoot = mkdtempSync(join(tmpdir(), "jorgex-pi-engram-child-"));
  const agentDir = join(sandboxRoot, "agent");
  const installedPackage = join(agentDir, "npm", "node_modules", "jorgex-pi");
  const emptyBin = join(sandboxRoot, "empty-bin");
  const tempRoot = join(sandboxRoot, "pi-subagents-temp");
  mkdirSync(installedPackage, { recursive: true });
  mkdirSync(emptyBin, { recursive: true });
  mkdirSync(tempRoot, { recursive: true });
  cpSync(join(root, "package.json"), join(installedPackage, "package.json"));
  cpSync(join(root, "agents"), join(installedPackage, "agents"), { recursive: true });
  cpSync(join(root, "extensions"), join(installedPackage, "extensions"), { recursive: true });
  cpSync(join(root, "skills"), join(installedPackage, "skills"), { recursive: true });

  const env = {
    ...allowedHostEnv(),
    HOME: join(sandboxRoot, "home"),
    USERPROFILE: join(sandboxRoot, "home"),
    PATH: emptyBin,
    PI_CODING_AGENT_DIR: agentDir,
    PI_SUBAGENTS_TEMP_ROOT: tempRoot,
    PI_SUBAGENT_CHILD_AGENT: "engram",
    XDG_CACHE_HOME: join(sandboxRoot, "xdg-cache"),
    XDG_CONFIG_HOME: join(sandboxRoot, "xdg-config"),
    XDG_DATA_HOME: join(sandboxRoot, "xdg-data"),
    TEMP: join(sandboxRoot, "temp"),
    TMP: join(sandboxRoot, "temp"),
    TMPDIR: join(sandboxRoot, "temp"),
  };
  for (const path of [env.HOME, env.XDG_CACHE_HOME, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.TEMP]) {
    mkdirSync(path, { recursive: true });
  }

  return { root: sandboxRoot, agentDir, emptyBin, env };
}

function runProbe(sandbox) {
  const output = execFileSync(process.execPath, [probePath], {
    cwd: sandbox.root,
    env: sandbox.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const probed = JSON.parse(output);
  if (probed.fatal) throw new Error(`probe failed: ${probed.fatal.message}`);
  return probed;
}

function allowedHostEnv() {
  const allowed = {};
  for (const key of ["PATHEXT", "SYSTEMROOT", "SystemRoot", "COMSPEC", "ComSpec", "WINDIR", "windir"]) {
    if (process.env[key] !== undefined) allowed[key] = process.env[key];
  }
  return allowed;
}
