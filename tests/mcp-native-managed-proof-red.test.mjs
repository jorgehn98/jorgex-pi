import assert from "node:assert/strict";
import {
  appendFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertReleaseLockCoherence,
  createManagedReleaseSandbox,
  rebindManagedRelease,
  snapshotTree,
} from "./fixtures/native-managed-release.mjs";

// T70 heavy ownership tracer — first positive plus the root-bind control
// (Spec 71, "Proof offline y bind del checker").
//
// Own API: `inspectNativeMcpOwnership({ env, platform, cwd, projectTrusted })`
// async readonly in `extensions/native-mcp.mjs`, with NO public package-root
// parameter: the package root is derived internally from the module URL. It
// requires physical equality between the running module, the active entry
// `agentDir/npm/node_modules/jorgex-pi` and
// `<releaseDir>/node_modules/jorgex-pi`, so an imported checkout or stage can
// never certify another installation.
//
// The positive fixture is a fully coherent OFFLINE synthetic release: cached
// archive bytes, lock with the six canonical SRI dependencies, the running
// manifest, a private release whose id is SHA256(tarSHA256:lockSHA256:treeSHA256),
// the active entry as an exact relative symlink, the exact managed settings
// object, a stage-<32hex> backup path, the schema-1 receipt with
// `managedPackage`, and a granular projection receipt with a protected context7
// claim. Only the minimum real code files are copied; nothing is executed and
// no online emission or signature is claimed.
const CHECKOUT = new URL("../extensions/native-mcp.mjs", import.meta.url).href;

// The released package root necessarily lives under `node_modules`, where Node
// refuses to strip TypeScript for `.ts` entries. The fixture keeps the production
// files byte-identical, so this test bridges that known Node limitation for its
// own temp tree only; the real host loads them through Pi's own loader, and the
// actual-Jiti identity case stays a later verification.
const FIXTURE_PREFIX = join(tmpdir(), "jorgex-pi-native-managed-");
registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith("file:") && url.endsWith(".ts")) {
      const file = fileURLToPath(url);
      if (file.startsWith(FIXTURE_PREFIX)) {
        return {
          format: "module",
          source: stripTypeScriptTypes(readFileSync(file, "utf8"), { mode: "strip" }),
          shortCircuit: true,
        };
      }
    }
    return nextLoad(url, context);
  },
});

function inspect(mcpModule, sandbox) {
  return mcpModule.inspectNativeMcpOwnership({
    env: sandbox.env,
    platform: process.platform,
    cwd: sandbox.root,
    projectTrusted: sandbox.projectTrusted,
  });
}

test("a coherent managed release with a protected context7 claim resolves managed from the managed package root", async (t) => {
  const sandbox = createManagedReleaseSandbox(t);
  const before = snapshotTree(sandbox.root);
  // Root bind: the active entry is physically the release package root.
  assert.equal(
    realpathSync(sandbox.linkPath),
    realpathSync(sandbox.packageRoot),
    "the active entry must physically be the release package root",
  );
  // Fixture coherence before any checker call: the release root carries the npm
  // lock the public contract binds, and it maps the six dependencies correctly.
  assert.equal(existsSync(sandbox.lockPath), true, "the release root must carry package-lock.json");
  assertReleaseLockCoherence(sandbox);
  const releaseLock = JSON.parse(readFileSync(sandbox.lockPath, "utf8"));
  assert.equal(releaseLock.lockfileVersion, 3, "the release lock must be npm lockfileVersion 3 JSON, never a pnpm YAML");
  assert.equal(
    releaseLock.packages[`node_modules/jorgex-pi`]?.version,
    sandbox.version,
    "the installed lock entry must match the package manifest version",
  );
  assert.deepEqual(
    Object.keys(releaseLock.packages).sort(),
    ["", "node_modules/jorgex-pi", ...sandbox.dependencies.map((dep) => `node_modules/${dep.name}`)].sort(),
    "the release lock must map the root, the installed package and the six direct dependencies",
  );

  // The checker is loaded through the ACTIVE managed entry, never through the
  // checkout and never through a public package-root parameter.
  const mcpModule = await import(pathToFileURL(sandbox.entryModulePath).href);
  assert.equal(typeof mcpModule.inspectNativeMcpOwnership, "function", "the managed entry must expose the checker");
  const result = await inspect(mcpModule, sandbox);

  assert.equal(
    result.package?.state,
    "verified",
    `a coherent managed release must verify the package proof: ${result.package?.reason ?? "no diagnostic"}`,
  );
  assert.equal(
    result.servers?.context7?.state,
    "managed",
    `a coherent protected context7 claim must be managed: ${result.servers?.context7?.reason ?? "no diagnostic"}`,
  );
  assert.equal(
    result.servers?.context7?.cleanupEligible,
    true,
    "a wholly created entry with a matching cleanup stamp is cleanup-eligible",
  );
  assert.equal(result.servers?.context7?.availability, "configured", "availability is syntax only, never a connection claim");
  assert.equal(result.servers?.engram?.state, "unowned", "an official provider without a claim stays unowned");
  assert.equal(result.servers?.["chrome-devtools"]?.state, "absent", "without a handoff DevTools stays absent");
  assert.equal(result.connection, "not-verified", "the checker never claims a live connection");
  assert.deepEqual(snapshotTree(sandbox.root), before, "the readonly checker must not write any file");
});

