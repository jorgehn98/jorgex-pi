// T70 diagnose: does the real CLI turn a managed native Context7 into a legacy
// false conflict, and does it respect the official-package policy?
//
// Spec 71 ("Runner: diagnóstico local nativo sin falso conflicto legacy"): the
// native exception for a persistent global Context7 entry is selected through
// `inspectOfficialPackages(...).transport === "native"`. A declared adapter
// keeps the legacy pair, and a missing official pair stays blocked; in neither
// case may the certified package/Context7 ownership alone make the entry
// available.
//
// The real bin runs from the ACTIVE managed package root (never the checkout,
// never an injected owner) as one short subprocess per case. Every case asserts
// the policy premise and the readonly checker premise BEFORE running the CLI, so
// a failure can never be blamed on an incoherent fixture.
import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { createManagedReleaseSandbox, snapshotTree } from "./fixtures/native-managed-release.mjs";
import {
  context7Scan,
  installRunnerClosure,
  officialPackagesPolicy,
  protectedDigests,
  readGlobalMcpConfig,
  readProjection,
  readSettings,
  runRunnerCommand,
  writeGlobalMcpConfig,
  writeGlobalSettings,
  writeProjectMcpConfig,
  writeProjection,
} from "./fixtures/native-runner-ownership.mjs";

async function inspectOwnership(sandbox) {
  const module = await import(pathToFileURL(sandbox.entryModulePath).href);
  return module.inspectNativeMcpOwnership({
    env: sandbox.env,
    platform: process.platform,
    cwd: sandbox.root,
    projectTrusted: sandbox.projectTrusted,
  });
}

function readDoctorPayload(run) {
  assert.equal(run.error, undefined, `the CLI must run: ${run.error?.message ?? ""}`);
  assert.ok(typeof run.stdout === "string" && run.stdout.trim().length > 0, `stdout must carry the JSON response: ${run.stderr}`);
  return JSON.parse(run.stdout);
}

function context7Check(payload) {
  const check = payload.result?.checks?.find((entry) => entry?.id === "context7");
  assert.ok(check, `the doctor response keeps its five checks: ${JSON.stringify(payload.result?.checks ?? payload.result)}`);
  return check;
}

function readPayload(run, command) {
  assert.equal(run.error, undefined, `the CLI must run: ${run.error?.message ?? ""}`);
  assert.ok(typeof run.stdout === "string" && run.stdout.trim().length > 0, `stdout must carry the JSON response: ${run.stderr}`);
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.command, command, `the response describes the executed ${command} command, never unknown/INTERNAL`);
  assert.notEqual(payload.error?.code, "INTERNAL", "an expected local diagnostic is never reported as an internal runner failure");
  return payload;
}

async function assertCertifiedPackage(sandbox) {
  const premise = await inspectOwnership(sandbox);
  assert.equal(premise.package?.state, "verified", `the active root must stay a verified managed release: ${premise.package?.reason ?? "no diagnostic"}`);
  assert.equal(premise.servers?.context7?.state, "managed", "the Context7 entry must be owned by the granular authority");
  assert.equal(premise.servers?.context7?.availability, "configured", "the owned Context7 entry is available");
  return premise;
}

