// T70 preferences and availability protection (Spec 71 L29/L33/L35).
//
// The protected definition digest covers only the canonical fields (for an HTTP
// server, its url), so user personalization such as added headers keeps the
// protected ownership. The cleanup stamp is a SEPARATE contract over the whole
// entry: once the entry changed, the checker must never report the entry as
// cleanup-eligible, and it must never rewrite or adopt the stamp it would like
// to accept. Raw `!` executions stay inert data and classify availability as
// unsupported-execution; a hidden server must not look available; an unsupported
// entry shape still fails closed as conflict.
//
// The strongest available seam: the actual readonly checker loaded from the
// managed release fixture, with only mcp.json and the projection receipt mutated
// (both live outside the closed release tree, so the package proof stays cached
// and no rebind is needed). Nothing is executed and no real HOME, credentials,
// tokens or HTTP are involved.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { createManagedReleaseSandbox, snapshotTree } from "./fixtures/native-managed-release.mjs";

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function inspect(sandbox) {
  const module = await import(pathToFileURL(sandbox.entryModulePath).href);
  return module.inspectNativeMcpOwnership({
    env: sandbox.env,
    platform: process.platform,
    cwd: sandbox.root,
    projectTrusted: sandbox.projectTrusted,
  });
}

function updateContext7Entry(sandbox, mutate) {
  const configPath = join(sandbox.agentDir, "mcp.json");
  const config = readJson(configPath);
  config.mcpServers.context7 = mutate({ ...config.mcpServers.context7 });
  writeJson(configPath, config);
  return configPath;
}

function updateContext7Claim(sandbox, mutate) {
  const projection = readJson(sandbox.projectionPath);
  mutate(projection.mcpNative.entries.context7);
  writeJson(sandbox.projectionPath, projection);
}

function context7(result) {
  return result.servers?.context7;
}

test("personalization keeps protected ownership but never keeps cleanup eligibility", async (t) => {
  await t.test("the untouched managed entry stays cleanup-eligible", async (sub) => {
    const sandbox = createManagedReleaseSandbox(sub);
    const before = snapshotTree(sandbox.root);

    const result = await inspect(sandbox);
    const server = context7(result);

    assert.equal(result.package?.state, "verified", "the closed release proof stays verified");
    assert.equal(server?.state, "managed", "the baseline entry is owned");
    assert.equal(server?.availability, "configured", "a plain url-only entry is available");
    assert.equal(server?.cleanupEligible, true, "an untouched created entry carries the matching cleanup stamp");
    assert.equal(result.connection, "not-verified", "the checker never claims a live connection");
    assert.deepEqual(snapshotTree(sandbox.root), before, "the checker must not write, rewrite or adopt any stamp");
  });

  await t.test("an added personalization header keeps ownership but drops cleanup eligibility", async (sub) => {
    const sandbox = createManagedReleaseSandbox(sub);
    // Ordinary personalization: the protected digest covers the url only, while
    // the cleanup stamp was taken over the original whole entry.
    updateContext7Entry(sandbox, (entry) => ({ ...entry, headers: { "X-Note": "personal-preference" } }));
    const before = snapshotTree(sandbox.root);

    const result = await inspect(sandbox);
    const server = context7(result);

    assert.equal(server?.state, "managed", "preferences outside the protected fields keep the owned state");
    assert.equal(server?.availability, "configured", "an ordinary personalization stays available");
    assert.equal(
      server?.cleanupEligible,
      false,
      "a personalized entry is never cleanup-eligible: the stamp describes the original whole entry",
    );
    assert.deepEqual(snapshotTree(sandbox.root), before, "the checker never rewrites the stamp to accept the change");
  });

  await t.test("a formatting-only rewrite keeps the same cleanup eligibility", async (sub) => {
    const sandbox = createManagedReleaseSandbox(sub);
    const configPath = join(sandbox.agentDir, "mcp.json");
    // Same parsed entry, different JSON layout: the stamp is over the parsed
    // entry, not over the file bytes.
    writeFileSync(configPath, JSON.stringify(readJson(configPath), null, 4));
    const before = snapshotTree(sandbox.root);

    const result = await inspect(sandbox);
    const server = context7(result);

    assert.equal(server?.state, "managed", "whitespace is not a semantic change");
    assert.equal(server?.availability, "configured", "whitespace does not change availability");
    assert.equal(server?.cleanupEligible, true, "an unchanged parsed entry keeps its cleanup stamp");
    assert.deepEqual(snapshotTree(sandbox.root), before, "the checker must not normalize or rewrite the file");
  });

  await t.test("an absent cleanup stamp is never cleanup-eligible", async (sub) => {
    const sandbox = createManagedReleaseSandbox(sub);
    updateContext7Claim(sandbox, (claim) => {
      delete claim.cleanupSha256;
    });
    const before = snapshotTree(sandbox.root);

    const result = await inspect(sandbox);
    const server = context7(result);

    assert.equal(server?.state, "managed", "the optional cleanup stamp does not affect ownership");
    assert.equal(server?.cleanupEligible, false, "without a stamp nothing may be cleaned up");
    assert.equal(result.connection, "not-verified", "the checker never claims a live connection");
    assert.deepEqual(snapshotTree(sandbox.root), before, "the checker never invents a missing stamp");
  });
});