test("the same coherent fixture stays conflict when the checker runs from the imported checkout", async (t) => {
  const sandbox = createManagedReleaseSandbox(t);
  const before = snapshotTree(sandbox.root);
  assertReleaseLockCoherence(sandbox);

  const mcpModule = await import(CHECKOUT);
  const result = await inspect(mcpModule, sandbox);

  assert.notEqual(result.package?.state, "verified", "an imported checkout cannot certify another installation");
  assert.equal(
    result.servers?.context7?.state,
    "conflict",
    "a claim stays conflict unless the checker runs from the matching managed package root",
  );
  assert.equal(result.connection, "not-verified", "the checker never claims a live connection");
  assert.deepEqual(snapshotTree(sandbox.root), before, "the readonly checker must not write any file");
});

// --- T70 negative verification: independent damage seams -------------------
//
// Every case builds its OWN fresh coherent release and mutates it exactly once
// BEFORE the first checker call, so no cached verification from a previous case
// can mask the damage. The checker is always loaded through that fixture's
// active managed entry (never the checkout, never a public package-root
// parameter). A damaged release must either report a visible conflict for the
// claimed server or fail closed with a generic message; it must never echo
// fixture content and must never write.
const SECRET = "synthetic-fixture-must-never-be-echoed";
const OTHER_RELEASE_ID = "1".repeat(64);
const WRONG_SRI = `sha512-${Buffer.alloc(64, 0x2a).toString("base64")}`;

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

const DAMAGE_CASES = [
  {
    label: "main receipt missing while a granular claim exists",
    // With a claim present the package proof is required; an absent receipt is
    // unproven ownership, never the direct channel's `not-required`.
    expectPackage: "conflict",
    mutate: (s) => rmSync(s.receiptPath),
  },
  {
    label: "main receipt malformed",
    expectPackage: "conflict",
    secret: SECRET,
    mutate: (s) => writeFileSync(s.receiptPath, `{"candidate":{"package":{"name":"${SECRET}"`),
  },
  {
    label: "main receipt candidate source drift",
    expectPackage: "conflict",
    secret: SECRET,
    mutate: (s) => {
      const receipt = readJson(s.receiptPath);
      receipt.candidate.package.source = `npm:jorgex-pi@${SECRET}`;
      writeJson(s.receiptPath, receipt);
    },
  },
  {
    label: "main receipt scope drift",
    expectPackage: "conflict",
    secret: SECRET,
    mutate: (s) => {
      const receipt = readJson(s.receiptPath);
      receipt.scope.codingAgentDir = join(s.root, SECRET);
      writeJson(s.receiptPath, receipt);
    },
  },
  {
    label: "cached archive byte drift",
    expectPackage: "conflict",
    secret: SECRET,
    mutate: (s) => appendFileSync(s.cachePath, `${SECRET}\n`),
  },
  {
    label: "raw release lock drift",
    expectPackage: "conflict",
    secret: SECRET,
    mutate: (s) => appendFileSync(s.lockPath, `${SECRET}\n`),
  },
  {
    label: "deep closure file drift inside the release tree",
    expectPackage: "conflict",
    secret: SECRET,
    mutate: (s) => appendFileSync(join(s.packageRoot, "extensions", "context7-config.mjs"), `\n// ${SECRET}\n`),
  },
  {
    label: "active entry repointed to a version-identical sibling release",
    expectPackage: "conflict",
    mutate: (s) => {
      const sibling = join(dirname(s.releaseDir), OTHER_RELEASE_ID);
      cpSync(s.releaseDir, sibling, { recursive: true });
      rmSync(s.linkPath);
      symlinkSync(`../jorgex-pi-managed/releases/${OTHER_RELEASE_ID}/node_modules/jorgex-pi`, s.linkPath);
    },
  },
  {
    label: "receipt dependency integrity drift (main receipt only)",
    expectPackage: "conflict",
    mutate: (s) => {
      const receipt = readJson(s.receiptPath);
      receipt.managedPackage.dependencies[0].integrity = WRONG_SRI;
      writeJson(s.receiptPath, receipt);
    },
  },
  {
    label: "projection claim digest drift with an intact package",
    // The package proof is independent of the granular claim: the package stays
    // verified while the damaged claim fails closed as a server conflict.
    expectPackage: "verified",
    mutate: (s) => {
      const projection = readJson(s.projectionPath);
      projection.mcpNative.entries.context7.definitionSha256 = "0".repeat(64);
      writeJson(s.projectionPath, projection);
    },
  },
  {
    label: "projection authority scope drift",
    expectPackage: "unproven",
    secret: SECRET,
    mutate: (s) => {
      const projection = readJson(s.projectionPath);
      projection.scope.codingAgentDir = join(s.root, SECRET);
      writeJson(s.projectionPath, projection);
    },
  },
];

