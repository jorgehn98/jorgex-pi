// Windows-only seam: real win32 path/filesystem for the managed release proof.
// Raw targets split only on `/`, so a backslash chain must still fail closed.
import assert from "node:assert/strict";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  assertReleaseLockCoherence,
  createManagedReleaseSandbox,
  rebindManagedRelease,
  snapshotTree,
} from "./fixtures/native-managed-release.mjs";

const WINDOWS = process.platform === "win32";
const SKIP_REASON =
  `Windows-only seam: the managed release proof must run with the real ${process.platform} path and filesystem semantics; ` +
  "run it in the explicit Windows lane.";

function inspect(mcpModule, sandbox) {
  return mcpModule.inspectNativeMcpOwnership({
    env: sandbox.env,
    platform: process.platform,
    cwd: sandbox.root,
    projectTrusted: sandbox.projectTrusted,
  });
}

// A Windows lane without symlink capability would otherwise hide the whole seam.
// The probe fails the test explicitly instead of skipping it.
function assertWindowsSymlinkCapability(t) {
  const probeRoot = mkdtempSync(join(tmpdir(), "jorgex-pi-win-symlink-"));
  // Owned temporary tree: teardown registered immediately after the owned
  // mkdtemp and before any other IO, so it runs on success and failure alike.
  t.after(() => rmSync(probeRoot, { recursive: true, force: true }));
  const target = join(probeRoot, "target");
  mkdirSync(target);
  writeFileSync(join(target, "entry.dat"), "probe\n");
  let failure;
  try {
    symlinkSync(target, join(probeRoot, "dir-link"), "dir");
    symlinkSync(relative(probeRoot, join(target, "entry.dat")), join(probeRoot, "file-link"));
  } catch (error) {
    failure = error;
  }
  if (failure !== undefined) {
    assert.fail(
      `the Windows lane cannot create symlinks (${failure.code ?? failure.message}); ` +
        "enable Developer Mode or grant SeCreateSymbolicLinkPrivilege before running this seam",
    );
  }
}

test(
  "a coherent managed release verifies on real Windows with a physical relative active entry",
  { skip: WINDOWS ? false : SKIP_REASON },
  async (t) => {
    assertWindowsSymlinkCapability(t);
    const sandbox = createManagedReleaseSandbox(t);
    const before = snapshotTree(sandbox.root);
    assertReleaseLockCoherence(sandbox);

    // Physical root bind: the active entry is an actual relative symlink whose
    // realpath is the release package root.
    const rawTarget = readlinkSync(sandbox.linkPath);
    assert.equal(isAbsolute(rawTarget), false, "the active managed entry must be a relative symlink");
    assert.equal(
      lstatSync(sandbox.linkPath).isSymbolicLink(),
      true,
      "the active managed entry must be a symlink, not a copy",
    );
    assert.equal(
      realpathSync(sandbox.linkPath),
      realpathSync(sandbox.packageRoot),
      "the active entry must physically resolve to the release package root",
    );

    const mcpModule = await import(pathToFileURL(sandbox.entryModulePath).href);
    const result = await inspect(mcpModule, sandbox);

    assert.equal(
      result.package?.state,
      "verified",
      `a coherent managed release must verify on Windows: ${result.package?.reason ?? "no diagnostic"}`,
    );
    assert.equal(
      result.servers?.context7?.state,
      "managed",
      `the protected context7 claim must be managed on Windows: ${result.servers?.context7?.reason ?? "no diagnostic"}`,
    );
    assert.equal(result.servers?.context7?.cleanupEligible, true, "the wholly created claim stays cleanup-eligible");
    assert.equal(result.connection, "not-verified", "the checker never claims a live connection");
    assert.deepEqual(snapshotTree(sandbox.root), before, "the readonly checker must not write any file");
  },
);

// Plain contained relative link with native separators must never read as a chain.
test(
  "a plain contained relative link stays verified on real Windows",
  { skip: WINDOWS ? false : SKIP_REASON },
  async (t) => {
    assertWindowsSymlinkCapability(t);
    const sandbox = createManagedReleaseSandbox(t);
    // Build inside the current release dir and keep only RELATIVE locations:
    // `rebindManagedRelease` renames the release to its new id, so an absolute
    // path captured before the rename would be stale.
    const libDirRel = join("node_modules", "lib");
    const libFileRel = join(libDirRel, "entry.dat");
    const binDirRel = join("node_modules", ".bin");
    const linkRel = join(binDirRel, "entry");
    mkdirSync(join(sandbox.releaseDir, libDirRel), { recursive: true });
    writeFileSync(join(sandbox.releaseDir, libFileRel), "fixture entry\n");
    mkdirSync(join(sandbox.releaseDir, binDirRel), { recursive: true });
    // The expected raw target is the platform's own `path.relative` output, so
    // Windows stores and returns it with backslash separators. The expectation is
    // derived independently, never recomputed from the checker.
    const rawTarget = relative(join(sandbox.releaseDir, binDirRel), join(sandbox.releaseDir, libFileRel));
    symlinkSync(rawTarget, join(sandbox.releaseDir, linkRel));
    rebindManagedRelease(sandbox);

    // Re-derive every absolute path from the rebound release dir.
    const link = join(sandbox.releaseDir, linkRel);
    assert.equal(rawTarget.includes("\\"), true, `the Windows raw target must use backslash separators: ${rawTarget}`);
    assert.equal(readlinkSync(link), rawTarget, "the plain link keeps its raw sys-native relative target");
    assert.equal(lstatSync(link).isSymbolicLink(), true, "the case needs a real contained symlink");
    assert.equal(
      lstatSync(join(sandbox.releaseDir, libFileRel)).isFile(),
      true,
      "the link target must be a regular file",
    );
    assert.equal(
      JSON.parse(readFileSync(sandbox.receiptPath, "utf8")).managedPackage.treeSha256,
      sandbox.treeSha256,
      "the rebound receipt must carry the mutated tree hash",
    );
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
  },
);

