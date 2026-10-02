import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { afterEach, describe, it } from "node:test";
import {
  PNPM_FAIL_CLOSED,
  PNPM_PM_ON_FAIL_ENV,
  PNPM_VERIFY_DEPS_ENV,
  PREPARED_PNPM_ENTRY_ENV,
  VERIFICATION_DISK_ROOT_ENV,
  cleanupOwnedRoots,
  cleanupOwnedProcesses,
  createVerificationSandbox,
  assertDiskBackedFilesystem,
  killProcessTree,
  packProjectTarball,
  preparePnpmPackRun,
  readPnpmPackageMetadata,
  resolvePnpmPackInvocation,
  resolvePreparedEntry,
  resolveVerificationDiskBase,
  runBoundedProcess,
} from "./helpers/pnpm-tooling.mjs";

/**
 * Authoritative regression for the shared exact-pnpm selector.
 *
 * The five Pi packaging callers used to resolve `pnpm` through Corepack or an
 * ambiguous PATH fallback, with no identity/version check and no bounded pack.
 * Running an old, unverified pnpm is what allowed the recursive version
 * switch/acquisition that exhausted resources. This suite intercepts process
 * creation through an injected runner, so it exercises the selection and the pack
 * contract without ever reproducing the dangerous chain.
 */

const testDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(testDir, "..");
const REQUIRED_VERSION = "11.22.0";
const tempRoots = [];
const protectedRoots = new Set();

afterEach(() => {
  for (const directory of tempRoots.splice(0)) {
    // Roots whose cleanup could not be confirmed are retained, never faked clean.
    if (protectedRoots.has(directory)) continue;
    rmSync(directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 25 });
  }
});

function makeTempRoot(prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(directory);
  return directory;
}

function makeRepo(packageManager) {
  const directory = makeTempRoot("jorgex-pi-pnpm-repo-");
  writeFileSync(
    join(directory, "package.json"),
    `${JSON.stringify({ name: "fixture", packageManager })}\n`,
    "utf8",
  );
  return directory;
}

/** Parent for verification fixtures; validation happens before any write. */
function makeDiskBase() {
  const override = process.env[VERIFICATION_DISK_ROOT_ENV]?.trim();
  // Validate an existing, disk-backed, contained base (realpath/statfs/
  // containment) BEFORE creating anything. Invalid overrides never write.
  const base = resolveVerificationDiskBase({
    repoRoot: root,
    env: override ? { [VERIFICATION_DISK_ROOT_ENV]: override } : {},
  });
  const directory = join(base, `jorgex-pi-verify-base-${process.pid}-${randomUUID().slice(0, 8)}`);
  tempRoots.push(directory); // arm ownership before the exclusive mkdir
  mkdirSync(directory); // exclusive child only; never create unmanaged parents
  return directory;
}

function makePnpmPackage(version, options = {}) {
  const packageRoot = join(makeTempRoot("jorgex-pi-pnpm-pkg-"), "node_modules", "pnpm");
  mkdirSync(join(packageRoot, "bin"), { recursive: true });
  writeFileSync(join(packageRoot, "bin", "pnpm.mjs"), "#!/usr/bin/env node\n", "utf8");
  writeFileSync(join(packageRoot, "bin", "pnpm.cjs"), "// compat stub\n", "utf8");
  writeFileSync(
    join(packageRoot, "package.json"),
    `${JSON.stringify({
      name: options.name ?? "pnpm",
      version,
      bin: { pnpm: options.binName ?? "bin/pnpm.mjs" },
    })}\n`,
    "utf8",
  );
  return { packageRoot, entry: join(packageRoot, "bin", "pnpm.mjs") };
}

function recordingRunner(result = {}) {
  const calls = [];
  const run = async (invocation, options) => {
    calls.push({ invocation, options });
    return {
      status: 0,
      signal: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      ...result,
    };
  };
  return { calls, run };
}

