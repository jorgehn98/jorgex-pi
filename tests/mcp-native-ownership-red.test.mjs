import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { CONTEXT7_URL } from "../extensions/mcp-engram.ts";

// Direct-channel ownership: native `mcp.json` without granular authority.
//
// The planned readonly checker is `inspectNativeMcpOwnership({ env, platform,
// cwd, projectTrusted })`, async, exported from `extensions/native-mcp.mjs`,
// with no public package-root parameter. Its result is indexed by the three
// managed names, each with `state` (absent/unowned/conflict/managed),
// `cleanupEligible` and `availability` (unavailable/configured/disabled/
// unsupported-execution), plus `package.state` (not-required/verified/conflict)
// and `connection` (always not-verified).
//
// This direct-channel case covers only unclaimed state: a valid native `mcp.json`
// without any granular claim and without Stack receipts. Ownership is authority,
// never shape, so both present servers are unowned, DevTools is absent, the
// package proof is not required and no connection is claimed. The heavy
// package/tamper proof and the imported-checkout case are separate cases below.
//
// The checker is read-only: the whole fixture tree must be byte-identical after
// the call. Nothing is spawned (no Engram server, no process) and no real HOME,
// credential or network is involved.
const MODULE = "../extensions/native-mcp.mjs";
const SERVER_NAMES = ["engram", "context7", "chrome-devtools"];
const OWNERSHIP_STATES = ["absent", "unowned", "conflict", "managed"];
const AVAILABILITY_STATES = ["unavailable", "configured", "disabled", "unsupported-execution"];