test("runner local diagnostic follows the official-package policy for a native Context7", async (t) => {
  await t.test("a valid native setup (own registration plus gentle-engram) reports Context7 available", async (sub) => {
    const sandbox = createManagedReleaseSandbox(sub);
    installRunnerClosure(sandbox);
    // Offline declaration only: the official native pair is what selects the
    // native transport, nothing is installed and no runtime is claimed.
    writeGlobalSettings(sandbox, { gentle: true });

    const official = await officialPackagesPolicy(sandbox);
    assert.equal(official.state, "ready", `the official pair must be ready: ${official.code ?? official.state}`);
    assert.equal(official.transport, "native", "exactly one global gentle-engram without an adapter selects the native transport");
    await assertCertifiedPackage(sandbox);

    const before = snapshotTree(sandbox.root);
    const run = runRunnerCommand(sandbox, ["doctor", "--json"]);
    const payload = readDoctorPayload(run);

    assert.equal(payload.schemaVersion, 1, "the runner keeps its JSON v1 response");
    assert.equal(payload.command, "doctor", "the response describes the executed command, never unknown/INTERNAL");
    assert.notEqual(payload.error?.code, "INTERNAL", "an expected local diagnostic is never an internal runner failure");
    assert.equal(
      context7Check(payload).status,
      "ok",
      `a valid native setup must report a satisfactory local Context7 diagnostic: ${JSON.stringify(context7Check(payload))}`,
    );
    assert.deepEqual(snapshotTree(sandbox.root), before, "doctor must not write configuration, receipts or trust state");
  });

  await t.test("a declared adapter keeps the legacy pair and must not inherit the native exception", async (sub) => {
    const sandbox = createManagedReleaseSandbox(sub);
    installRunnerClosure(sandbox);
    writeGlobalSettings(sandbox, { gentle: true, adapter: true });

    const official = await officialPackagesPolicy(sandbox);
    assert.equal(official.state, "ready", `the legacy pair must be ready: ${official.code ?? official.state}`);
    assert.equal(official.transport, "legacy", "a declared adapter selects the legacy transport");
    // The root proof is unaffected: settings live outside the release closure.
    await assertCertifiedPackage(sandbox);

    const before = snapshotTree(sandbox.root);
    const run = runRunnerCommand(sandbox, ["doctor", "--json"]);
    const payload = readDoctorPayload(run);

    assert.notEqual(
      context7Check(payload).status,
      "ok",
      "under the legacy transport the persistent global Context7 entry must stay blocked, never satisfied by package ownership",
    );
    assert.deepEqual(snapshotTree(sandbox.root), before, "doctor must not write configuration, receipts or trust state");
  });

  await t.test("a setup without the official pair stays blocked", async (sub) => {
    const sandbox = createManagedReleaseSandbox(sub);
    installRunnerClosure(sandbox);
    // Only the own registration: the official pair is missing, which is the
    // existing policy, not a new one.
    writeGlobalSettings(sandbox, {});

    const official = await officialPackagesPolicy(sandbox);
    assert.equal(official.state, "missing", "without one valid global gentle-engram the official gate is missing");
    assert.equal(official.code, "missing-official-packages", `the canonical missing code is preserved: ${official.code ?? official.state}`);
    await assertCertifiedPackage(sandbox);

    const before = snapshotTree(sandbox.root);
    const run = runRunnerCommand(sandbox, ["doctor", "--json"]);
    const payload = readDoctorPayload(run);

    assert.notEqual(
      context7Check(payload).status,
      "ok",
      "a missing official pair must stay blocked even when the package proof and the Context7 hash are certified",
    );
    assert.deepEqual(snapshotTree(sandbox.root), before, "doctor must not write configuration, receipts or trust state");
  });

  await t.test("a Context7 entry in another source stays blocked while the global native entry is permitted", async (sub) => {
    const sandbox = createManagedReleaseSandbox(sub);
    installRunnerClosure(sandbox);
    writeGlobalSettings(sandbox, { gentle: true });
    // Only `mcpServers.context7` of the global Pi file is permitted. A second
    // source carrying the same entry must not be skipped wholesale.
    const globalConfig = readGlobalMcpConfig(sandbox);
    writeProjectMcpConfig(sandbox, { mcpServers: { context7: globalConfig.mcpServers.context7 } });

    const official = await officialPackagesPolicy(sandbox);
    assert.equal(official.state, "ready");
    assert.equal(official.transport, "native");
    // The readonly checker reads only the global agent file, so the ownership
    // premise is untouched by the extra project source.
    await assertCertifiedPackage(sandbox);

    const scan = await context7Scan(sandbox, { nativeContext7: true });
    assert.equal(scan.state, "conflict", `another source must keep blocking: ${scan.code ?? scan.state}`);
    assert.equal(scan.source, "pi-project", "the diagnostic names the blocking source instead of skipping a whole file");
    assert.equal(scan.code, "existing-context7");

    const before = snapshotTree(sandbox.root);
    const run = runRunnerCommand(sandbox, ["doctor", "--json"]);
    const payload = readDoctorPayload(run);
    assert.notEqual(
      context7Check(payload).status,
      "ok",
      "the CLI must not report a satisfactory Context7 diagnostic while an unowned extra source declares the same entry",
    );
    assert.deepEqual(snapshotTree(sandbox.root), before, "doctor must not write configuration, receipts or trust state");
  });

  await t.test("same-file discovery validation still blocks a permitted global native entry", async (sub) => {
    const sandbox = createManagedReleaseSandbox(sub);
    installRunnerClosure(sandbox);
    writeGlobalSettings(sandbox, { gentle: true });
    const globalConfig = readGlobalMcpConfig(sandbox);
    writeGlobalMcpConfig(sandbox, { ...globalConfig, imports: ["npm:foreign-mcp-server"] });

    const official = await officialPackagesPolicy(sandbox);
    assert.equal(official.state, "ready");
    assert.equal(official.transport, "native");
    await assertCertifiedPackage(sandbox);

    // Even when the native permit is granted, the scan must continue and reject
    // the unverified declaration instead of returning early with available.
    const scan = await context7Scan(sandbox, { nativeContext7: true });
    assert.equal(scan.state, "invalid", `unverified imports must fail closed: ${scan.code ?? scan.state}`);
    assert.equal(scan.code, "imports-unverified");

    const before = snapshotTree(sandbox.root);
    const run = runRunnerCommand(sandbox, ["doctor", "--json"]);
    const payload = readDoctorPayload(run);
    assert.notEqual(
      context7Check(payload).status,
      "ok",
      "the CLI must not report a satisfactory Context7 diagnostic while the global file declares unverified imports",
    );
    assert.deepEqual(snapshotTree(sandbox.root), before, "doctor must not write configuration, receipts or trust state");
  });

  await t.test("a disabled raw global entry stays blocked despite protected ownership", async (sub) => {
    const sandbox = createManagedReleaseSandbox(sub);
    installRunnerClosure(sandbox);
    writeGlobalSettings(sandbox, { gentle: true });
    const globalConfig = readGlobalMcpConfig(sandbox);
    writeGlobalMcpConfig(sandbox, {
      ...globalConfig,
      mcpServers: {
        ...globalConfig.mcpServers,
        context7: { ...globalConfig.mcpServers.context7, enabled: false },
      },
    });

    const official = await officialPackagesPolicy(sandbox);
    assert.equal(official.state, "ready");
    assert.equal(official.transport, "native");
    // The preference does not touch the protected fields: the same digest stays
    // managed, but the entry is no longer available for a managed guide.
    const premise = await inspectOwnership(sandbox);
    assert.equal(premise.package?.state, "verified");
    assert.equal(premise.servers?.context7?.state, "managed", "protected ownership is unchanged");
    assert.equal(premise.servers?.context7?.availability, "disabled", "enabled:false is disabled, never configured");

    // The runtime path therefore receives no native permit at all.
    const scan = await context7Scan(sandbox, { nativeContext7: false });
    assert.equal(scan.state, "conflict", `a disabled entry stays blocked: ${scan.code ?? scan.state}`);
    assert.equal(scan.code, "existing-context7");

    const before = snapshotTree(sandbox.root);
    const run = runRunnerCommand(sandbox, ["doctor", "--json"]);
    const payload = readDoctorPayload(run);
    assert.notEqual(
      context7Check(payload).status,
      "ok",
      "a disabled entry must never be reported as a satisfactory local Context7 diagnostic",
    );
    assert.deepEqual(snapshotTree(sandbox.root), before, "doctor must not write configuration, receipts or trust state");
  });

  await t.test("sync initializes the active native installation once and stays idempotent", async (sub) => {
    const sandbox = createManagedReleaseSandbox(sub);
    installRunnerClosure(sandbox);
    writeGlobalSettings(sandbox, { gentle: true });

    // Premises: coherent active managed root, official native transport, and the
    // certified ownership the changed sync route consumes.
    const official = await officialPackagesPolicy(sandbox);
    assert.equal(official.state, "ready");
    assert.equal(official.transport, "native");
    await assertCertifiedPackage(sandbox);

    const before = protectedDigests(sandbox);

    const first = readPayload(runRunnerCommand(sandbox, ["sync", "--json"], { engramBin: true }), "sync");
    assert.equal(first.ok, true, `sync must succeed: ${JSON.stringify(first.error?.code ?? first.error)}`);
    assert.equal(first.result?.changed, true, "the first sync initializes the local installation");
    assert.ok(
      first.result?.actions?.some((action) => action.startsWith("initialized:permissions")),
      `the native-gated sync runs the permission lifecycle: ${JSON.stringify(first.result?.actions)}`,
    );

    // Pi sync never rewrites the advisory receipts, the global MCP file or the
    // projection authority; it only creates its own lifecycle state.
    assert.deepEqual(protectedDigests(sandbox), before, "sync must not rewrite the protected receipts or the global MCP authority");

    // Own registration preserved per field; the defaults created by sync are the
    // expected new state, so settings are compared per key and never byte-wise.
    const settings = readSettings(sandbox);
    assert.deepEqual(
      settings.packages.find((entry) => typeof entry === "object" && entry?.source === `npm:jorgex-pi@${sandbox.version}`),
      { source: `npm:jorgex-pi@${sandbox.version}`, skills: [], prompts: [] },
      "the own managed registration is preserved exactly",
    );
    assert.ok(settings.packages.includes("npm:gentle-engram@0.1.16"), "the gentle declaration is preserved");
    assert.equal(settings.defaultProvider, "openai-codex", "sync created the managed default provider");
    assert.equal(settings.defaultModel, "gpt-5.6-sol", "sync created the managed default model");

    // A converged second run is a no-op.
    const second = readPayload(runRunnerCommand(sandbox, ["sync", "--json"], { engramBin: true }), "sync");
    assert.equal(second.ok, true);
    assert.equal(second.result?.changed, false, "a second sync changes nothing");
    assert.deepEqual(second.result?.actions ?? [], [], "a converged sync reports no actions");
    assert.deepEqual(protectedDigests(sandbox), before, "the second sync keeps the protected paths untouched");

    // The authentic local state produced by sync satisfies the five checks.
    const doctor = readPayload(runRunnerCommand(sandbox, ["doctor", "--json"], { engramBin: true }), "doctor");
    assert.deepEqual(
      Object.fromEntries(doctor.result.checks.map((check) => [check.id, check.status])),
      { package: "ok", engram: "ok", context7: "ok", permissions: "ok", experience: "ok" },
      "the converged local installation satisfies every required check",
    );
    assert.equal(doctor.result.healthy, true);
    assert.equal(doctor.ok, true, "initialization then sync then doctor converges to a healthy local diagnostic");

    const status = readPayload(runRunnerCommand(sandbox, ["status", "--json"], { engramBin: true }), "status");
    assert.equal(status.ok, true, "status agrees with doctor after sync");
    assert.equal(status.result?.context7?.state, "available");
  });

  await t.test("an unowned global Context7 entry stays blocked in a valid native setup", async (sub) => {
    const sandbox = createManagedReleaseSandbox(sub);
    installRunnerClosure(sandbox);
    writeGlobalSettings(sandbox, { gentle: true });

    // Without the granular authority the same persistent entry stays blocked.
    // Receipt data is what changes, never a fake URL binding.
    const projection = readProjection(sandbox);
    delete projection.mcpNative;
    writeProjection(sandbox, projection);

    const official = await officialPackagesPolicy(sandbox);
    assert.equal(official.transport, "native", "the setup itself is a valid native one");
    const premise = await inspectOwnership(sandbox);
    assert.notEqual(
      premise.package?.state,
      "invalid",
      `removing claim data must not invalidate the installation proof: ${premise.package?.reason ?? ""}`,
    );
    assert.notEqual(premise.servers?.context7?.state, "managed", "without granular authority the entry is not owned");

    const before = snapshotTree(sandbox.root);
    const run = runRunnerCommand(sandbox, ["doctor", "--json"]);
    const payload = readDoctorPayload(run);

    assert.notEqual(
      context7Check(payload).status,
      "ok",
      "an unowned persistent Context7 entry must not be reported as a satisfactory local diagnostic",
    );
    assert.deepEqual(snapshotTree(sandbox.root), before, "doctor must not write configuration, receipts or trust state");
  });
});