for (const damage of DAMAGE_CASES) {
  test(`damage seam: ${damage.label}`, async (t) => {
    const sandbox = createManagedReleaseSandbox(t);
    damage.mutate(sandbox);
    const before = snapshotTree(sandbox.root);

    const mcpModule = await import(pathToFileURL(sandbox.entryModulePath).href);
    let result;
    let failure;
    try {
      result = await inspect(mcpModule, sandbox);
    } catch (error) {
      failure = error;
    }
    const messages = [
      result?.package?.reason,
      result?.servers?.context7?.reason,
      result?.servers?.engram?.reason,
      failure?.message,
    ].filter((message) => typeof message === "string").join(" | ");

    if (damage.secret !== undefined) {
      assert.equal(messages.includes(damage.secret), false, "diagnostics must never echo fixture content");
    }
    assert.equal(messages.includes(sandbox.releaseDir), false, "diagnostics must never echo the release path");
    assert.deepEqual(snapshotTree(sandbox.root), before, "the readonly checker must not write any file");
    if (result !== undefined) {
      assert.equal(
        result.servers?.context7?.state,
        "conflict",
        `a damaged release can never leave a claim managed: ${messages || "no diagnostic"}`,
      );
    }
    if (damage.expectPackage === "unproven") {
      assert.ok(
        failure !== undefined || result?.package?.state !== "verified",
        `an incoherent projection authority must not certify the package: ${messages || "no diagnostic"}`,
      );
    } else {
      assert.equal(failure, undefined, `the checker must report, not throw: ${failure?.message}`);
      assert.equal(
        result.package?.state,
        damage.expectPackage,
        `damaged release "${damage.label}": ${messages || "no diagnostic"}`,
      );
    }
  });
}