describe("shared exact pnpm selector", () => {
  it("resolves the declared bin and verifies --version through the bounded runner with guards", async () => {
    const repoRoot = makeRepo(`pnpm@${REQUIRED_VERSION}`);
    const pnpm = makePnpmPackage(REQUIRED_VERSION);
    const runner = recordingRunner({ stdout: `${REQUIRED_VERSION}\n` });

    const resolved = await resolvePnpmPackInvocation({
      repoRoot,
      env: { [PREPARED_PNPM_ENTRY_ENV]: pnpm.entry },
      runProcess: runner.run,
      versionCheckTimeoutMs: 1_000,
    });

    assert.equal(runner.calls.length, 1);
    const check = runner.calls[0];
    assert.equal(check.invocation.command, process.execPath);
    assert.deepEqual(check.invocation.args, [pnpm.entry, "--version"]);
    assert.equal(check.options.cwd, repoRoot);
    assert.equal(check.options.timeoutMs, 1_000);
    assert.equal(check.options.env[PNPM_PM_ON_FAIL_ENV], PNPM_FAIL_CLOSED);
    assert.equal(check.options.env[PNPM_VERIFY_DEPS_ENV], PNPM_FAIL_CLOSED);

    assert.equal(resolved.command, process.execPath);
    assert.deepEqual(resolved.args, [pnpm.entry]);
    assert.equal(resolved.env[PNPM_PM_ON_FAIL_ENV], PNPM_FAIL_CLOSED);
    assert.equal(resolved.env[PNPM_VERIFY_DEPS_ENV], PNPM_FAIL_CLOSED);
  });

  it("forces the pnpm 11 fail-closed guards so no implicit install or version download can run", async () => {
    const repoRoot = makeRepo(`pnpm@${REQUIRED_VERSION}`);
    const pnpm = makePnpmPackage(REQUIRED_VERSION);
    const runner = recordingRunner({ stdout: `${REQUIRED_VERSION}\n` });

    const resolved = await resolvePnpmPackInvocation({
      repoRoot,
      env: {
        [PREPARED_PNPM_ENTRY_ENV]: pnpm.entry,
        [PNPM_VERIFY_DEPS_ENV]: "install",
        [PNPM_PM_ON_FAIL_ENV]: "download",
      },
      runProcess: runner.run,
      versionCheckTimeoutMs: 1_000,
    });

    const checkEnv = runner.calls[0].options.env;
    assert.equal(checkEnv[PNPM_VERIFY_DEPS_ENV], PNPM_FAIL_CLOSED);
    assert.equal(checkEnv[PNPM_PM_ON_FAIL_ENV], PNPM_FAIL_CLOSED);
    assert.equal(resolved.env[PNPM_VERIFY_DEPS_ENV], PNPM_FAIL_CLOSED);
    assert.equal(resolved.env[PNPM_PM_ON_FAIL_ENV], PNPM_FAIL_CLOSED);
    assert.equal(Object.hasOwn(resolved.env, "npm_config_manage_package_manager_versions"), false);
  });

  it("resolves the declared bin even when the prepared entrypoint is the .cjs stub", async () => {
    const repoRoot = makeRepo(`pnpm@${REQUIRED_VERSION}`);
    const pnpm = makePnpmPackage(REQUIRED_VERSION);
    const runner = recordingRunner({ stdout: `${REQUIRED_VERSION}\n` });

    const resolved = await resolvePnpmPackInvocation({
      repoRoot,
      env: { [PREPARED_PNPM_ENTRY_ENV]: join(pnpm.packageRoot, "bin", "pnpm.cjs") },
      runProcess: runner.run,
      versionCheckTimeoutMs: 1_000,
    });

    assert.deepEqual(runner.calls[0].invocation.args, [pnpm.entry, "--version"]);
    assert.deepEqual(resolved.args, [pnpm.entry]);
  });

  it("rejects a prepared pnpm with a different metadata version before creating any process", async () => {
    const repoRoot = makeRepo(`pnpm@${REQUIRED_VERSION}`);
    const pnpm = makePnpmPackage("11.1.1");
    const runner = recordingRunner({ stdout: "11.1.1\n" });

    await assert.rejects(
      resolvePnpmPackInvocation({
        repoRoot,
        env: { [PREPARED_PNPM_ENTRY_ENV]: pnpm.entry },
        runProcess: runner.run,
        versionCheckTimeoutMs: 1_000,
      }),
      /11\.1\.1[\s\S]*11\.22\.0|11\.22\.0[\s\S]*11\.1\.1/,
    );
    assert.equal(runner.calls.length, 0);
  });

  it("rejects a missing or nonexistent prepared entrypoint without Corepack or PATH fallback", async () => {
    const repoRoot = makeRepo(`pnpm@${REQUIRED_VERSION}`);
    const runner = recordingRunner();

    await assert.rejects(
      resolvePnpmPackInvocation({
        repoRoot,
        env: {},
        runProcess: runner.run,
        versionCheckTimeoutMs: 1_000,
      }),
      new RegExp(PREPARED_PNPM_ENTRY_ENV),
    );

    await assert.rejects(
      resolvePnpmPackInvocation({
        repoRoot,
        env: { [PREPARED_PNPM_ENTRY_ENV]: join(repoRoot, "missing", "pnpm.mjs") },
        runProcess: runner.run,
        versionCheckTimeoutMs: 1_000,
      }),
      /missing[\\/]pnpm\.mjs/,
    );
    assert.equal(runner.calls.length, 0);
  });

  it("rejects an entrypoint that does not declare the pnpm package", async () => {
    const repoRoot = makeRepo(`pnpm@${REQUIRED_VERSION}`);
    const pnpm = makePnpmPackage(REQUIRED_VERSION, { name: "pnpm-compat" });
    const runner = recordingRunner({ stdout: `${REQUIRED_VERSION}\n` });

    await assert.rejects(
      resolvePnpmPackInvocation({
        repoRoot,
        env: { [PREPARED_PNPM_ENTRY_ENV]: pnpm.entry },
        runProcess: runner.run,
        versionCheckTimeoutMs: 1_000,
      }),
      /pnpm/,
    );
    assert.equal(runner.calls.length, 0);
  });

  it("rejects when --version reports another version even if metadata matches", async () => {
    const repoRoot = makeRepo(`pnpm@${REQUIRED_VERSION}`);
    const pnpm = makePnpmPackage(REQUIRED_VERSION);
    const runner = recordingRunner({ stdout: "10.0.0\n" });

    await assert.rejects(
      resolvePnpmPackInvocation({
        repoRoot,
        env: { [PREPARED_PNPM_ENTRY_ENV]: pnpm.entry },
        runProcess: runner.run,
        versionCheckTimeoutMs: 1_000,
      }),
      /10\.0\.0/,
    );
    assert.equal(runner.calls.length, 1);
  });

  it("rejects a packageManager with a range or hash instead of an exact version", async () => {
    const runner = recordingRunner();
    for (const spec of ["pnpm@^11.22.0", `pnpm@${REQUIRED_VERSION}+sha512.abc`]) {
      const repoRoot = makeRepo(spec);
      await assert.rejects(
        resolvePnpmPackInvocation({
          repoRoot,
          env: { [PREPARED_PNPM_ENTRY_ENV]: join(repoRoot, "pnpm.mjs") },
          runProcess: runner.run,
          versionCheckTimeoutMs: 1_000,
        }),
        /packageManager/,
      );
    }
    assert.equal(runner.calls.length, 0);
  });

  it("requires an exact --version output and rejects noise", async () => {
    const repoRoot = makeRepo(`pnpm@${REQUIRED_VERSION}`);
    const pnpm = makePnpmPackage(REQUIRED_VERSION);
    const runner = recordingRunner({ stdout: `warn: old node\n${REQUIRED_VERSION}\n` });

    await assert.rejects(
      resolvePnpmPackInvocation({
        repoRoot,
        env: { [PREPARED_PNPM_ENTRY_ENV]: pnpm.entry },
        runProcess: runner.run,
        versionCheckTimeoutMs: 1_000,
      }),
      /exact/i,
    );
    assert.equal(runner.calls.length, 1);
  });

  it("never creates an install, acquisition or corepack process", async () => {
    const repoRoot = makeRepo(`pnpm@${REQUIRED_VERSION}`);
    const pnpm = makePnpmPackage(REQUIRED_VERSION);
    const runner = recordingRunner({ stdout: `${REQUIRED_VERSION}\n` });

    await resolvePnpmPackInvocation({
      repoRoot,
      env: { [PREPARED_PNPM_ENTRY_ENV]: pnpm.entry },
      runProcess: runner.run,
      versionCheckTimeoutMs: 1_000,
    });

    for (const call of runner.calls) {
      assert.equal(call.invocation.command, process.execPath);
      assert.doesNotMatch(call.invocation.command, /corepack|pnpm|npm|npx/i);
      assert.equal(call.invocation.args[0], pnpm.entry);
      assert.equal(call.invocation.args[1], "--version");
      assert.equal(call.invocation.args.includes("install"), false);
      assert.equal(call.invocation.args.includes("add"), false);
    }
  });

  it("uses npm_execpath as the prepared entrypoint when no explicit override is present", async () => {
    const repoRoot = makeRepo(`pnpm@${REQUIRED_VERSION}`);
    const pnpm = makePnpmPackage(REQUIRED_VERSION);
    const runner = recordingRunner({ stdout: `${REQUIRED_VERSION}\n` });

    const resolved = await resolvePnpmPackInvocation({
      repoRoot,
      env: { npm_execpath: pnpm.entry },
      runProcess: runner.run,
      versionCheckTimeoutMs: 1_000,
    });

    assert.deepEqual(resolved.args, [pnpm.entry]);
  });

  it("resolves the declared package through a symlinked entrypoint", { skip: process.platform === "win32" }, async () => {
    const repoRoot = makeRepo(`pnpm@${REQUIRED_VERSION}`);
    const pnpm = makePnpmPackage(REQUIRED_VERSION);
    const link = join(makeTempRoot("jorgex-pi-pnpm-link-"), "pnpm");
    symlinkSync(pnpm.entry, link);
    const runner = recordingRunner({ stdout: `${REQUIRED_VERSION}\n` });

    const resolved = await resolvePnpmPackInvocation({
      repoRoot,
      env: { npm_execpath: link },
      runProcess: runner.run,
      versionCheckTimeoutMs: 1_000,
    });

    assert.deepEqual(resolved.args, [pnpm.entry]);
    assert.deepEqual(runner.calls[0].invocation.args, [pnpm.entry, "--version"]);
  });

  it("preserves the already-isolated environment while adding the fail-closed guards", async () => {
    const repoRoot = makeRepo(`pnpm@${REQUIRED_VERSION}`);
    const pnpm = makePnpmPackage(REQUIRED_VERSION);
    const runner = recordingRunner({ stdout: `${REQUIRED_VERSION}\n` });
    const isolatedHome = join(makeTempRoot("jorgex-pi-pnpm-home-"), "home");

    const resolved = await resolvePnpmPackInvocation({
      repoRoot,
      env: { [PREPARED_PNPM_ENTRY_ENV]: pnpm.entry, HOME: isolatedHome, TEMP: isolatedHome },
      runProcess: runner.run,
      versionCheckTimeoutMs: 1_000,
    });

    const checkEnv = runner.calls[0].options.env;
    assert.equal(checkEnv.HOME, isolatedHome);
    assert.equal(checkEnv.TEMP, isolatedHome);
    assert.equal(checkEnv[PNPM_VERIFY_DEPS_ENV], PNPM_FAIL_CLOSED);
    assert.equal(checkEnv[PNPM_PM_ON_FAIL_ENV], PNPM_FAIL_CLOSED);
    assert.equal(resolved.env.HOME, isolatedHome);
    assert.equal(resolved.env[PNPM_VERIFY_DEPS_ENV], PNPM_FAIL_CLOSED);
    assert.equal(resolved.env[PNPM_PM_ON_FAIL_ENV], PNPM_FAIL_CLOSED);
  });

  it("exposes package metadata only for the real pnpm package and resolves realpath first", () => {
    const pnpm = makePnpmPackage(REQUIRED_VERSION);
    const metadata = readPnpmPackageMetadata(pnpm.entry);
    assert.ok(metadata, "the prepared entrypoint must declare package metadata");
    assert.equal(metadata.version, REQUIRED_VERSION);
    assert.equal(metadata.binPath, pnpm.entry);

    assert.equal(readPnpmPackageMetadata(join(pnpm.packageRoot, "bin", "pnpm.cjs")).binPath, pnpm.entry);
    assert.equal(readPnpmPackageMetadata(join(makeTempRoot("jorgex-pi-absent-"), "nope.mjs")), undefined);
  });

  it("rejects a prepared entrypoint that is not an absolute path", () => {
    assert.throws(() => resolvePreparedEntry({ [PREPARED_PNPM_ENTRY_ENV]: "pnpm.mjs" }), /absolut/i);
  });
});