// The checker module is required for this contract; a missing module fails
// the contract assertion in each test instead of crashing the import.
async function loadOwnershipChecker() {
  try {
    return await import(MODULE);
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND" || error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function nativeServers() {
  return {
    engram: { command: process.execPath, args: ["mcp", "--tools=agent"], exposure: "deferred" },
    context7: { url: CONTEXT7_URL },
  };
}

function createNativeOwnershipSandbox(t, { mcpJson } = {}) {
  const root = mkdtempSync(join(tmpdir(), "jorgex-pi-native-ownership-"));
  // Owned temporary tree: the runner-hook teardown is registered immediately
  // after the owned mkdtemp and before any other IO, so it runs on success,
  // failure and a setup failure alike.
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const home = join(root, "home");
  const projectDir = join(root, "project");
  for (const directory of [agentDir, home, projectDir]) mkdirSync(directory, { recursive: true });
  // Native transport: one global gentle-engram and no adapter declaration, no
  // granular claim and no Stack receipt anywhere.
  writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify({ packages: ["npm:gentle-engram@0.1.16"] }, null, 2)}\n`);
  writeFileSync(join(agentDir, "mcp.json"), mcpJson ?? `${JSON.stringify({ mcpServers: nativeServers() }, null, 2)}\n`);
  return {
    root,
    agentDir,
    home,
    projectDir,
    env: { HOME: home, PI_CODING_AGENT_DIR: agentDir, XDG_CONFIG_HOME: join(root, "xdg") },
  };
}

// Files and contents of the whole fixture tree, so any write by the checker is
// observable.
function snapshotTree(root) {
  const files = {};
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = join(directory, entry.name);
      if (entry.isDirectory()) walk(target);
      else files[relative(root, target)] = readFileSync(target, "utf8");
    }
  };
  walk(root);
  return files;
}

function assertServerShape(servers) {
  assert.deepEqual(Object.keys(servers).sort(), [...SERVER_NAMES].sort(), "the checker must report all three managed names");
  for (const [name, server] of Object.entries(servers)) {
    assert.ok(
      OWNERSHIP_STATES.includes(server.state),
      `${name}.state must be one of ${OWNERSHIP_STATES.join("/")}, got ${server.state}`,
    );
    assert.equal(typeof server.cleanupEligible, "boolean", `${name}.cleanupEligible must be a boolean`);
    assert.ok(
      AVAILABILITY_STATES.includes(server.availability),
      `${name}.availability must be one of ${AVAILABILITY_STATES.join("/")}, got ${server.availability}`,
    );
  }
}

test("the direct native channel without granular authority reports unowned servers and no package proof", async (t) => {
  const module = await loadOwnershipChecker();
  assert.equal(
    typeof module?.inspectNativeMcpOwnership,
    "function",
    "extensions/native-mcp.mjs must export the readonly inspectNativeMcpOwnership({ env, platform, cwd, projectTrusted })",
  );

  const sandbox = createNativeOwnershipSandbox(t);
  const before = snapshotTree(sandbox.root);

  const pending = module.inspectNativeMcpOwnership({
    env: sandbox.env,
    platform: "linux",
    cwd: sandbox.projectDir,
    projectTrusted: false,
  });
  assert.equal(typeof pending?.then, "function", "the readonly checker must be async and return a Promise");
  const result = await pending;

  assert.equal(typeof result, "object", "the checker must resolve a readonly result");
  assertServerShape(result.servers);

  // A valid, present definition without any granular claim stays unowned: the
  // direct channel needs no Stack receipt and ownership is never inferred from
  // shape.
  assert.equal(result.servers.engram.state, "unowned", "a valid engram definition without a claim is unowned");
  assert.equal(result.servers.engram.cleanupEligible, false, "an unowned entry is never cleanup-eligible");
  assert.equal(result.servers.engram.availability, "configured", "availability is syntax only, never a connection claim");
  assert.equal(result.servers.context7.state, "unowned", "the canonical context7 url without a claim is unowned");
  assert.equal(result.servers.context7.cleanupEligible, false, "an unowned entry is never cleanup-eligible");
  assert.equal(result.servers.context7.availability, "configured", "a present url is configured syntax only");
  assert.equal(result.servers["chrome-devtools"].state, "absent", "without a handoff DevTools is absent");
  assert.equal(result.servers["chrome-devtools"].cleanupEligible, false, "an absent entry is never cleanup-eligible");
  assert.equal(result.servers["chrome-devtools"].availability, "unavailable", "an absent entry is unavailable");

  // No granular authority means no heavy package proof is performed, and a
  // static check never claims a live connection.
  assert.equal(result.package.state, "not-required", "without granular authority the package proof is not required");
  assert.equal(result.connection, "not-verified", "the checker never claims a live connection");

  assert.deepEqual(snapshotTree(sandbox.root), before, "the readonly checker must not write any file");
});

test("an invalid strict mcp.json never becomes a silent managed success", async (t) => {
  const module = await loadOwnershipChecker();
  assert.equal(
    typeof module?.inspectNativeMcpOwnership,
    "function",
    "the readonly checker export is required before the invalid-config control can be asserted",
  );

  // Strict JSON is Pi's native authority: a trailing comma is invalid.
  const strict = JSON.stringify({ mcpServers: nativeServers() });
  const sandbox = createNativeOwnershipSandbox(t, { mcpJson: `${strict.slice(0, -1)},\n}\n` });
  const before = snapshotTree(sandbox.root);

  let result;
  try {
    result = await module.inspectNativeMcpOwnership({
      env: sandbox.env,
      platform: "linux",
      cwd: sandbox.projectDir,
      projectTrusted: false,
    });
  } catch {
    // An explicit rejection is acceptable; a silent managed claim is not.
    result = undefined;
  }
  if (result) {
    assert.notEqual(
      result.servers?.engram?.state,
      "managed",
      "an invalid strict mcp.json must not report a managed engram server",
    );
    assert.notEqual(result.package?.state, "verified", "no package proof may be claimed from an invalid configuration");
    assert.equal(result.connection, "not-verified", "the checker never claims a live connection");
  }

  assert.deepEqual(snapshotTree(sandbox.root), before, "the readonly checker must not write any file");
});
