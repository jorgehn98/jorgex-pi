// T71 invariant: the readonly ownership checker's public contract takes
// `projectTrusted`, and a trusted project override of a protected server is
// EFFECTIVE. Spec 71 ("Proof offline y bind del checker", plus the bootstrap
// clause that a trusted protected override the reader cannot validate blocks a
// valid-configuration claim): the effective server is `conflict`, and the
// global granular claim must NOT transfer to the project replacement (so it is
// never `managed`/cleanup-eligible). The same `.pi/mcp.json` must stay inert
// when the project is not trusted, leaving the global managed baseline intact.
//
// The checker is loaded from the ACTIVE managed entry (never the checkout) and
// no package-root parameter exists, so only the public
// `inspectNativeMcpOwnership({ env, platform, cwd, projectTrusted })` output is
// asserted. The fixture is a fully coherent OFFLINE synthetic release; the
// project override is a distinct, non-sensitive URL. The checker is readonly:
// the whole fixture tree (global config, receipts and the project file) must be
// byte-identical after the call.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { createManagedReleaseSandbox, snapshotTree } from "./fixtures/native-managed-release.mjs";

const PROJECT_OVERRIDE_URL = "https://example.invalid/mcp";

// A project source carrying a protected `context7` definition distinct from the
// global managed one. Same native host API key (`mcpServers`); strict JSON.
function writeProjectOverride(sandbox) {
  const configPath = join(sandbox.root, ".pi", "mcp.json");
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(
    configPath,
    `${JSON.stringify({ mcpServers: { context7: { url: PROJECT_OVERRIDE_URL } } }, null, 2)}\n`,
  );
  return configPath;
}

async function inspectFromActiveRoot(sandbox, projectTrusted) {
  const mcpModule = await import(pathToFileURL(sandbox.entryModulePath).href);
  assert.equal(
    typeof mcpModule.inspectNativeMcpOwnership,
    "function",
    "the active managed entry must expose the readonly checker",
  );
  return mcpModule.inspectNativeMcpOwnership({
    env: sandbox.env,
    platform: process.platform,
    cwd: sandbox.root,
    projectTrusted,
  });
}

test("a trusted project override substitutes the protected context7 server as conflict", async (t) => {
  const sandbox = createManagedReleaseSandbox(t);
  writeProjectOverride(sandbox);
  const before = snapshotTree(sandbox.root);

  const result = await inspectFromActiveRoot(sandbox, true);

  assert.equal(
    result.package?.state,
    "verified",
    `the project override must not disturb the managed package proof: ${result.package?.reason ?? "no diagnostic"}`,
  );
  assert.equal(
    result.servers?.context7?.state,
    "conflict",
    `a trusted project override must be effective and conflict, never owned by the global claim: ${result.servers?.context7?.reason ?? "no diagnostic"}`,
  );
  assert.equal(
    result.servers?.context7?.cleanupEligible,
    false,
    "the global raw protected claim must not own the project replacement",
  );
  assert.equal(result.connection, "not-verified", "the checker never claims a live connection");
  assert.deepEqual(snapshotTree(sandbox.root), before, "the readonly checker must not write any file");
});

test("the same project override stays inert when the project is not trusted", async (t) => {
  const sandbox = createManagedReleaseSandbox(t);
  writeProjectOverride(sandbox);
  const before = snapshotTree(sandbox.root);

  const result = await inspectFromActiveRoot(sandbox, false);

  assert.equal(
    result.package?.state,
    "verified",
    `an untrusted project override must not disturb the managed package proof: ${result.package?.reason ?? "no diagnostic"}`,
  );
  assert.equal(
    result.servers?.context7?.state,
    "managed",
    `an untrusted project override must be ignored as effective: ${result.servers?.context7?.reason ?? "no diagnostic"}`,
  );
  assert.equal(result.servers?.context7?.cleanupEligible, true, "the global managed baseline stays cleanup-eligible");
  assert.equal(result.servers?.context7?.availability, "configured", "availability is syntax only, never a connection claim");
  assert.equal(result.connection, "not-verified", "the checker never claims a live connection");
  assert.deepEqual(snapshotTree(sandbox.root), before, "the readonly checker must not write any file");
});