describe("verification isolation and bounded pack", () => {
  it("resolves a disk base and rejects workspace, node_modules and worktrees", () => {
    const diskBase = makeDiskBase();

    assert.equal(
      resolveVerificationDiskBase({ repoRoot: root, env: { [VERIFICATION_DISK_ROOT_ENV]: diskBase } }),
      diskBase,
    );

    assert.throws(
      () => resolveVerificationDiskBase({ repoRoot: root, env: { [VERIFICATION_DISK_ROOT_ENV]: root } }),
      /workspace/i,
    );

    const underNodeModules = join(diskBase, "node_modules");
    mkdirSync(underNodeModules, { recursive: true });
    assert.throws(
      () => resolveVerificationDiskBase({ repoRoot: root, env: { [VERIFICATION_DISK_ROOT_ENV]: underNodeModules } }),
      /node_modules/,
    );

    const underWorktrees = join(diskBase, "worktrees");
    mkdirSync(underWorktrees, { recursive: true });
    assert.throws(
      () => resolveVerificationDiskBase({ repoRoot: root, env: { [VERIFICATION_DISK_ROOT_ENV]: underWorktrees } }),
      /worktrees/,
    );

    assert.throws(
      () =>
        resolveVerificationDiskBase({
          repoRoot: root,
          env: { [VERIFICATION_DISK_ROOT_ENV]: join(diskBase, "does-not-exist") },
        }),
      /no es un directorio existente/,
    );
  });

  it("fails closed on RAM and on unknown filesystem probes instead of assuming disk", () => {
    const diskMagic = 0x9123683e; // btrfs-like, any non-RAM type is accepted
    assert.equal(assertDiskBackedFilesystem({ target: "/disk", fsType: diskMagic }), diskMagic);
    assert.throws(() => assertDiskBackedFilesystem({ target: "/ram", fsType: 0x01021994 }), /RAM/);
    assert.throws(() => assertDiskBackedFilesystem({ target: "/ram", fsType: 0x858458f6 }), /RAM/);
    assert.throws(() => assertDiskBackedFilesystem({ target: "/unknown", fsType: 0 }), /filesystem|desconoc/i);
    assert.throws(() => assertDiskBackedFilesystem({ target: "/unknown", fsType: undefined }), /filesystem|desconoc/i);
  });

  it("resolves an existing verified disk base without creating an unvalidated base", () => {
    const resolved = resolveVerificationDiskBase({ repoRoot: root, env: {} });
    assert.equal(resolved, resolve(resolved), "the default base must already exist, not be created on demand");
    assert.equal(existsSync(resolved), true);
  });

  it("resolves the exact tool before creating the private disk HOME and preserves the guards", async () => {
    const repoRoot = makeRepo(`pnpm@${REQUIRED_VERSION}`);
    const pnpm = makePnpmPackage(REQUIRED_VERSION);
    const diskBase = makeDiskBase();
    const ambientHome = join(makeTempRoot("jorgex-pi-ambient-home-"), "home");
    const sequence = [];
    const existedAtRegistration = [];
    const baseRunner = recordingRunner({ stdout: `${REQUIRED_VERSION}\n` });
    const runProcess = async (invocation, options) => {
      sequence.push("preflight");
      return baseRunner.run(invocation, options);
    };

    const prepared = await preparePnpmPackRun({
      repoRoot,
      env: {
        [PREPARED_PNPM_ENTRY_ENV]: pnpm.entry,
        [VERIFICATION_DISK_ROOT_ENV]: diskBase,
        HOME: ambientHome,
      },
      runProcess,
      versionCheckTimeoutMs: 1_000,
      registerRoot: (created) => {
        sequence.push("home");
        existedAtRegistration.push(existsSync(created));
        tempRoots.push(created);
      },
    });

    assert.deepEqual(sequence, ["preflight", "home"]);
    assert.deepEqual(existedAtRegistration, [false]);
    assert.equal(baseRunner.calls.length, 1);
    assert.equal(baseRunner.calls[0].options.env.HOME, ambientHome);
    assert.equal(baseRunner.calls[0].options.env[PNPM_VERIFY_DEPS_ENV], PNPM_FAIL_CLOSED);
    assert.equal(baseRunner.calls[0].options.env[PNPM_PM_ON_FAIL_ENV], PNPM_FAIL_CLOSED);

    assert.deepEqual(prepared.invocation.args, [pnpm.entry, "pack", "--pack-destination", prepared.packDir]);
    assert.equal(prepared.env.HOME, join(prepared.root, "home"));
    assert.notEqual(prepared.env.HOME, ambientHome);
    assert.equal(prepared.env[PNPM_VERIFY_DEPS_ENV], PNPM_FAIL_CLOSED);
    assert.equal(prepared.env[PNPM_PM_ON_FAIL_ENV], PNPM_FAIL_CLOSED);
    assert.equal(prepared.root.startsWith(diskBase), true);
  });

  it("replaces ambient HOME and XDG roots with private owned roots before pack", async () => {
    const repoRoot = makeRepo(`pnpm@${REQUIRED_VERSION}`);
    const pnpm = makePnpmPackage(REQUIRED_VERSION);
    const diskBase = makeDiskBase();
    const ambient = "/ambient/state/that/must/not/leak";
    const runner = recordingRunner({ stdout: `${REQUIRED_VERSION}\n` });

    const prepared = await preparePnpmPackRun({
      repoRoot,
      env: {
        [PREPARED_PNPM_ENTRY_ENV]: pnpm.entry,
        [VERIFICATION_DISK_ROOT_ENV]: diskBase,
        HOME: ambient,
        XDG_CONFIG_HOME: ambient,
        XDG_CACHE_HOME: ambient,
        XDG_DATA_HOME: ambient,
      },
      runProcess: runner.run,
      versionCheckTimeoutMs: 1_000,
      registerRoot: (created) => tempRoots.push(created),
    });

    for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME"]) {
      assert.notEqual(prepared.env[key], ambient, `${key} must not keep the ambient value`);
      assert.equal(prepared.env[key].startsWith(prepared.root), true, `${key} must live under the owned root`);
    }
  });

  it("fails closed with the unexpected cause when the prepared package metadata is unreadable", () => {
    const packageRoot = join(makeTempRoot("jorgex-pi-broken-pkg-"), "node_modules", "pnpm");
    mkdirSync(join(packageRoot, "bin"), { recursive: true });
    writeFileSync(join(packageRoot, "bin", "pnpm.mjs"), "#!/usr/bin/env node\n", "utf8");
    writeFileSync(join(packageRoot, "package.json"), "{ this is not json", "utf8");

    assert.throws(
      () => readPnpmPackageMetadata(join(packageRoot, "bin", "pnpm.mjs")),
      /metadata|json|ilegible/i,
    );
  });

  it("runs a real bounded pack through the exact selector and returns the single tarball", async () => {
    const repoRoot = makeRepo(`pnpm@${REQUIRED_VERSION}`);
    const pnpm = makePnpmPackageWithBehavior(REQUIRED_VERSION, makeDiskBase());
    const diskBase = makeDiskBase();

    const packed = await packProjectTarball({
      repoRoot,
      env: {
        [PREPARED_PNPM_ENTRY_ENV]: pnpm.entry,
        [VERIFICATION_DISK_ROOT_ENV]: diskBase,
      },
      versionCheckTimeoutMs: 5_000,
      timeoutMs: 10_000,
      registerRoot: (created) => tempRoots.push(created),
    });

    assert.equal(existsSync(packed.tarball), true);
    assert.match(packed.tarball, /\.tgz$/);
  });

  it("kills the owned process group on timeout so no descendant survives", { skip: process.platform === "win32" }, async () => {
    const repoRoot = makeRepo(`pnpm@${REQUIRED_VERSION}`);
    const descendantRoot = makeDiskBase();
    const pidFile = join(descendantRoot, "grandchild.pid");
    const pnpm = makePnpmPackageWithBehavior(REQUIRED_VERSION, descendantRoot, { hang: true, pidFile });
    const diskBase = makeDiskBase();

    const pending = packProjectTarball({
      repoRoot,
      env: { [PREPARED_PNPM_ENTRY_ENV]: pnpm.entry, [VERIFICATION_DISK_ROOT_ENV]: diskBase },
      versionCheckTimeoutMs: 5_000,
      timeoutMs: 2_500,
      registerRoot: (created) => tempRoots.push(created),
    });

    const grandchildPid = await waitForPidFile(pidFile, 4_000);
    await assert.rejects(pending, /timed out|timeout|bounded/i);
    await waitForExitOf(grandchildPid, 5_000);
    assert.equal(isAlive(grandchildPid), false, `descendant ${grandchildPid} must not survive the bounded pack`);
  });

  it("kills the owned process group after an inert leader exits successfully", { skip: process.platform === "win32" }, async () => {
    const repoRoot = makeRepo(`pnpm@${REQUIRED_VERSION}`);
    const workRoot = makeDiskBase();
    const pidFile = join(workRoot, "leader-exit-child.pid");
    const pnpm = makePnpmPackageWithBehavior(REQUIRED_VERSION, workRoot, { leaderExits: true, pidFile });
    const diskBase = makeDiskBase();

    const packed = await packProjectTarball({
      repoRoot,
      env: { [PREPARED_PNPM_ENTRY_ENV]: pnpm.entry, [VERIFICATION_DISK_ROOT_ENV]: diskBase },
      versionCheckTimeoutMs: 5_000,
      timeoutMs: 10_000,
      registerRoot: (created) => tempRoots.push(created),
    });

    assert.match(packed.tarball, /\.tgz$/);
    const survivorPid = readPidFile(pidFile);
    await waitForExitOf(survivorPid, 5_000);
    assert.equal(isAlive(survivorPid), false, `descendant ${survivorPid} of an exited leader must not survive the pack`);
  });

  it("invokes the owned tree killer on timeout through the injected seam on any platform", async () => {
    const repoRoot = makeRepo(`pnpm@${REQUIRED_VERSION}`);
    const workRoot = makeDiskBase();
    const pidFile = join(workRoot, "di-timeout.pid");
    const pnpm = makePnpmPackageWithBehavior(REQUIRED_VERSION, workRoot, { hang: true, pidFile });
    const calls = [];
    const killTree = (child) => {
      calls.push(child.pid);
      return killProcessTree(child);
    };

    const result = await runBoundedProcess(
      { command: process.execPath, args: [pnpm.entry, "pack", "--pack-destination", join(makeDiskBase(), "out")] },
      { cwd: repoRoot, env: process.env, timeoutMs: 1_200, killTree },
    );

    assert.equal(result.timedOut, true);
    assert.ok(calls.length >= 1, "the bounded runner must invoke the owned tree killer on timeout");
    assert.equal(result.cleanupError, undefined, "a successful owned-tree kill must not report a cleanup error");
    const survivorPid = readPidFile(pidFile);
    await waitForExitOf(survivorPid, 5_000);
    assert.equal(isAlive(survivorPid), false);
  });

  it("reports an explicit cleanup error and retains ownership when the killer fails", async () => {
    const repoRoot = makeRepo(`pnpm@${REQUIRED_VERSION}`);
    const workRoot = makeDiskBase();
    const pidFile = join(workRoot, "di-fail.pid");
    const pnpm = makePnpmPackageWithBehavior(REQUIRED_VERSION, workRoot, { hang: true, pidFile });
    let seenPid;
    const killTree = (child) => {
      seenPid = child.pid;
      killProcessTree(child); // really kill the owned child so nothing leaks
      return { killed: false, pid: child.pid, error: new Error("simulated kill failure") };
    };

    const result = await runBoundedProcess(
      { command: process.execPath, args: [pnpm.entry, "pack", "--pack-destination", join(makeDiskBase(), "out")] },
      { cwd: repoRoot, env: process.env, timeoutMs: 1_000, killTree },
    );

    assert.equal(result.timedOut, true);
    assert.ok(seenPid, "the killer must receive the owned child");
    assert.ok(result.cleanupError instanceof Error, "a failed kill must be exposed");
    assert.match(result.cleanupError.message, /simulated kill failure/);
    const survivorPid = readPidFile(pidFile);
    await waitForExitOf(survivorPid, 5_000);
    assert.equal(isAlive(survivorPid), false);
  });

  it("propagates an unverifiable preflight cleanup error before registering the private HOME", async () => {
    const repoRoot = makeRepo(`pnpm@${REQUIRED_VERSION}`);
    const pnpm = makePnpmPackage(REQUIRED_VERSION);
    const registered = [];
    const runner = async () => ({
      status: 0,
      signal: null,
      stdout: `${REQUIRED_VERSION}\n`,
      stderr: "",
      timedOut: false,
      cleanupError: new Error("unverifiable tree"),
    });

    await assert.rejects(
      preparePnpmPackRun({
        repoRoot,
        env: { [PREPARED_PNPM_ENTRY_ENV]: pnpm.entry },
        runProcess: runner,
        versionCheckTimeoutMs: 1_000,
        registerRoot: (created) => registered.push(created),
      }),
      /unverifiable tree/,
    );
    assert.deepEqual(registered, []);
  });

  it("tracks no process when spawn never produced a pid and never fakes a tree", async () => {
    const result = await runBoundedProcess(
      { command: join(makeTempRoot("jorgex-pi-missing-bin-"), "node-that-does-not-exist"), args: [] },
      { cwd: makeDiskBase(), env: process.env, timeoutMs: 1_000 },
    );

    assert.ok(result.error instanceof Error, "a spawn failure must surface its error");
    assert.equal(result.cleanupError, undefined, "no real process means no tree cleanup failure");
    assert.doesNotThrow(() => cleanupOwnedProcesses());
  });

  it("fails closed before spawning on Windows where cancellation cannot be verified", { skip: process.platform !== "win32" }, async () => {
    const repoRoot = makeRepo(`pnpm@${REQUIRED_VERSION}`);
    const pnpm = makePnpmPackage(REQUIRED_VERSION);

    await assert.rejects(
      runBoundedProcess(
        { command: process.execPath, args: [pnpm.entry, "--version"] },
        { cwd: repoRoot, env: process.env, timeoutMs: 5_000 },
      ),
      /Windows|no puede verificarse/i,
    );
  });

  it("retains and reports an owned root when its cleanup fails instead of discarding it", () => {
    const base = makeDiskBase();
    const sandbox = createVerificationSandbox({
      repoRoot: root,
      env: { [VERIFICATION_DISK_ROOT_ENV]: base },
      prefix: "jorgex-pi-retain-",
    });
    chmodSync(base, 0o500);
    try {
      assert.throws(() => cleanupOwnedRoots(), /No se pudieron limpiar/);
      assert.equal(existsSync(sandbox.root), true, "a root whose cleanup failed must stay tracked on disk");
    } finally {
      chmodSync(base, 0o700);
    }
    cleanupOwnedRoots();
    assert.equal(existsSync(sandbox.root), false);
  });

  it("cleans every owned root and reports a failure to remove instead of pretending", () => {
    const sandbox = createVerificationSandbox({
      repoRoot: root,
      env: { [VERIFICATION_DISK_ROOT_ENV]: makeDiskBase() },
      prefix: "jorgex-pi-cleanup-",
    });
    assert.equal(existsSync(sandbox.root), true);
    cleanupOwnedRoots();
    assert.equal(existsSync(sandbox.root), false);
  });
});