test("raw execution customization and hidden exposure never look available", async (t) => {
  await t.test("a raw execution header stays inert and is classified unsupported-execution", async (sub) => {
    const sandbox = createManagedReleaseSandbox(sub);
    // Inert data: the string is never resolved, imported or executed. The canary
    // path only exists to prove that no execution happened.
    const canaryPath = join(sandbox.root, "preferences-canary.txt");
    updateContext7Entry(sandbox, (entry) => ({
      ...entry,
      headers: { "X-Raw": `!write-owned-canary ${canaryPath}` },
    }));
    const before = snapshotTree(sandbox.root);

    const result = await inspect(sandbox);
    const server = context7(result);

    assert.equal(server?.state, "managed", "a raw execution header does not change the protected ownership");
    assert.equal(
      server?.availability,
      "unsupported-execution",
      "user-authored raw execution is never reported as a plain configured availability",
    );
    assert.equal(server?.cleanupEligible, false, "the changed entry is not cleanup-eligible");
    assert.equal(existsSync(canaryPath), false, "the checker never executes raw user-authored commands");
    assert.deepEqual(snapshotTree(sandbox.root), before, "inspection is pure: no file is created or executed");
  });

  await t.test("a hidden exposure is not available", async (sub) => {
    const sandbox = createManagedReleaseSandbox(sub);
    // `exposure` is an allowed preference, not a protected field, so ownership
    // is retained; the closed availability enum has no separate hidden state, so
    // hidden must not look available.
    updateContext7Entry(sandbox, (entry) => ({ ...entry, exposure: "hidden" }));
    const before = snapshotTree(sandbox.root);

    const result = await inspect(sandbox);
    const server = context7(result);

    assert.equal(server?.state, "managed", "a hidden server keeps its protected ownership");
    assert.equal(
      server?.availability,
      "disabled",
      "a hidden server must not be reported as available/configured",
    );
    assert.equal(server?.cleanupEligible, false, "the changed entry is not cleanup-eligible");
    assert.deepEqual(snapshotTree(sandbox.root), before, "the checker must not write");
  });

  await t.test("an unsupported entry shape fails closed as conflict", async (sub) => {
    const sandbox = createManagedReleaseSandbox(sub);
    // Not a string record: the definition is unsupported by the schema and must
    // never silently become managed or unowned.
    updateContext7Entry(sandbox, (entry) => ({ ...entry, headers: { "X-Bad": { nested: true } } }));
    const before = snapshotTree(sandbox.root);

    const result = await inspect(sandbox);
    const server = context7(result);

    assert.equal(server?.state, "conflict", "an unsupported definition shape fails closed");
    assert.equal(server?.cleanupEligible, false, "a conflict is never cleanup-eligible");
    assert.equal(result.connection, "not-verified", "the checker never claims a live connection");
    assert.deepEqual(snapshotTree(sandbox.root), before, "the checker must not write");
  });
});
