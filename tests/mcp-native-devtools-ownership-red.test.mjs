// T70 DevTools ownership chain: the missing boundary between a matching
// `definitionSha256` and real trusted ownership.
//
// The inspector currently accepts ANY claimed stdio definition whose protected
// digest matches. Spec 71 L33 requires more for DevTools: the projection receipt
// must stamp the WHOLE handoff file (`devtools.sha256`) and the persisted
// command/args must equal the trusted v3 resolution of that handoff, so a plain
// launcher or an arbitrary script can never become `managed` even with a
// matching definition digest. The package proof stays the same root proof and is
// unaffected: projection and config live outside the release closure.
//
// Fixtures are local and coherent only: no Chromium, no browser tree, no MCP
// connection, no credentials, and no process is ever spawned.
import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { digestNativeMcpDefinition } from "../extensions/mcp-engram.mjs";
import { createManagedReleaseSandbox, snapshotTree } from "./fixtures/native-managed-release.mjs";
import { installDevtoolsChain, writeDevtoolsOwnership } from "./fixtures/native-devtools-ownership.mjs";

const WRONG_HANDOFF_SHA256 = "0".repeat(64);
const CHECKOUT = new URL("../extensions/native-mcp.mjs", import.meta.url).href;

async function inspectFromManagedEntry(sandbox) {
  const mcpModule = await import(pathToFileURL(sandbox.entryModulePath).href);
  return mcpModule.inspectNativeMcpOwnership({
    env: sandbox.env,
    platform: process.platform,
    cwd: sandbox.root,
    projectTrusted: sandbox.projectTrusted,
  });
}

test("DevTools ownership requires the whole-handoff receipt stamp and the trusted guard", async (t) => {
  await t.test("a coherent handoff stamp with the trusted guard stays managed", async (sub) => {
    const sandbox = createManagedReleaseSandbox(sub);
    const chain = installDevtoolsChain(sandbox, sub);
    writeDevtoolsOwnership(sandbox, {
      entry: chain.trustedDefinition,
      definitionSha256: chain.trustedDefinitionSha256,
      devtools: { sha256: chain.handoffSha256 },
    });
    const before = snapshotTree(sandbox.root);

    const result = await inspectFromManagedEntry(sandbox);

    assert.equal(
      result.package?.state,
      "verified",
      `the root package proof is independent of the projection: ${result.package?.reason ?? "no diagnostic"}`,
    );
    assert.equal(
      result.servers?.["chrome-devtools"]?.state,
      "managed",
      `the trusted guard with the whole-handoff stamp is owned: ${result.servers?.["chrome-devtools"]?.reason ?? "no diagnostic"}`,
    );
    assert.equal(result.connection, "not-verified", "the checker never claims a live connection");
    assert.deepEqual(snapshotTree(sandbox.root), before, "the readonly checker must not write any file");
  });

  await t.test("a wrong whole-handoff stamp is conflict even with a matching definition digest", async (sub) => {
    const sandbox = createManagedReleaseSandbox(sub);
    const chain = installDevtoolsChain(sandbox, sub);
    writeDevtoolsOwnership(sandbox, {
      entry: chain.trustedDefinition,
      definitionSha256: chain.trustedDefinitionSha256,
      devtools: { sha256: WRONG_HANDOFF_SHA256 },
    });
    const before = snapshotTree(sandbox.root);

    const result = await inspectFromManagedEntry(sandbox);
    const server = result.servers?.["chrome-devtools"];
    assert.equal(result.package?.state, "verified", "the root package proof stays verified");
    assert.equal(
      server?.state,
      "conflict",
      `a handoff stamp that does not match the file cannot own the entry: ${server?.reason ?? "no diagnostic"}`,
    );
    assert.equal(
      String(server?.reason ?? "").includes(WRONG_HANDOFF_SHA256),
      false,
      "a diagnostic must never echo receipt digest content",
    );
    assert.deepEqual(snapshotTree(sandbox.root), before, "the readonly checker must not write any file");
  });

  await t.test("a missing whole-handoff stamp is conflict, never a silent managed", async (sub) => {
    const sandbox = createManagedReleaseSandbox(sub);
    const chain = installDevtoolsChain(sandbox, sub);
    writeDevtoolsOwnership(sandbox, {
      entry: chain.trustedDefinition,
      definitionSha256: chain.trustedDefinitionSha256,
      devtools: undefined,
    });
    const before = snapshotTree(sandbox.root);

    const result = await inspectFromManagedEntry(sandbox);
    assert.equal(result.package?.state, "verified", "the root package proof stays verified");
    assert.equal(
      result.servers?.["chrome-devtools"]?.state,
      "conflict",
      `without the handoff stamp the chain is incomplete: ${result.servers?.["chrome-devtools"]?.reason ?? "no diagnostic"}`,
    );
    assert.deepEqual(snapshotTree(sandbox.root), before, "the readonly checker must not write any file");
  });

  await t.test("a plain launcher with its own matching digest is conflict, not the trusted guard", async (sub) => {
    const sandbox = createManagedReleaseSandbox(sub);
    const chain = installDevtoolsChain(sandbox, sub);
    writeDevtoolsOwnership(sandbox, {
      entry: chain.plainLauncher,
      definitionSha256: digestNativeMcpDefinition("chrome-devtools", chain.plainLauncher),
      devtools: { sha256: chain.handoffSha256 },
    });
    const before = snapshotTree(sandbox.root);

    const result = await inspectFromManagedEntry(sandbox);
    const server = result.servers?.["chrome-devtools"];
    assert.equal(result.package?.state, "verified", "the root package proof stays verified");
    assert.equal(
      server?.state,
      "conflict",
      `a script that is not the trusted v3 guard cannot be owned by digest alone: ${server?.reason ?? "no diagnostic"}`,
    );
    assert.equal(
      String(server?.reason ?? "").includes(chain.plainLauncher.args[0]),
      false,
      "a diagnostic must never echo persisted user command content",
    );
    assert.deepEqual(snapshotTree(sandbox.root), before, "the readonly checker must not write any file");
  });
});

// The historical checkout control stays: the same coherent DevTools chain cannot
// be certified from an imported checkout, which keeps the physical root bind
// meaningful for this new surface too.
test("the DevTools chain stays conflict when the checker runs from the imported checkout", async (t) => {
  const sandbox = createManagedReleaseSandbox(t);
  const chain = installDevtoolsChain(sandbox, t);
  writeDevtoolsOwnership(sandbox, {
    entry: chain.trustedDefinition,
    definitionSha256: chain.trustedDefinitionSha256,
    devtools: { sha256: chain.handoffSha256 },
  });
  const before = snapshotTree(sandbox.root);

  const checkoutModule = await import(CHECKOUT);
  const result = await checkoutModule.inspectNativeMcpOwnership({
    env: sandbox.env,
    platform: process.platform,
    cwd: sandbox.root,
    projectTrusted: sandbox.projectTrusted,
  });

  assert.notEqual(result.package?.state, "verified", "an imported checkout cannot certify another installation");
  assert.equal(result.servers?.["chrome-devtools"]?.state, "conflict", "the claim stays conflict from a checkout");
  assert.deepEqual(snapshotTree(sandbox.root), before, "the readonly checker must not write any file");
});