describe("cancellation ownership", () => {
  it("fails closed inside a worker_thread where process signals are unavailable", async () => {
    const workerCode = [
      'const { parentPort } = require("node:worker_threads");',
      `import(${JSON.stringify(helperUrl())}).then(async ({ runBoundedProcess }) => {`,
      "  try {",
      '    await runBoundedProcess({ command: process.execPath, args: ["-e", "0"] }, { cwd: process.cwd(), env: process.env, timeoutMs: 1000 });',
      "    parentPort.postMessage({ rejected: false });",
      "  } catch (error) {",
      "    parentPort.postMessage({ rejected: true, message: String((error && error.message) || error) });",
      "  }",
      "});",
    ].join("\n");
    const worker = new Worker(workerCode, { eval: true });
    try {
      const message = await new Promise((resolvePromise, reject) => {
        worker.once("message", resolvePromise);
        worker.once("error", reject);
      });
      assert.equal(message.rejected, true, "a worker_thread must fail closed before spawning");
      assert.match(message.message, /worker_thread|no puede verificarse/i);
    } finally {
      await finalizeOwnedHarness(worker, { label: "worker_threads" });
    }
  });

  it("cancels preflight before the first root exists and preserves a foreign signal handler", { skip: process.platform === "win32" }, async () => {
    const repoRoot = makeRepo(`pnpm@${REQUIRED_VERSION}`);
    const workRoot = makeDiskBase();
    const pidFile = join(workRoot, "cancel-foreign.pid");
    const markerFile = join(workRoot, "foreign.marker");
    const pnpm = makePnpmPackageWithBehavior(REQUIRED_VERSION, workRoot, { inertWorker: true, pidFile });
    const script = writeHarness("cancel-foreign", cancelHarnessSource());
    const child = spawn(process.execPath, [script, helperUrl(), repoRoot, pnpm.entry, pidFile, "foreign", markerFile], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let initialError;
    try {
      const pids = await waitForPids(pidFile, 8_000);
      process.kill(child.pid, "SIGTERM");
      const exit = await waitForExitResult(child, 8_000);
      assert.equal(readFileSync(markerFile, "utf8"), "foreign-handler", "the foreign handler must still run");
      await waitForExitOf(pids.leader, 5_000);
      await waitForExitOf(pids.grandchild, 5_000);
      assert.equal(isAlive(pids.leader), false, "the owned version child must be cleaned on cancel");
      assert.equal(isAlive(pids.grandchild), false, "the owned grandchild must be cleaned on cancel");
      assert.equal(exit.code, 0, `the foreign handler decides termination; got ${JSON.stringify(exit)}`);
    } catch (error) {
      initialError = error;
    }
    try {
      await finalizeOwnedHarness(child, { pidFile, roots: [workRoot], initialError, label: "cancel-foreign" });
    } finally {
      killVerifiedPid(child.pid, true);
    }
    if (initialError !== undefined) throw initialError;
  });

  it("restores native signal termination when no framework handler exists", { skip: process.platform === "win32" }, async () => {
    const repoRoot = makeRepo(`pnpm@${REQUIRED_VERSION}`);
    const workRoot = makeDiskBase();
    const pidFile = join(workRoot, "cancel-solo.pid");
    const pnpm = makePnpmPackageWithBehavior(REQUIRED_VERSION, workRoot, { inertWorker: true, pidFile });
    const script = writeHarness("cancel-solo", cancelHarnessSource());
    const child = spawn(process.execPath, [script, helperUrl(), repoRoot, pnpm.entry, pidFile, "solo", ""], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let initialError;
    try {
      const pids = await waitForPids(pidFile, 8_000);
      process.kill(child.pid, "SIGTERM");
      const exit = await waitForExitResult(child, 8_000);
      assert.equal(exit.signal, "SIGTERM", `native termination must be preserved; got ${JSON.stringify(exit)}`);
      await waitForExitOf(pids.leader, 5_000);
      await waitForExitOf(pids.grandchild, 5_000);
      assert.equal(isAlive(pids.leader), false);
      assert.equal(isAlive(pids.grandchild), false);
    } catch (error) {
      initialError = error;
    }
    try {
      await finalizeOwnedHarness(child, { pidFile, roots: [workRoot], initialError, label: "cancel-solo" });
    } finally {
      killVerifiedPid(child.pid, true);
    }
    if (initialError !== undefined) throw initialError;
  });

  it("exits nonzero when the final root cleanup fails", { skip: process.platform === "win32" }, async () => {
    const base = makeDiskBase();
    const script = writeHarness("exit-failure", exitFailureHarnessSource());
    const child = spawn(process.execPath, [script, helperUrl(), base], { stdio: ["ignore", "pipe", "pipe"] });
    let initialError;
    try {
      const exit = await waitForExitResult(child, 10_000);
      assert.notEqual(exit.code, 0, `a failed cleanup must not exit 0; got ${JSON.stringify(exit)}`);
    } catch (error) {
      initialError = error;
    }
    try {
      chmodSync(base, 0o700);
      await finalizeOwnedHarness(child, { roots: [base], initialError, label: "exit-failure" });
    } finally {
      killVerifiedPid(child.pid, true);
    }
    if (initialError !== undefined) throw initialError;
  });

  it("cancels the own worker and proves cleanup when the initial PID handshake is unreadable", { skip: process.platform === "win32" }, async () => {
    const repoRoot = makeRepo(`pnpm@${REQUIRED_VERSION}`);
    const workRoot = makeDiskBase();
    const pidFile = join(workRoot, "cancel-late.pid");
    const markerFile = join(workRoot, "late.marker");
    const pnpm = makePnpmPackageWithBehavior(REQUIRED_VERSION, workRoot, { inertWorker: true, pidFile });
    const script = writeHarness("cancel-late", cancelHarnessSource());
    const child = spawn(process.execPath, [script, helperUrl(), repoRoot, pnpm.entry, pidFile, "foreign", markerFile], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let initialError;
    try {
      // Force the initial PID observation to fail while the inert child and
      // grandchild are alive and the worker already owns its registry.
      const observationError = await waitForPids(join(workRoot, "never-written.pid"), 300).then(
        () => undefined,
        (error) => error,
      );
      assert.ok(observationError instanceof Error, "the initial PID observation must be forced to fail");
    } catch (error) {
      initialError = error;
    }
    let handshake;
    try {
      // No initially captured PIDs: the finalizer must ask the owner via SIGTERM before any forced fallback.
      await finalizeOwnedHarness(child, { pidFile, roots: [workRoot], initialError, label: "cancel-late" });
      handshake = safeReadHandshake(pidFile);
      assert.ok(handshake, "the handshake must be re-readable after cancellation");
      assert.equal(probePid(handshake.leader), "gone", "the owned version child must not survive owner cancellation");
      assert.equal(probePid(handshake.grandchild), "gone", "the owned grandchild must not survive owner cancellation");
    } finally {
      // Security cleanup by really-known PIDs only; never guessed names.
      if (handshake === undefined) handshake = safeReadHandshake(pidFile);
      if (handshake) {
        killVerifiedPid(handshake.leader);
        killVerifiedPid(handshake.grandchild);
      }
      killVerifiedPid(child.pid, true);
    }
    if (initialError !== undefined) throw initialError;
  });

  it("retains and reports unverifiable resources when a forced cleanup cannot be confirmed", { skip: process.platform === "win32" }, async () => {
    const repoRoot = makeRepo(`pnpm@${REQUIRED_VERSION}`);
    const workRoot = makeDiskBase();
    const pidFile = join(workRoot, "eio.pid");
    const pnpm = makePnpmPackageWithBehavior(REQUIRED_VERSION, workRoot, { inertWorker: true, pidFile });
    const script = writeHarness("eio", cancelHarnessSource());
    const child = spawn(process.execPath, [script, helperUrl(), repoRoot, pnpm.entry, pidFile, "stubborn", ""], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const initialError = new Error("simulated observation failure");
    const eioError = new Error("simulated EIO");
    let handshake;
    try {
      handshake = await waitForPids(pidFile, 8_000);
      await assert.rejects(
        finalizeOwnedHarness(child, {
          pidFile,
          roots: [workRoot],
          initialError,
          graceMs: 300,
          killTree: () => ({ killed: false, pid: child.pid, error: eioError }),
          label: "eio",
        }),
        (error) => {
          assert.ok(error instanceof AggregateError, `expected an AggregateError, got ${error}`);
          assert.ok(error.errors.includes(initialError), "the initial observation error must be preserved");
          assert.ok(
            error.errors.some((entry) => entry === eioError || entry?.cause === eioError),
            "the kill failure cause must be preserved",
          );
          assert.match(error.message, /roots protegidos/);
          return true;
        },
      );
      assert.equal(protectedRoots.has(workRoot), true, "unverifiable roots must be protected from afterEach");
    } finally {
      killVerifiedPid(child.pid, true);
      if (handshake) {
        killVerifiedPid(handshake.leader);
        killVerifiedPid(handshake.grandchild);
      }
    }
  });

  it("collects an early SIGTERM failure, keeps checking, and preserves the first failure", { skip: process.platform === "win32" }, async () => {
    const repoRoot = makeRepo(`pnpm@${REQUIRED_VERSION}`);
    const workRoot = makeDiskBase();
    const pidFile = join(workRoot, "term-fail.pid");
    const pnpm = makePnpmPackageWithBehavior(REQUIRED_VERSION, workRoot, { inertWorker: true, pidFile });
    const script = writeHarness("term-fail", cancelHarnessSource());
    const child = spawn(process.execPath, [script, helperUrl(), repoRoot, pnpm.entry, pidFile, "stubborn", ""], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const termError = Object.assign(new Error("simulated EPERM"), { code: "EPERM" });
    let handshake;
    let initialError;
    try {
      handshake = await waitForPids(pidFile, 8_000);
      // Real caller failure: the first observation fails for real.
      initialError = await waitForPids(join(workRoot, "never-written.pid"), 300).then(
        () => undefined,
        (error) => error,
      );
      assert.ok(initialError instanceof Error, "the caller must capture a real first failure");
    } catch (error) {
      initialError = initialError ?? error;
    }
    try {
      // The injected SIGTERM failure must be collected, not propagated raw, and
      // must not bypass root protection or the aggregate report.
      await assert.rejects(
        finalizeOwnedHarness(child, {
          pidFile,
          roots: [workRoot],
          initialError,
          graceMs: 300,
          termSender: () => {
            throw termError;
          },
          label: "term-fail",
        }),
        (error) => {
          assert.ok(error instanceof AggregateError, `expected an AggregateError, got ${error}`);
          assert.ok(error.errors.includes(initialError), "the caller's first failure must be preserved");
          assert.ok(
            error.errors.some((entry) => entry === termError || entry?.cause === termError),
            "the SIGTERM failure cause must be collected",
          );
          assert.match(error.message, /roots protegidos/);
          return true;
        },
      );
      assert.equal(protectedRoots.has(workRoot), true, "an early SIGTERM throw must not bypass root protection");
      assert.ok(handshake, "the handshake must be known for the owned cleanup proof");
      assert.equal(probePid(handshake.leader), "gone", "the owned version child must be cleaned");
      assert.equal(probePid(handshake.grandchild), "gone", "the owned grandchild must be cleaned");
    } finally {
      killVerifiedPid(child.pid, true);
      if (handshake) {
        killVerifiedPid(handshake.leader);
        killVerifiedPid(handshake.grandchild);
      }
    }
  });

  it("preserves unexpected PID handshake read errors instead of masking them as a missing fixture", async () => {
    const workRoot = makeDiskBase();
    const directoryAsPidFile = join(workRoot, "handshake-dir");
    mkdirSync(directoryAsPidFile);
    await assert.rejects(
      waitForPids(directoryAsPidFile, 500),
      (error) => {
        assert.match(error.message, /handshake-dir/, "the unexpected path must be preserved");
        assert.ok(error.cause, "the unexpected cause (EISDIR/EACCES/EIO) must be preserved");
        assert.doesNotMatch(error.message, /not written within/);
        return true;
      },
    );
  });

  it("rejects invalid disk overrides before any write", () => {
    const previous = process.env[VERIFICATION_DISK_ROOT_ENV];
    try {
      const existingBase = makeDiskBase();

      const relativeParent = process.cwd();
      const relativeBefore = readdirSync(relativeParent).length;
      process.env[VERIFICATION_DISK_ROOT_ENV] = "relative/base";
      assert.throws(() => makeDiskBase(), /absoluta|absolute/i);
      assert.equal(readdirSync(relativeParent).length, relativeBefore, "a relative override must not write");

      const workspaceBefore = readdirSync(root).length;
      process.env[VERIFICATION_DISK_ROOT_ENV] = root;
      assert.throws(() => makeDiskBase(), /workspace/i);
      assert.equal(readdirSync(root).length, workspaceBefore, "a workspace override must not write into the repo");

      const missing = join(existingBase, "missing-base");
      process.env[VERIFICATION_DISK_ROOT_ENV] = missing;
      assert.throws(() => makeDiskBase(), /existente|directorio/i);
      assert.equal(existsSync(missing), false, "a missing override must not be created");

      const loopA = join(existingBase, "loop-a");
      const loopB = join(existingBase, "loop-b");
      symlinkSync(loopB, loopA);
      symlinkSync(loopA, loopB);
      process.env[VERIFICATION_DISK_ROOT_ENV] = loopA;
      assert.throws(() => makeDiskBase(), /existente|ELOOP|directorio/i);
      assert.equal(existsSync(loopA), false, "a symlink-loop override must not be resolved lexically");
    } finally {
      if (previous === undefined) delete process.env[VERIFICATION_DISK_ROOT_ENV];
      else process.env[VERIFICATION_DISK_ROOT_ENV] = previous;
    }
  });
});

describe("caller integration controls", () => {
  const callers = [
    "external-version-pins-red.test.mjs",
    "pi-sdk-compatibility.test.mjs",
    "runtime-agents.test.mjs",
    "pi-package-lifecycle.test.mjs",
    "foundation-contract.test.mjs",
  ];

  it("routes every packaging caller through the shared exact selector without a Corepack/PATH fallback", () => {
    for (const caller of callers) {
      const source = readFileSync(join(testDir, caller), "utf8");
      assert.match(source, /from "\.\/helpers\/pnpm-tooling\.mjs"/, `${caller} must import the shared selector`);
      assert.match(source, /packProjectTarball|resolvePnpmPackInvocation/, `${caller} must use the shared selector`);
      assert.doesNotMatch(source, /corepack/i, `${caller} must not keep a Corepack acquisition path`);
      assert.doesNotMatch(source, /command:\s*"pnpm"/, `${caller} must not keep an ambiguous PATH pnpm`);
    }
  });
});

function makePnpmPackageWithBehavior(version, workRoot, options = {}) {
  const packageRoot = join(makeTempRoot("jorgex-pi-pnpm-bin-"), "node_modules", "pnpm");
  mkdirSync(join(packageRoot, "bin"), { recursive: true });
  const entry = join(packageRoot, "bin", "pnpm.mjs");
  const bin = [
    "#!/usr/bin/env node",
    'import { spawn } from "node:child_process";',
    "import { mkdirSync, renameSync, writeFileSync } from \"node:fs\";",
    "import { join } from \"node:path\";",
    `const version = ${JSON.stringify(version)};`,
    `const workRoot = ${JSON.stringify(workRoot)};`,
    `const hang = ${options.hang ? "true" : "false"};`,
    `const leaderExits = ${options.leaderExits ? "true" : "false"};`,
    `const inertWorker = ${options.inertWorker ? "true" : "false"};`,
    `const pidFile = ${JSON.stringify(options.pidFile ?? null)};`,
    "const args = process.argv.slice(2);",
    'if (args[0] === "--version" && !inertWorker) { console.log(version); process.exit(0); }',
    'if (args[0] !== "pack" && !inertWorker) { console.error("unexpected args: " + args.join(" ")); process.exit(2); }',
    'const destinationIndex = args.indexOf("--pack-destination");',
    "const destination = args[destinationIndex + 1];",
    'if (args[0] === "pack") mkdirSync(destination, { recursive: true });',
    "if (inertWorker) {",
    '  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });',
    '  if (pidFile) { writeFileSync(pidFile + ".tmp", JSON.stringify({ leader: process.pid, grandchild: child.pid })); renameSync(pidFile + ".tmp", pidFile); }',
    "  setTimeout(() => {}, 60000);",
    "} else if (hang) {",
    '  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });',
    '  if (pidFile) writeFileSync(pidFile, String(child.pid));',
    "  setTimeout(() => {}, 60000);",
    "} else if (leaderExits) {",
    '  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });',
    '  if (pidFile) writeFileSync(pidFile, String(child.pid));',
    `  writeFileSync(join(destination, "jorgex-pi-" + version + ".tgz"), "fixture-tarball");`,
    "  process.exit(0);",
    "} else {",
    `  writeFileSync(join(destination, "jorgex-pi-" + version + ".tgz"), "fixture-tarball");`,
    "  process.exit(0);",
    "}",
    "",
  ].join("\n");
  writeFileSync(entry, bin, "utf8");
  writeFileSync(
    join(packageRoot, "package.json"),
    `${JSON.stringify({ name: "pnpm", version, bin: { pnpm: "bin/pnpm.mjs" } })}\n`,
    "utf8",
  );
  return { packageRoot, entry };
}

function readPidFile(path) {
  const value = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`fixture descendant pid file is invalid: ${path}`);
  return value;
}

function helperUrl() {
  return pathToFileURL(join(testDir, "helpers", "pnpm-tooling.mjs")).href;
}

function writeHarness(name, source) {
  const directory = makeTempRoot(`jorgex-pi-harness-${name}-`);
  const file = join(directory, `${name}.mjs`);
  writeFileSync(file, source, "utf8");
  return file;
}

function cancelHarnessSource() {
  return [
    'import { writeFileSync } from "node:fs";',
    "const [helperUrl, repoRoot, entry, pidFile, mode, markerFile] = process.argv.slice(2);",
    "const { resolvePnpmPackInvocation, runBoundedProcess } = await import(helperUrl);",
    'if (mode === "foreign") {',
    '  process.on("SIGTERM", () => { writeFileSync(markerFile, "foreign-handler"); process.exit(0); });',
    "}",
    'if (mode === "stubborn") {',
    '  process.on("SIGTERM", () => {});',
    "  setTimeout(() => {}, 60000);",
    "}",
    "resolvePnpmPackInvocation({",
    "  repoRoot,",
    "  env: { JORGEX_PNPM_ENTRYPOINT: entry },",
    "  runProcess: runBoundedProcess,",
    "  versionCheckTimeoutMs: 60_000,",
    "}).then(",
    "  () => { process.exitCode = 0; },",
    '  (error) => { process.stderr.write(String(error?.stack ?? error) + "\\n"); process.exitCode = 3; },',
    ");",
    "",
  ].join("\n");
}

function exitFailureHarnessSource() {
  return [
    'import { chmodSync } from "node:fs";',
    "const [helperUrl, base] = process.argv.slice(2);",
    "const { createVerificationSandbox } = await import(helperUrl);",
    'createVerificationSandbox({ repoRoot: process.cwd(), env: { JORGEX_VERIFICATION_DISK_ROOT: base }, prefix: "jorgex-pi-exitfail-" });',
    "chmodSync(base, 0o500);",
    "",
  ].join("\n");
}

async function waitForPids(path, timeoutMs) {
  const started = Date.now();
  for (;;) {
    try {
      return readHandshake(path);
    } catch (error) {
      // Retry only expected absence or a partial write; preserve unexpected
      // causes (EACCES/EIO/EPERM) with their path instead of masking them.
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) {
        throw contextualError("waitForPids", `lectura de ${path}`, error);
      }
    }
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`fixture pids were not written within ${timeoutMs}ms: ${path}`);
    }
    await delay(20);
  }
}

function waitForExitResult(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`subprocess did not exit within ${timeoutMs}ms`)), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal });
    });
  });
}