// Chained walk through a backslash raw target must fail closed even with a matching tree hash.
test(
  "an intermediate directory symlink reached through a raw backslash target must conflict on real Windows",
  { skip: WINDOWS ? false : SKIP_REASON },
  async (t) => {
    assertWindowsSymlinkCapability(t);
    const sandbox = createManagedReleaseSandbox(t);

    // Build inside the current release dir and keep only RELATIVE locations:
    // `rebindManagedRelease` renames the release to its new id, so an absolute
    // path captured before the rename would be stale.
    const packageRootRel = relative(sandbox.releaseDir, sandbox.packageRoot);
    const payloadRel = join(packageRootRel, "extensions", "payload");
    const libLinkRel = join("node_modules", "lib-link");
    const binDirRel = join("node_modules", ".bin");
    const linkRel = join(binDirRel, "through-link");
    mkdirSync(join(sandbox.releaseDir, payloadRel), { recursive: true });
    writeFileSync(join(sandbox.releaseDir, payloadRel, "entry.dat"), "fixture payload\n");
    symlinkSync("jorgex-pi/extensions/payload", join(sandbox.releaseDir, libLinkRel));
    mkdirSync(join(sandbox.releaseDir, binDirRel), { recursive: true });
    // The raw target is exactly the platform's own `path.relative` output, so on
    // Windows it carries backslash separators. Its relative geometry survives the
    // release rename, so it stays valid after the rebind.
    const rawTarget = relative(
      join(sandbox.releaseDir, binDirRel),
      join(sandbox.releaseDir, libLinkRel, "entry.dat"),
    );
    symlinkSync(rawTarget, join(sandbox.releaseDir, linkRel));
    rebindManagedRelease(sandbox);

    // Re-derive every absolute path from the rebound release dir.
    const link = join(sandbox.releaseDir, linkRel);
    const libLink = join(sandbox.releaseDir, libLinkRel);
    assert.equal(rawTarget.includes("\\"), true, `the Windows raw target must use backslash separators: ${rawTarget}`);
    assert.equal(rawTarget.includes("/"), false, `the Windows raw target must not use forward slashes: ${rawTarget}`);
    assert.equal(readlinkSync(link), rawTarget, "the raw backslash target must be preserved verbatim");
    assert.equal(lstatSync(link).isSymbolicLink(), true, "the case needs a symlink that walks through another symlink");
    assert.equal(
      lstatSync(libLink).isSymbolicLink(),
      true,
      "the intermediate component must be a directory symlink",
    );
    assert.equal(
      lstatSync(join(libLink, "entry.dat")).isFile(),
      true,
      "the final component under the chained walk must be a regular file",
    );

    // Fixture isolation: the mutated bytes are rebound, so the only remaining
    // defect is the topology itself.
    assertReleaseLockCoherence(sandbox);
    const receipt = JSON.parse(readFileSync(sandbox.receiptPath, "utf8"));
    assert.equal(receipt.managedPackage.treeSha256, sandbox.treeSha256, "the rebound receipt must carry the mutated tree hash");
    assert.equal(receipt.managedPackage.lockSha256, sandbox.lockSha256, "the rebound receipt must carry the mutated lock hash");

    const before = snapshotTree(sandbox.root);
    const mcpModule = await import(pathToFileURL(sandbox.entryModulePath).href);
    const result = await inspect(mcpModule, sandbox);

    assert.equal(
      result.package?.state,
      "conflict",
      `a chained symlink must fail closed on Windows even with a matching tree hash: ${result.package?.reason ?? "no diagnostic"}`,
    );
    assert.equal(
      result.servers?.context7?.state,
      "conflict",
      "a claim cannot be managed from a chained release",
    );
    assert.deepEqual(snapshotTree(sandbox.root), before, "the readonly checker must not write any file");
  },
);
