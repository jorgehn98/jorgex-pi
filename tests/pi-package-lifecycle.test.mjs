import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(testDir, "..");

test("the packed foundation survives Pi 0.84.2 install, reload, repeat, and remove", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-lifecycle-"));
  const agentDir = join(sandbox, "agent");
  const homeDir = join(sandbox, "home");
  const cwd = join(sandbox, "workspace");
  const npmCache = join(sandbox, "npm-cache");
  const packDir = join(sandbox, "pack");
  const foreignPackageDir = join(sandbox, "foreign-package");
  const settingsPath = join(agentDir, "settings.json");

  for (const path of [agentDir, homeDir, cwd, npmCache, packDir, foreignPackageDir]) {
    mkdirSync(path, { recursive: true });
  }

  writeJson(join(foreignPackageDir, "package.json"), {
    name: "foreign-pi-package",
    version: "1.0.0",
    pi: { extensions: [], skills: [], prompts: [], themes: [] },
  });
  const foreignState = { owner: "user", nested: { keep: true } };
  writeJson(settingsPath, {
    packages: [foreignPackageDir],
    foreignState,
  });

  const { PI_PACKAGE_DIR: _discardedPackageDir, ...inheritedEnv } = process.env;
  const isolatedEnv = {
    ...inheritedEnv,
    HOME: homeDir,
    XDG_CACHE_HOME: join(sandbox, "xdg-cache"),
    XDG_CONFIG_HOME: join(sandbox, "xdg-config"),
    XDG_DATA_HOME: join(sandbox, "xdg-data"),
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
    NPM_CONFIG_AUDIT: "false",
    NPM_CONFIG_CACHE: npmCache,
    NPM_CONFIG_FUND: "false",
    NPM_CONFIG_OFFLINE: "true",
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    NO_COLOR: "1",
  };
  assert.equal(
    isolatedEnv.PI_PACKAGE_DIR,
    undefined,
    "PI_PACKAGE_DIR is the Pi binary's read-only asset root, not writable user state, and must not be redirected",
  );

  try {
    runPi(["--version"], isolatedEnv, cwd);
    assert.equal(installedPiVersion(isolatedEnv), "0.84.2", "the lifecycle must run against the pinned Pi version");

    execFileSync("pnpm", ["pack", "--pack-destination", packDir], {
      cwd: root,
      env: isolatedEnv,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const tarballs = readdirSync(packDir).filter((name) => name.endsWith(".tgz"));
    assert.equal(tarballs.length, 1, "pnpm pack must produce one installable tarball");
    const tarball = join(packDir, tarballs[0]);
    const source = `npm:jorgex-pi@file:${tarball}`;

    runPi(["install", source, "--no-approve"], isolatedEnv, cwd);
    const afterFirstInstall = readJson(settingsPath);
    assert.deepEqual(afterFirstInstall.foreignState, foreignState, "install must preserve foreign settings");
    assert.equal(count(afterFirstInstall.packages, foreignPackageDir), 1, "install must preserve the foreign package entry");
    assert.equal(count(afterFirstInstall.packages, source), 1, "install must persist exactly one JorgeX package entry");

    const installedPackageDir = join(agentDir, "npm", "node_modules", "jorgex-pi");
    const installedManifest = readJson(join(installedPackageDir, "package.json"));
    assert.equal(installedManifest.name, "jorgex-pi");
    assert.deepEqual(installedManifest.pi, { extensions: [], skills: [], prompts: [], themes: [] });
    const firstPackageDigest = digestTree(installedPackageDir);
    const firstSettingsBytes = readFileSync(settingsPath, "utf8");

    runPi(["list", "--no-approve"], isolatedEnv, cwd);
    runPi(["--list-models", "__jorgex_foundation_smoke_no_match__", "--no-approve", "--offline", "--no-context-files"], isolatedEnv, cwd);

    runPi(["install", source, "--no-approve"], isolatedEnv, cwd);
    const afterSecondInstall = readJson(settingsPath);
    assert.equal(count(afterSecondInstall.packages, source), 1, "repeated install must not duplicate the package entry");
    assert.equal(count(afterSecondInstall.packages, foreignPackageDir), 1, "repeated install must not duplicate or remove the foreign entry");
    assert.deepEqual(afterSecondInstall.foreignState, foreignState, "repeated install must preserve foreign settings");
    assert.equal(readFileSync(settingsPath, "utf8"), firstSettingsBytes, "repeated install must leave settings byte-for-byte stable");
    assert.equal(digestTree(installedPackageDir), firstPackageDigest, "repeated install must leave the published package contents stable");

    runPi(["remove", source, "--no-approve"], isolatedEnv, cwd);
    const afterRemove = readJson(settingsPath);
    assert.deepEqual(afterRemove.foreignState, foreignState, "remove must preserve foreign settings");
    assert.deepEqual(afterRemove.packages, [foreignPackageDir], "remove must delete only the JorgeX-owned package entry");
    assert.equal(existsSync(installedPackageDir), false, "remove must delete the managed JorgeX package files");
    runPi(["--list-models", "__jorgex_foundation_smoke_no_match__", "--no-approve", "--offline", "--no-context-files"], isolatedEnv, cwd);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

function runPi(args, env, cwd) {
  return execFileSync(process.env.PI_BIN ?? "pi", args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
}

function installedPiVersion(env) {
  const command = process.env.PI_BIN ?? "pi";
  const executable = command.includes("/") ? command : env.PATH.split(delimiter).map((dir) => join(dir, command)).find(existsSync);
  assert.ok(executable, `could not resolve ${command} from PATH`);
  const launcher = readFileSync(executable, "utf8");
  const shimTarget = launcher.match(/^# cmd-shim-target=(.+)$/m)?.[1];
  assert.ok(shimTarget, "the Pi smoke requires the pnpm-installed CLI shim so its package version can be verified");
  return readJson(join(dirname(dirname(shimTarget)), "package.json")).version;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function count(values, expected) {
  return (values ?? []).filter((value) => value === expected).length;
}

function digestTree(rootDir) {
  const hash = createHash("sha256");
  const visit = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const relativePath = relative(rootDir, path).replaceAll("\\", "/");
      const stat = statSync(path);
      hash.update(relativePath);
      if (stat.isDirectory()) visit(path);
      else hash.update(readFileSync(path));
    }
  };
  visit(rootDir);
  return hash.digest("hex");
}
