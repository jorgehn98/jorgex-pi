import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveMcpEngramConfig } from "../extensions/mcp-engram.ts";

// T70 first vertical tracer — Pi-native reader/config without the legacy adapter.
//
// T69 observed on the published Pi 0.99.1 sample that the builtin MCP support
// reads `mcp.json` (strict JSON) as the authority for the Engram server, and
// that `gentle-engram@0.1.16` provides its 22 mem_* tools by HTTP without
// `pi-mcp-adapter`. Requiring the adapter here would report a working native
// install as missing, which is the regression this tracer protects.
//
// The native server entry carries only native fields (`command`, `args`,
// `exposure`); `lifecycle`/`directTools` are adapter-only and must not be
// required for the native path.
const OFFICIAL_ARGS = ["mcp", "--tools=agent"];

function nativeSandbox(t, { packages, mcpJson }) {
  const root = mkdtempSync(join(tmpdir(), "jorgex-pi-native-reader-"));
  // Owned temporary tree: register the runner-hook teardown immediately after
  // the owned mkdtemp and before any other IO, so a failure while the fixture is
  // being built still cleans up on success, failure and cancellation.
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify({ packages }, null, 2)}\n`);
  writeFileSync(join(agentDir, "mcp.json"), mcpJson);
  const env = { HOME: root, PI_CODING_AGENT_DIR: agentDir, XDG_CONFIG_HOME: join(root, "xdg") };
  return {
    root,
    resolve: (resolveEngramBinary = () => process.execPath) =>
      resolveMcpEngramConfig({
        resolveEngramBinary,
        env,
        platform: "linux",
        cwd: root,
      }),
  };
}

function nativeConfig() {
  return `${JSON.stringify(
    { mcpServers: { engram: { command: process.execPath, args: OFFICIAL_ARGS, exposure: "deferred" } } },
    null,
    2,
  )}\n`;
}

test("native mcp.json is the Engram authority and an installed adapter is not required", async (t) => {
  const sandbox = nativeSandbox(t, { packages: ["npm:gentle-engram@0.1.16"], mcpJson: nativeConfig() });
  try {
    const result = await sandbox.resolve();
    // Expected fail reason before implementation (T71): state === "missing",
    // reason "official Engram MCP setup is missing; run `engram setup pi`" —
    // caused only by the absent pi-mcp-adapter entry.
    assert.notEqual(
      result.state,
      "missing",
      `a native install (mcp.json + one gentle-engram, no adapter) must not be reported as missing: ${result.reason ?? ""}`,
    );
    assert.notEqual(
      result.state,
      "failed",
      `a valid native mcp.json must not fail closed: ${result.reason ?? ""}`,
    );
    assert.ok(result.config.mcpServers.engram, "the Engram server must be resolved from mcp.json");
    assert.equal(
      result.config.mcpServers.engram.command,
      process.execPath,
      "mcp.json is the authority for the Engram command",
    );
    assert.deepEqual(
      result.config.mcpServers.engram.args,
      OFFICIAL_ARGS,
      "the official Engram arguments from mcp.json reach the resolved server",
    );
  } finally {
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});

test("native reader still fails closed on duplicate gentle entries and non-strict mcp.json", async (t) => {
  const strict = JSON.stringify({
    mcpServers: { engram: { command: process.execPath, args: OFFICIAL_ARGS, exposure: "deferred" } },
  });
  const duplicate = nativeSandbox(t, {
    packages: ["npm:gentle-engram@0.1.16", "npm:gentle-engram@0.1.15"],
    mcpJson: nativeConfig(),
  });
  // Pi's native parser is strict JSON: a trailing comma is not a valid authority.
  const jsonc = nativeSandbox(t, {
    packages: ["npm:gentle-engram@0.1.16"],
    mcpJson: `${strict.slice(0, -1)},\n}\n`,
  });
  try {
    const duplicated = await duplicate.resolve();
    assert.notEqual(duplicated.state, "managed", "duplicate gentle-engram entries must not resolve healthy");
    assert.equal(
      duplicated.config.mcpServers.engram,
      undefined,
      "a duplicate gentle-engram singleton must not expose the Engram server",
    );

    const nonStrict = await jsonc.resolve();
    assert.notEqual(nonStrict.state, "managed", "a non-strict mcp.json must not resolve healthy");
    assert.equal(
      nonStrict.config.mcpServers.engram,
      undefined,
      "JSONC is not the native authority; a trailing comma must not expose the Engram server",
    );
  } finally {
    rmSync(duplicate.root, { recursive: true, force: true });
    rmSync(jsonc.root, { recursive: true, force: true });
  }
});

// T71 obligation (Spec 71, "Primer tracer vertical: lector nativo"): the native
// reader must preserve the explicit Engram binary precedence the legacy adapter
// path already enforces. A persisted `mcp.json` command that disagrees with the
// injected explicit resolver fails closed for the same security reason, and the
// resolver must actually be consulted instead of being silently ignored.
const PRECEDENCE_REASON = /does not match the configured Engram binary|explicit configuration takes precedence/i;

test("native reader preserves explicit Engram binary precedence over the persisted command", async (t) => {
  const sandbox = nativeSandbox(t, { packages: ["npm:gentle-engram@0.1.16"], mcpJson: nativeConfig() });
  // A real executable fixture, so the expected failure cannot be a shape error.
  const explicitBinary = join(sandbox.root, "explicit-engram");
  writeFileSync(explicitBinary, "fake binary; never execute\n");
  chmodSync(explicitBinary, 0o755);
  let resolverCalls = 0;
  try {
    const result = await sandbox.resolve(() => {
      resolverCalls += 1;
      return explicitBinary;
    });
    assert.equal(
      result.state,
      "failed",
      `a persisted Engram command that disagrees with the explicit binary must fail closed, got ${result.state}: ${result.reason ?? ""}`,
    );
    assert.equal(
      result.config.mcpServers.engram,
      undefined,
      "the persisted Engram server must not be accepted when the explicit binary takes precedence",
    );
    assert.match(
      result.reason ?? "",
      PRECEDENCE_REASON,
      "the failure must be the security command-mismatch contract, not an unrelated reader/shape error",
    );
    assert.equal(resolverCalls, 1, "the native path must consult the explicit resolver (no unused injection)");
  } finally {
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});