/**
 * Single parent-side finalizer for one owned harness resource (subprocess or
 * worker thread). It never starts with SIGKILL: it sends SIGTERM to the owned
 * harness so its in-harness cancellation owner cleans its registry first,
 * waits bounded before any forced fallback, then (re)reads the PID handshake
 * when a pidFile is given and only forces PIDs owned via resource/handshake.
 * ESRCH is absence; EPERM/EIO/EACCES and the initial observation error
 * are preserved and aggregated. When cleanup cannot be confirmed the affected
 * roots are protected from afterEach and reported instead of a fake pass.
 */
async function finalizeOwnedHarness(resource, options = {}) {
  const {
    pidFile,
    roots = [],
    initialError,
    killTree = killProcessTree,
    termSender = sendOwnedTerm,
    graceMs = 8_000,
    label = "harness",
  } = options;
  const errors = [];
  if (initialError !== undefined) errors.push(initialError);

  if (typeof resource?.terminate === "function" && resource.pid === undefined) {
    try {
      await resource.terminate();
    } catch (error) {
      errors.push(contextualError(label, "terminate del worker_thread", error));
    }
    reportFinalization(errors, resource, pidFile, roots, label);
    return;
  }

  if (Number.isInteger(resource?.pid) && !hasExited(resource)) {
    let termSent = false;
    try {
      termSent = termSender(resource) !== false;
    } catch (error) {
      // Collect the TERM failure and continue the safe checks: an early throw
      // must never bypass root protection or the aggregate report.
      errors.push(contextualError(label, `SIGTERM al worker ${resource.pid}`, error));
    }
    if (termSent) {
      const exited = await waitForExitWithin(resource, graceMs);
      if (!exited) {
        const kill = killTree(resource);
        if (!kill.killed && !kill.noProcess) {
          errors.push(contextualError(label, `kill del grupo worker ${resource.pid}`, kill.error));
        }
      }
    } else {
      const kill = killTree(resource);
      if (!kill.killed && !kill.noProcess) {
        errors.push(contextualError(label, `kill del grupo worker ${resource.pid}`, kill.error));
      }
    }
  }

  let handshake;
  if (pidFile !== undefined) {
    try {
      handshake = readHandshake(pidFile);
    } catch (error) {
      errors.push(contextualError(label, `handshake ${pidFile}`, error));
    }
  }

  const ownedPids = [];
  if (Number.isInteger(resource?.pid)) ownedPids.push(resource.pid);
  if (handshake) ownedPids.push(handshake.leader, handshake.grandchild);
  for (const pid of ownedPids) {
    try {
      if (probePid(pid) === "alive") process.kill(pid, "SIGKILL");
      if (!(await waitForPidGone(pid, 1_500))) {
        errors.push(new Error(`${label}: el pid propio ${pid} sigue vivo tras SIGKILL`));
      }
    } catch (error) {
      if (error?.code !== "ESRCH") {
        errors.push(contextualError(label, `limpieza/verificación del pid ${pid}`, error));
      }
    }
  }

  reportFinalization(errors, resource, pidFile, roots, label);
}