// --- T70 settings coexistence ----------------------------------------------
//
// The published Stack contract (`filterProjectedPiPackage` and the removal
// planner in `src/lib/pi-package-lifecycle.ts`) treats the managed registration
// as the ONE exact own `jorgex-pi` entry inside `settings.packages`: foreign and
// provider-managed entries and unrelated keys are preserved untouched, and
// ambiguous registrations (zero or several own entries) fail closed. The
// existing own object keeps its exact source/skills/prompts shape, and the
// extra entries are harmless fixture data (nothing is installed, nothing runs).
test("managed settings coexist with preserved packages and reject a duplicated own identity", async (t) => {
  await t.test("own entry plus gentle-engram and a foreign package stays verified and managed", async (sub) => {
    const sandbox = createManagedReleaseSandbox(sub);
    const settingsPath = join(sandbox.agentDir, "settings.json");
    const settings = readJson(settingsPath);
    settings.packages = [
      ...settings.packages,
      { source: "npm:gentle-engram@0.1.16", skills: [], prompts: [] },
      { source: "npm:fixture-helper@0.0.1", skills: [], prompts: [] },
    ];
    // Settings live outside the release root, so the lock and the tree hash stay
    // coherent and only the ownership filter is under test.
    writeJson(settingsPath, settings);
    const before = snapshotTree(sandbox.root);

    const mcpModule = await import(pathToFileURL(sandbox.entryModulePath).href);
    const result = await inspect(mcpModule, sandbox);

    assert.equal(
      result.package?.state,
      "verified",
      `a single own registration must survive preserved foreign entries: ${result.package?.reason ?? "no diagnostic"}`,
    );
    assert.equal(
      result.servers?.context7?.state,
      "managed",
      `preserved foreign settings must not disturb the protected claim: ${result.servers?.context7?.reason ?? "no diagnostic"}`,
    );
    assert.equal(result.connection, "not-verified", "the checker never claims a live connection");
    assert.deepEqual(snapshotTree(sandbox.root), before, "the readonly checker must not write any file");
  });

  await t.test("a duplicated own registration can never be verified", async (sub) => {
    const sandbox = createManagedReleaseSandbox(sub);
    const settingsPath = join(sandbox.agentDir, "settings.json");
    const settings = readJson(settingsPath);
    settings.packages = [...settings.packages, { ...settings.packages[0] }];
    writeJson(settingsPath, settings);
    const before = snapshotTree(sandbox.root);

    const mcpModule = await import(pathToFileURL(sandbox.entryModulePath).href);
    const result = await inspect(mcpModule, sandbox);

    assert.notEqual(
      result.package?.state,
      "verified",
      "an ambiguous registration with several own entries must fail closed",
    );
    assert.equal(
      result.servers?.context7?.state,
      "conflict",
      `a claim cannot be managed from an ambiguous registration: ${result.servers?.context7?.reason ?? "no diagnostic"}`,
    );
    assert.deepEqual(snapshotTree(sandbox.root), before, "the readonly checker must not write any file");
  });
});

// --- T70 topology and SRI canonicality (Spec 71) ---------------------------
//
// Two deterministic proof guards, each isolated on its own fresh release. The
// canonical Stack encoder (`readContainedLinkTarget` in
// `src/lib/pi-staged-lock.ts`) walks EVERY component of a symlink target: an
// intermediate directory symlink is a chain and must fail even when the final
// component is an ordinary regular file. `assertCanonicalSha512` in the same
// module requires a sha512 SRI to decode to exactly 64 bytes and round-trip
// through base64, so a shape-valid but short SRI is not canonical.
//
// Each case mutates the release and then rebinds the raw lock hash, the tree
// hash, the release id and the active entry to the mutated bytes, so the only
// remaining defect is the topology or the canonicality itself. Known
// limitations: the fixture encoder refuses absolute targets at construction, so
// the absolute/escape/broken variants stay a later tracer with a manual raw
// vector instead of a manufactured hash-mismatch RED.
const NON_CANONICAL_SRI = `sha512-${Buffer.from("abc").toString("base64")}`;

