import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
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

afterEach(() => {
  for (const directory of tempRoots.splice(0)) {
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

/** Parent for verification fixtures; the selector validates disk/workspace before use. */
function makeDiskBase() {
  const override = process.env[VERIFICATION_DISK_ROOT_ENV]?.trim();
  if (override) assert.ok(isAbsolute(override), "disk base override must be absolute");
  const parent = override ? resolve(override) : join(homedir(), ".cache");
  assert.ok(resolve(parent) === parent, "disk base parent must be absolute");
  if (override) {
    assert.ok(
      parent !== root && !parent.startsWith(`${root}${sep}`),
      "a workspace disk override must be rejected before creating a fixture base",
    );
  }
  // Arm ownership before creating the base directory.
  const directory = join(parent, `jorgex-pi-verify-base-${process.pid}-${randomUUID().slice(0, 8)}`);
  tempRoots.push(directory);
  mkdirSync(parent, { recursive: true });
  mkdirSync(directory, { recursive: true });
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
    assert.equal(prepared.root.startsWith(tmpdir() + "/"), false);
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
      await worker.terminate();
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
    let pids;
    try {
      pids = await waitForPids(pidFile, 8_000);
      process.kill(child.pid, "SIGTERM");
      const exit = await waitForExitResult(child, 8_000);
      assert.equal(readFileSync(markerFile, "utf8"), "foreign-handler", "the foreign handler must still run");
      await waitForExitOf(pids.leader, 5_000);
      await waitForExitOf(pids.grandchild, 5_000);
      assert.equal(isAlive(pids.leader), false, "the owned version child must be cleaned on cancel");
      assert.equal(isAlive(pids.grandchild), false, "the owned grandchild must be cleaned on cancel");
      assert.equal(exit.code, 0, `the foreign handler decides termination; got ${JSON.stringify(exit)}`);
    } finally {
      killOwnGroup(child);
      if (pids) {
        killPid(pids.leader);
        killPid(pids.grandchild);
      }
    }
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
    let pids;
    try {
      pids = await waitForPids(pidFile, 8_000);
      process.kill(child.pid, "SIGTERM");
      const exit = await waitForExitResult(child, 8_000);
      assert.equal(exit.signal, "SIGTERM", `native termination must be preserved; got ${JSON.stringify(exit)}`);
      await waitForExitOf(pids.leader, 5_000);
      await waitForExitOf(pids.grandchild, 5_000);
      assert.equal(isAlive(pids.leader), false);
      assert.equal(isAlive(pids.grandchild), false);
    } finally {
      killOwnGroup(child);
      if (pids) {
        killPid(pids.leader);
        killPid(pids.grandchild);
      }
    }
  });

  it("exits nonzero when the final root cleanup fails", { skip: process.platform === "win32" }, async () => {
    const base = makeDiskBase();
    const script = writeHarness("exit-failure", exitFailureHarnessSource());
    const child = spawn(process.execPath, [script, helperUrl(), base], { stdio: ["ignore", "pipe", "pipe"] });
    try {
      const exit = await waitForExitResult(child, 10_000);
      assert.notEqual(exit.code, 0, `a failed cleanup must not exit 0; got ${JSON.stringify(exit)}`);
    } finally {
      chmodSync(base, 0o700);
      killOwnGroup(child);
    }
  });

  it("rejects a symlink-loop disk override instead of a lexical fallback", () => {
    const base = makeDiskBase();
    const loopA = join(base, "loop-a");
    const loopB = join(base, "loop-b");
    symlinkSync(loopB, loopA);
    symlinkSync(loopA, loopB);
    assert.throws(
      () => resolveVerificationDiskBase({ repoRoot: root, env: { [VERIFICATION_DISK_ROOT_ENV]: loopA } }),
      /existente|ELOOP|directorio/,
    );
  });

  it("rejects a relative or workspace disk override before creating a fixture base", () => {
    const previous = process.env[VERIFICATION_DISK_ROOT_ENV];
    try {
      process.env[VERIFICATION_DISK_ROOT_ENV] = "relative/base";
      assert.throws(() => makeDiskBase(), /absolute/);
      process.env[VERIFICATION_DISK_ROOT_ENV] = root;
      assert.throws(() => makeDiskBase(), /workspace/);
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
    "import { mkdirSync, writeFileSync } from \"node:fs\";",
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
    '  if (pidFile) writeFileSync(pidFile, JSON.stringify({ leader: process.pid, grandchild: child.pid }));',
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
  while (Date.now() - started < timeoutMs) {
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8"));
        if (Number.isInteger(parsed?.leader) && Number.isInteger(parsed?.grandchild)) return parsed;
      } catch {
        // The fixture may still be writing the file.
      }
    }
    await delay(20);
  }
  throw new Error(`fixture pids were not written: ${path}`);
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

function killPid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

function killOwnGroup(child) {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // Already gone.
  }
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
