import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(testDir, "..");
const bootstrapExpected = readJson(join(testDir, "fixtures", "bootstrap.expected.json"));

test("the packed foundation survives install, reload, repeat, and remove on its contract-tested Pi", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-lifecycle-"));
  const agentDir = join(sandbox, "agent");
  const homeDir = join(sandbox, "home");
  const cwd = join(sandbox, "workspace");
  const npmCache = join(sandbox, "npm-cache");
  const packDir = join(sandbox, "pack");
  const foreignPackageDir = join(sandbox, "foreign-package");
  const settingsPath = join(agentDir, "settings.json");
  const permissionConfigPath = join(agentDir, "extensions", "pi-permission-system", "config.json");
  const askConfigPath = join(agentDir, "extensions", "rpiv-ask-user-question", "config.json");

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
  const foreignPermissionConfig = '{"permissions":{"*":"ask"},"owner":"user"}\n';
  const foreignAskConfig = '{"collapseKey":"ctrl+}"}\n';
  mkdirSync(dirname(permissionConfigPath), { recursive: true });
  mkdirSync(dirname(askConfigPath), { recursive: true });
  writeFileSync(permissionConfigPath, foreignPermissionConfig);
  writeFileSync(askConfigPath, foreignAskConfig);

  const isolatedEnv = {
    ...allowedHostEnv(),
    HOME: homeDir,
    TEMP: sandbox,
    TMP: sandbox,
    TMPDIR: sandbox,
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
    const contract = readJson(join(root, "contract", "jorgex-pi.v1.json"));
    assert.ok(Array.isArray(contract.pi?.testedVersions), "contract.pi.testedVersions must provide the lifecycle Pi version");
    assert.equal(contract.pi.testedVersions.length, 1, "the lifecycle requires one tested Pi authority");
    const [expectedVersion] = contract.pi.testedVersions;
    assert.match(expectedVersion, /^\d+\.\d+\.\d+$/, "the lifecycle Pi authority must be an exact semver");
    const pi = resolveLocalPi(expectedVersion);
    runPi(pi, ["--version"], isolatedEnv, cwd);

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

    runPi(pi, ["install", source, "--no-approve"], isolatedEnv, cwd);
    const afterFirstInstall = readJson(settingsPath);
    assert.deepEqual(afterFirstInstall.foreignState, foreignState, "install must preserve foreign settings");
    assert.equal(count(afterFirstInstall.packages, foreignPackageDir), 1, "install must preserve the foreign package entry");
    assert.equal(count(afterFirstInstall.packages, source), 1, "install must persist exactly one JorgeX package entry");
    assert.equal(readFileSync(permissionConfigPath, "utf8"), foreignPermissionConfig, "install must not seed or modify permission config");
    assert.equal(readFileSync(askConfigPath, "utf8"), foreignAskConfig, "install must not seed or modify ask config");

    const installedPackageDir = join(agentDir, "npm", "node_modules", "jorgex-pi");
    const installedManifest = readJson(join(installedPackageDir, "package.json"));
    assert.equal(installedManifest.name, "jorgex-pi");
    assert.deepEqual(installedManifest.pi, {
      extensions: [bootstrapExpected.extension],
      skills: bootstrapExpected.skills,
      prompts: [],
      themes: [],
    });
    const firstPackageDigest = digestTree(installedPackageDir);
    const firstSettingsBytes = readFileSync(settingsPath, "utf8");

    runPi(pi, ["list", "--no-approve"], isolatedEnv, cwd);
    runPi(pi, ["--list-models", "__jorgex_foundation_smoke_no_match__", "--no-approve", "--offline", "--no-context-files"], isolatedEnv, cwd);

    runPi(pi, ["install", source, "--no-approve"], isolatedEnv, cwd);
    const afterSecondInstall = readJson(settingsPath);
    assert.equal(count(afterSecondInstall.packages, source), 1, "repeated install must not duplicate the package entry");
    assert.equal(count(afterSecondInstall.packages, foreignPackageDir), 1, "repeated install must not duplicate or remove the foreign entry");
    assert.deepEqual(afterSecondInstall.foreignState, foreignState, "repeated install must preserve foreign settings");
    assert.equal(readFileSync(settingsPath, "utf8"), firstSettingsBytes, "repeated install must leave settings byte-for-byte stable");
    assert.equal(digestTree(installedPackageDir), firstPackageDigest, "repeated install must leave the published package contents stable");
    assert.equal(readFileSync(permissionConfigPath, "utf8"), foreignPermissionConfig, "repeated install must preserve permission config");
    assert.equal(readFileSync(askConfigPath, "utf8"), foreignAskConfig, "repeated install must preserve ask config");

    runPi(pi, ["remove", source, "--no-approve"], isolatedEnv, cwd);
    const afterRemove = readJson(settingsPath);
    assert.deepEqual(afterRemove.foreignState, foreignState, "remove must preserve foreign settings");
    assert.deepEqual(afterRemove.packages, [foreignPackageDir], "remove must delete only the JorgeX-owned package entry");
    assert.equal(existsSync(installedPackageDir), false, "remove must delete the managed JorgeX package files");
    assert.equal(readFileSync(permissionConfigPath, "utf8"), foreignPermissionConfig, "remove must preserve permission config");
    assert.equal(readFileSync(askConfigPath, "utf8"), foreignAskConfig, "remove must preserve ask config");
    runPi(pi, ["--list-models", "__jorgex_foundation_smoke_no_match__", "--no-approve", "--offline", "--no-context-files"], isolatedEnv, cwd);

    const absentAgentDir = join(sandbox, "absent-agent");
    const absentHomeDir = join(sandbox, "absent-home");
    const absentSettingsPath = join(absentAgentDir, "settings.json");
    const absentPermissionConfig = join(absentAgentDir, "extensions", "pi-permission-system", "config.json");
    const absentAskConfig = join(absentAgentDir, "extensions", "rpiv-ask-user-question", "config.json");
    const foreignTree = join(absentAgentDir, "extensions", "user-owned");
    const foreignMarker = join(foreignTree, "keep.json");
    mkdirSync(foreignTree, { recursive: true });
    mkdirSync(absentHomeDir, { recursive: true });
    writeJson(absentSettingsPath, { packages: [foreignPackageDir], foreignState });
    writeFileSync(foreignMarker, '{"owner":"user","keep":true}\n');
    const foreignTreeDigest = digestTree(foreignTree);
    const absentEnv = {
      ...isolatedEnv,
      HOME: absentHomeDir,
      PI_CODING_AGENT_DIR: absentAgentDir,
      XDG_CACHE_HOME: join(sandbox, "absent-xdg-cache"),
      XDG_CONFIG_HOME: join(sandbox, "absent-xdg-config"),
      XDG_DATA_HOME: join(sandbox, "absent-xdg-data"),
    };

    for (const phase of ["install", "reinstall"]) {
      runPi(pi, ["install", source, "--no-approve"], absentEnv, cwd);
      assert.equal(existsSync(absentPermissionConfig), false, `${phase} must not seed permission config when absent`);
      assert.equal(existsSync(absentAskConfig), false, `${phase} must not seed ask config when absent`);
      assert.equal(digestTree(foreignTree), foreignTreeDigest, `${phase} must preserve the foreign extension tree`);
    }
    runPi(pi, ["remove", source, "--no-approve"], absentEnv, cwd);
    assert.equal(existsSync(absentPermissionConfig), false, "remove must not create permission config when absent");
    assert.equal(existsSync(absentAskConfig), false, "remove must not create ask config when absent");
    assert.equal(digestTree(foreignTree), foreignTreeDigest, "remove must preserve the foreign extension tree");
    assert.deepEqual(readJson(absentSettingsPath), { packages: [foreignPackageDir], foreignState });
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

function runPi(pi, args, env, cwd) {
  return execFileSync(pi.command, [pi.entry, ...args], {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
}

function resolveLocalPi(expectedVersion) {
  const packageManifest = readJson(join(root, "package.json"));
  assert.equal(
    packageManifest.devDependencies?.["@earendil-works/pi-coding-agent"],
    expectedVersion,
    "the Pi development dependency must match contract.pi.testedVersions[0]",
  );
  const manifestPath = join(root, "node_modules", "@earendil-works", "pi-coding-agent", "package.json");
  assert.ok(existsSync(manifestPath), `Pi ${expectedVersion} must be provisioned as an exact local development dependency`);
  const manifest = readJson(manifestPath);
  assert.equal(manifest.version, expectedVersion, "the installed local Pi package must match contract.pi.testedVersions[0]");
  const entry = join(dirname(manifestPath), manifest.bin?.pi ?? "");
  assert.ok(manifest.bin?.pi && existsSync(entry), `the local Pi ${expectedVersion} entrypoint must exist at ${relative(root, entry)}`);
  return { command: process.execPath, entry };
}

function allowedHostEnv() {
  const allowed = {};
  for (const key of ["PATH", "PATHEXT", "SYSTEMROOT", "SystemRoot", "COMSPEC", "ComSpec", "WINDIR", "windir"]) {
    if (process.env[key] !== undefined) allowed[key] = process.env[key];
  }
  return allowed;
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
  const resolvedRoot = `${resolve(rootDir)}${sep}`;
  const nodeModulesRoot = `${resolve(rootDir, "node_modules")}${sep}`;
  const visit = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const resolvedPath = resolve(path);
      const relativePath = relative(rootDir, path).replaceAll("\\", "/");
      assert.ok(resolvedPath.startsWith(resolvedRoot), `package path escapes its root: ${relativePath}`);
      const stat = lstatSync(path);
      hash.update(relativePath);
      if (stat.isSymbolicLink()) {
        assert.ok(
          relativePath.startsWith("node_modules/.bin/"),
          `JorgeX-owned assets must not contain symlinks: ${relativePath}`,
        );
        const target = realpathSync(path);
        assert.ok(
          target.startsWith(nodeModulesRoot),
          `package-manager symlink must resolve inside installed package/node_modules: ${relativePath}`,
        );
        hash.update(readFileSync(path));
        continue;
      }
      if (stat.isDirectory()) visit(path);
      else hash.update(readFileSync(path));
    }
  };
  visit(rootDir);
  return hash.digest("hex");
}
