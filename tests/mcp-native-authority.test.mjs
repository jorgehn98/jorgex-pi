// Native authority: direct-channel ownership, the managed-release package
// proof, preferences/cleanup, the effective project override and DevTools
// ownership. Every release case builds its own fresh coherent release.
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  appendFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { CONTEXT7_URL, digestNativeMcpDefinition } from "../extensions/mcp-engram.mjs";
import {
  assertReleaseLockCoherence,
  createManagedReleaseSandbox,
  rebindManagedRelease,
  snapshotTree,
} from "./fixtures/native-managed-release.mjs";
import { installDevtoolsChain, writeDevtoolsOwnership } from "./fixtures/native-devtools-ownership.mjs";

const CHECKOUT = new URL("../extensions/native-mcp.mjs", import.meta.url).href;

// The checker module is required for this contract; a missing module fails the
// public-API case instead of crashing the import.
async function loadOwnershipChecker() {
  try {
    return await import("../extensions/native-mcp.mjs");
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND" || error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function inspect(module, sandbox, projectTrusted = sandbox.projectTrusted) {
  return module.inspectNativeMcpOwnership({
    env: sandbox.env,
    platform: process.platform,
    cwd: sandbox.root,
    projectTrusted,
  });
}

async function inspectManaged(sandbox, projectTrusted = sandbox.projectTrusted) {
  return inspect(await import(pathToFileURL(sandbox.entryModulePath).href), sandbox, projectTrusted);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

test("the readonly ownership checker exposes its public API", async () => {
  const module = await loadOwnershipChecker();
  assert.equal(
    typeof module?.inspectNativeMcpOwnership,
    "function",
    "extensions/native-mcp.mjs must export the readonly inspectNativeMcpOwnership({ env, platform, cwd, projectTrusted })",
  );
});

// --- Direct channel: native `mcp.json` without granular authority stays
// unowned and the checker is readonly. ---------------------------------------
const SERVER_NAMES = ["engram", "context7", "chrome-devtools"];
const OWNERSHIP_STATES = ["absent", "unowned", "conflict", "managed"];
const AVAILABILITY_STATES = ["unavailable", "configured", "disabled", "unsupported-execution"];

function nativeServers() {
  return {
    engram: { command: process.execPath, args: ["mcp", "--tools=agent"], exposure: "deferred" },
    context7: { url: CONTEXT7_URL },
  };
}

function createNativeOwnershipSandbox(t, { mcpJson } = {}) {
  const root = mkdtempSync(join(tmpdir(), "jorgex-pi-native-ownership-"));
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

// --- Managed release proof: no public package-root param; the root is derived
// from the module URL with physical equality. --------------------------------
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
  const releaseLock = readJson(sandbox.lockPath);
  assert.equal(releaseLock.lockfileVersion, 3, "the release lock must be npm lockfileVersion 3 JSON, never a pnpm YAML");
  assert.equal(
    releaseLock.packages["node_modules/jorgex-pi"]?.version,
    sandbox.version,
    "the installed lock entry must match the package manifest version",
  );
  assert.deepEqual(
    Object.keys(releaseLock.packages).sort(),
    ["", "node_modules/jorgex-pi", ...sandbox.dependencies.map((dep) => `node_modules/${dep.name}`)].sort(),
    "the release lock must map the root, the installed package and the six direct dependencies",
  );

  const mcpModule = await import(pathToFileURL(sandbox.entryModulePath).href);
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

// --- Independent damage seams -------------------------------------------------
//
// Every case builds its OWN fresh coherent release and mutates it exactly once
// BEFORE the first checker call, so no cached verification from a previous case
// can mask the damage. A damaged release must either report a visible conflict
// for the claimed server or fail closed with a generic message; it must never
// echo fixture content and must never write.
const SECRET = "synthetic-fixture-must-never-be-echoed";
const OTHER_RELEASE_ID = "1".repeat(64);
const WRONG_SRI = `sha512-${Buffer.alloc(64, 0x2a).toString("base64")}`;

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

// --- Settings coexistence -----------------------------------------------------
//
// The published Stack contract treats the managed registration as the ONE exact
// own `jorgex-pi` entry inside `settings.packages`: foreign and
// provider-managed entries and unrelated keys are preserved untouched, and
// ambiguous registrations (zero or several own entries) fail closed.
const SETTINGS_PRESERVED_CASES = [
  {
    label: "own entry plus gentle-engram and a foreign package stays verified and managed",
    extraPackages: [
      { source: "npm:gentle-engram@0.1.16", skills: [], prompts: [] },
      { source: "npm:fixture-helper@0.0.1", skills: [], prompts: [] },
    ],
  },
  {
    label: "foreign packages whose names merely contain jorgex-pi stay preserved and verified",
    extraPackages: [
      { source: "npm:my-jorgex-pi-helper@1.2.3", skills: [], prompts: [] },
      { source: "npm:jorgex-pi-extra@2.0.0", skills: [], prompts: [] },
    ],
  },
];

test("managed settings coexist with preserved packages and reject a duplicated own identity", async (t) => {
  for (const row of SETTINGS_PRESERVED_CASES) {
    await t.test(row.label, async (sub) => {
      const sandbox = createManagedReleaseSandbox(sub);
      const settingsPath = join(sandbox.agentDir, "settings.json");
      const settings = readJson(settingsPath);
      // Declaration-only fixture data: nothing is installed, no receipt is
      // fabricated, and settings live outside the release root, so the lock and
      // the tree hash stay coherent and no rebind is needed.
      settings.packages = [...settings.packages, ...row.extraPackages];
      writeJson(settingsPath, settings);
      const before = snapshotTree(sandbox.root);

      const result = await inspectManaged(sandbox);

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
  }

  await t.test("a duplicated own registration can never be verified", async (sub) => {
    const sandbox = createManagedReleaseSandbox(sub);
    const settingsPath = join(sandbox.agentDir, "settings.json");
    const settings = readJson(settingsPath);
    settings.packages = [...settings.packages, { ...settings.packages[0] }];
    writeJson(settingsPath, settings);
    const before = snapshotTree(sandbox.root);

    const result = await inspectManaged(sandbox);

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

// --- Release topology and SRI canonicality (Spec 71) -------------------------
//
// The canonical Stack encoder walks EVERY component of a symlink target: an
// intermediate directory symlink is a chain and must fail even when the final
// component is an ordinary regular file. A sha512 SRI must decode to exactly 64
// bytes and round-trip through base64, so a shape-valid but short SRI is not
// canonical. Each case mutates the release and then rebinds the raw lock hash,
// the tree hash, the release id and the active entry to the mutated bytes, so
// the only remaining defect is the topology or the canonicality itself.
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

    const result = await inspectManaged(sandbox);

    assert.equal(
      result.package?.state,
      "conflict",
      `a chained symlink must fail closed even with a matching tree hash: ${result.package?.reason ?? "no diagnostic"}`,
    );
    assert.equal(result.servers?.context7?.state, "conflict", "a claim cannot be managed from a chained release");
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

    const result = await inspectManaged(sandbox);

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

    const result = await inspectManaged(sandbox);

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

// --- Cache: heavy proof once per startup identity -----------------------------
//
// The heavy offline proof is a once-per-startup (per identity fingerprint) cost
// while the configuration, projection authority and preferences stay fresh on
// every inspection. The seam is the real filesystem boundary: a test-local
// instrumentation forwards every call to the REAL fs and only counts the known
// heavy opens (the cached archive and the release tree); no bytes are faked and
// no production cache flag or package-root bypass exists.
function countHeavyIo(sandbox) {
  const archivePaths = new Set([sandbox.cachePath, realpathSync(sandbox.cachePath)]);
  const releasePrefixes = new Set([
    `${sandbox.releaseDir}${sep}`,
    `${realpathSync(sandbox.releaseDir)}${sep}`,
  ]);
  const counts = { archive: 0, tree: 0, reads: 0 };
  const originalOpen = fs.openSync;
  const originalRead = fs.readSync;
  fs.openSync = function instrumentedOpen(file, ...rest) {
    if (typeof file === "string") {
      if (archivePaths.has(file)) counts.archive += 1;
      else if ([...releasePrefixes].some((prefix) => file.startsWith(prefix))) counts.tree += 1;
    }
    return originalOpen.call(this, file, ...rest);
  };
  fs.readSync = function instrumentedRead(...args) {
    counts.reads += 1;
    return originalRead.apply(this, args);
  };
  // Make the patched builtins visible to the managed module's own named
  // `node:fs` imports; restored from a finally and again from t.after.
  syncBuiltinESMExports();
  let restored = false;
  return {
    counts,
    restore() {
      if (restored) return;
      restored = true;
      fs.openSync = originalOpen;
      fs.readSync = originalRead;
      syncBuiltinESMExports();
    },
  };
}

test("the heavy release proof runs once per startup identity while preferences stay fresh", async (t) => {
  const sandbox = createManagedReleaseSandbox(t);
  const configPath = join(sandbox.agentDir, "mcp.json");
  const mcpModule = await import(pathToFileURL(sandbox.entryModulePath).href);

  const instrumentation = countHeavyIo(sandbox);
  t.after(() => instrumentation.restore());
  let first;
  let firstCounts;
  let second;
  let secondCounts;
  try {
    first = await inspect(mcpModule, sandbox);
    firstCounts = { ...instrumentation.counts };

    // Fresh user preference between the two inspections: `enabled` is an allowed
    // preference but not a protected definition field, so ownership stays and
    // only availability and the cleanup stamp must refresh.
    const config = readJson(configPath);
    config.mcpServers.context7 = { ...config.mcpServers.context7, enabled: false };
    writeJson(configPath, config);

    second = await inspect(mcpModule, sandbox);
    secondCounts = { ...instrumentation.counts };
  } finally {
    instrumentation.restore();
  }

  assert.equal(first.package?.state, "verified", "the first inspection verifies the coherent release");
  assert.equal(first.servers?.context7?.state, "managed", "the first inspection owns the protected claim");
  assert.ok(
    firstCounts.archive >= 1 && firstCounts.tree >= 1,
    `the instrumentation must observe the real heavy proof: ${JSON.stringify(firstCounts)}`,
  );

  assert.equal(
    second.package?.state,
    "verified",
    `the same startup identity must not re-prove the package: ${second.package?.reason ?? "no diagnostic"}`,
  );
  assert.equal(second.servers?.context7?.state, "managed", "ownership is authority and must not change");
  assert.equal(second.servers?.context7?.cleanupEligible, false, "the changed entry must be fresh, not cleanup-eligible");
  assert.equal(second.servers?.context7?.availability, "disabled", "a fresh preference must reclassify availability");
  assert.equal(
    secondCounts.archive,
    firstCounts.archive,
    `a second inspection with the same identity must not reopen the cached archive: first ${JSON.stringify(firstCounts)} second ${JSON.stringify(secondCounts)}`,
  );
  assert.equal(
    secondCounts.tree,
    firstCounts.tree,
    `a second inspection with the same identity must not rehash the release tree: first ${JSON.stringify(firstCounts)} second ${JSON.stringify(secondCounts)}`,
  );
});

test("a changed receipt fingerprint invalidates the proof without a sticky conflict", async (t) => {
  const sandbox = createManagedReleaseSandbox(t);
  const mcpModule = await import(pathToFileURL(sandbox.entryModulePath).href);
  const originalReceipt = readFileSync(sandbox.receiptPath);

  const first = await inspect(mcpModule, sandbox);
  assert.equal(first.package?.state, "verified", "the coherent release verifies before the fingerprint changes");
  assert.equal(first.servers?.context7?.state, "managed", "the protected claim is owned before the change");

  const drifted = JSON.parse(originalReceipt.toString("utf8"));
  drifted.scope.codingAgentDir = join(sandbox.root, "other-agent");
  writeJson(sandbox.receiptPath, drifted);
  const second = await inspect(mcpModule, sandbox);
  assert.equal(second.package?.state, "conflict", "a changed receipt fingerprint must invalidate the proof");
  assert.equal(second.servers?.context7?.state, "conflict", "a claim cannot stay managed on a drifted receipt");

  writeFileSync(sandbox.receiptPath, originalReceipt);
  const third = await inspect(mcpModule, sandbox);
  assert.equal(third.package?.state, "verified", "restoring the fingerprint must verify again, with no sticky conflict");
  assert.equal(third.servers?.context7?.state, "managed", "the restored identity owns the protected claim again");
});

// --- Preferences and cleanup --------------------------------------------------
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
  await t.test("an added personalization header keeps ownership but drops cleanup eligibility", async (sub) => {
    const sandbox = createManagedReleaseSandbox(sub);
    // Ordinary personalization: the protected digest covers the url only, while
    // the cleanup stamp was taken over the original whole entry.
    updateContext7Entry(sandbox, (entry) => ({ ...entry, headers: { "X-Note": "personal-preference" } }));
    const before = snapshotTree(sandbox.root);

    const result = await inspectManaged(sandbox);
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

    const result = await inspectManaged(sandbox);
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

    const result = await inspectManaged(sandbox);
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

    const result = await inspectManaged(sandbox);
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

    const result = await inspectManaged(sandbox);
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

    const result = await inspectManaged(sandbox);
    const server = context7(result);

    assert.equal(server?.state, "conflict", "an unsupported definition shape fails closed");
    assert.equal(server?.cleanupEligible, false, "a conflict is never cleanup-eligible");
    assert.equal(result.connection, "not-verified", "the checker never claims a live connection");
    assert.deepEqual(snapshotTree(sandbox.root), before, "the checker must not write");
  });
});

// --- Effective project override ----------------------------------------------
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

test("a trusted project override substitutes the protected context7 server as conflict", async (t) => {
  const sandbox = createManagedReleaseSandbox(t);
  writeProjectOverride(sandbox);
  const before = snapshotTree(sandbox.root);

  const result = await inspectManaged(sandbox, true);

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

  const result = await inspectManaged(sandbox, false);

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

// --- DevTools ownership -------------------------------------------------------
// Matching definition digest alone never suffices; the whole-handoff stamp plus
// the trusted v3 guard is required. The DevTools guard chain itself is proven by
// tests/mcp-native-config.
const WRONG_HANDOFF_SHA256 = "0".repeat(64);

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

    const result = await inspectManaged(sandbox);

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

    const result = await inspectManaged(sandbox);
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

    const result = await inspectManaged(sandbox);
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

    const result = await inspectManaged(sandbox);
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
// meaningful for this surface too.
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
  const result = await inspect(checkoutModule, sandbox);

  assert.notEqual(result.package?.state, "verified", "an imported checkout cannot certify another installation");
  assert.equal(result.servers?.["chrome-devtools"]?.state, "conflict", "the claim stays conflict from a checkout");
  assert.deepEqual(snapshotTree(sandbox.root), before, "the readonly checker must not write any file");
});