test("release topology and SRI canonicality fail closed on their own", async (t) => {
  await t.test("a target walking through an intermediate directory symlink is a chain", async (sub) => {
    const sandbox = createManagedReleaseSandbox(sub);
    const payload = join(sandbox.packageRoot, "extensions", "payload");
    mkdirSync(payload, { recursive: true });
    writeFileSync(join(payload, "entry.dat"), "fixture payload\n");
    symlinkSync("jorgex-pi/extensions/payload", join(sandbox.releaseDir, "node_modules", "lib-link"));
    mkdirSync(join(sandbox.releaseDir, "node_modules", ".bin"), { recursive: true });
    symlinkSync("../lib-link/entry.dat", join(sandbox.releaseDir, "node_modules", ".bin", "through-link"));
    rebindManagedRelease(sandbox);

    // The final component is an ordinary regular file; only the intermediate
    // component of the walk is a symlink, and the tree hash matches the mutated
    // bytes, so the failure cannot be a stale hash.
    assert.equal(
      lstatSync(join(sandbox.releaseDir, "node_modules", ".bin", "through-link")).isSymbolicLink(),
      true,
      "the case needs a symlink whose target walks through another symlink",
    );
    assert.equal(
      lstatSync(join(sandbox.releaseDir, "node_modules", "lib-link", "entry.dat")).isFile(),
      true,
      "the final component under the chained walk must be a regular file",
    );
    const before = snapshotTree(sandbox.root);

    const mcpModule = await import(pathToFileURL(sandbox.entryModulePath).href);
    const result = await inspect(mcpModule, sandbox);

    assert.equal(
      result.package?.state,
      "conflict",
      `a chained symlink must fail closed even with a matching tree hash: ${result.package?.reason ?? "no diagnostic"}`,
    );
    assert.equal(
      result.servers?.context7?.state,
      "conflict",
      "a claim cannot be managed from a chained release",
    );
    assert.deepEqual(snapshotTree(sandbox.root), before, "the readonly checker must not write any file");
  });

  await t.test("a shape-valid but non-canonical sha512 SRI dependency is rejected", async (sub) => {
    const sandbox = createManagedReleaseSandbox(sub);
    const receipt = readJson(sandbox.receiptPath);
    const [dependency] = receipt.managedPackage.dependencies;
    dependency.integrity = NON_CANONICAL_SRI;
    writeJson(sandbox.receiptPath, receipt);
    const lock = readJson(sandbox.lockPath);
    lock.packages[`node_modules/${dependency.name}`].integrity = NON_CANONICAL_SRI;
    writeJson(sandbox.lockPath, lock);
    rebindManagedRelease(sandbox);

    // Fixture coherence: the root lock is still npm lockfileVersion 3 with the
    // actual six dependency names/versions, the receipt and the lock agree on
    // the SRI, and only canonicality is broken.
    const rebound = readJson(sandbox.lockPath);
    assert.equal(rebound.lockfileVersion, 3, "the mutated root lock must stay npm lockfileVersion 3");
    assert.deepEqual(
      Object.keys(rebound.packages).sort(),
      ["", "node_modules/jorgex-pi", ...sandbox.dependencies.map((dep) => `node_modules/${dep.name}`)].sort(),
      "the mutated root lock must keep the root, the installed package and the six dependencies",
    );
    assert.equal(rebound.packages[`node_modules/${dependency.name}`].version, dependency.version);
    assert.equal(rebound.packages[`node_modules/${dependency.name}`].integrity, NON_CANONICAL_SRI);
    assert.notEqual(
      Buffer.from(NON_CANONICAL_SRI.slice("sha512-".length), "base64").length,
      64,
      "the fixture SRI must be shape-valid but not canonical",
    );
    const before = snapshotTree(sandbox.root);

    const mcpModule = await import(pathToFileURL(sandbox.entryModulePath).href);
    const result = await inspect(mcpModule, sandbox);

    assert.equal(
      result.package?.state,
      "conflict",
      `a non-canonical SRI is not authenticated by shape: ${result.package?.reason ?? "no diagnostic"}`,
    );
    assert.equal(
      result.servers?.context7?.state,
      "conflict",
      "a claim cannot be managed from a release with a non-canonical dependency SRI",
    );
    assert.deepEqual(snapshotTree(sandbox.root), before, "the readonly checker must not write any file");
  });

  await t.test("an ordinary contained relative file symlink stays verified", async (sub) => {
    const sandbox = createManagedReleaseSandbox(sub);
    mkdirSync(join(sandbox.releaseDir, "node_modules", ".bin"), { recursive: true });
    symlinkSync(
      "../jorgex-pi/extensions/context7-config.mjs",
      join(sandbox.releaseDir, "node_modules", ".bin", "fixture-cli"),
    );
    rebindManagedRelease(sandbox);
    const before = snapshotTree(sandbox.root);

    const mcpModule = await import(pathToFileURL(sandbox.entryModulePath).href);
    const result = await inspect(mcpModule, sandbox);

    assert.equal(
      result.package?.state,
      "verified",
      `a plain contained relative link is not a chain: ${result.package?.reason ?? "no diagnostic"}`,
    );
    assert.equal(
      result.servers?.context7?.state,
      "managed",
      `a plain contained relative link must not disturb the claim: ${result.servers?.context7?.reason ?? "no diagnostic"}`,
    );
    assert.deepEqual(snapshotTree(sandbox.root), before, "the readonly checker must not write any file");
  });
});