function sendOwnedTerm(child) {
  try {
    process.kill(child.pid, "SIGTERM");
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForExitWithin(child, timeoutMs) {
  if (hasExited(child)) return Promise.resolve(true);
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      resolvePromise(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolvePromise(true);
    };
    child.once("exit", onExit);
  });
}

function readHandshake(pidFile) {
  const parsed = JSON.parse(readFileSync(pidFile, "utf8"));
  if (!Number.isInteger(parsed?.leader) || !Number.isInteger(parsed?.grandchild)) {
    throw new Error(`handshake incompleto en ${pidFile}`);
  }
  return parsed;
}

function safeReadHandshake(pidFile) {
  try {
    return readHandshake(pidFile);
  } catch {
    return undefined;
  }
}

function probePid(pid) {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    if (error?.code === "ESRCH") return "gone";
    throw error;
  }
}

async function waitForPidGone(pid, timeoutMs) {
  const started = Date.now();
  for (;;) {
    if (probePid(pid) === "gone") return true;
    if (Date.now() - started >= timeoutMs) return false;
    await delay(20);
  }
}

function killVerifiedPid(pid, group = false) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(group ? -pid : pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") {
      process.stderr.write(`[pnpm-tooling-test] limpieza de seguridad del pid ${pid} falló: ${error?.message ?? error}\n`);
    }
  }
}

function contextualError(label, action, error) {
  return new Error(`${label}: ${action} falló: ${error instanceof Error ? error.message : String(error)}`, {
    cause: error instanceof Error ? error : undefined,
  });
}

function reportFinalization(errors, resource, pidFile, roots, label) {
  if (errors.length === 0) return;
  for (const root of roots) protectedRoots.add(root);
  throw new AggregateError(
    errors,
    `${label}: finalizador parental sin cleanup confirmado; worker pid ${resource?.pid ?? "?"}, pidfile ${pidFile ?? "?"}, roots protegidos [${roots.join(", ")}]`,
  );
}

async function waitForPidFile(path, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (existsSync(path)) {
      const value = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
      if (Number.isInteger(value) && value > 0) return value;
    }
    await delay(20);
  }
  throw new Error(`fixture descendant pid file was not written: ${path}`);
}

async function waitForExitOf(pid, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!isAlive(pid)) return;
    await delay(20);
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
