import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(testDir, "..");
const SIX = [
  "@gotgenes/pi-permission-system",
  "@juicesharp/rpiv-ask-user-question",
  "@narumitw/pi-goal",
  "pi-subagents",
  "pi-web-access",
  "strip-json-comments",
];
const EXACT_PIN = /^\d+\.\d+\.\d+([+-].*)?$/;

test("dynamic runtime specs without bundledDependencies", () => {
  const manifest = readJson(join(root, "package.json"));
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}).sort(), [...SIX].sort(), "package must declare exactly the six runtime deps");
  assert.ok(
    manifest.bundledDependencies === undefined || manifest.bundledDependencies.length === 0,
    `bundledDependencies must be gone, got ${JSON.stringify(manifest.bundledDependencies)}; native pi install resolves via npm`,
  );
  for (const name of SIX) {
    const spec = manifest.dependencies[name]?.trim();
    assert.ok(spec, `${name} must have a version spec`);
    assert.doesNotMatch(spec, EXACT_PIN, `${name} spec ${spec} must not be an exact pin; use a range`);
  }
});

test("direct pi install acquires six deps via native resolver", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-dynamic-install-"));
  const agentDir = join(sandbox, "agent");
  const homeDir = join(sandbox, "home");
  const cwd = join(sandbox, "workspace");
  const npmCache = join(sandbox, "npm-cache");
  const packDir = join(sandbox, "pack");
  for (const path of [agentDir, homeDir, cwd, npmCache, packDir]) mkdirSync(path, { recursive: true });
  writeJson(join(agentDir, "settings.json"), { packages: [] });
  const env = {
    ...allowedHostEnv(),
    HOME: homeDir,
    TEMP: sandbox,
    TMP: sandbox,
    TMPDIR: sandbox,
    XDG_CACHE_HOME: join(sandbox, "xdg-cache"),
    XDG_CONFIG_HOME: join(sandbox, "xdg-config"),
    XDG_DATA_HOME: join(sandbox, "xdg-data"),
    PI_CODING_AGENT_DIR: agentDir,
    PI_TELEMETRY: "0",
    NPM_CONFIG_AUDIT: "false",
    NPM_CONFIG_CACHE: npmCache,
    NPM_CONFIG_FUND: "false",
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    NO_COLOR: "1",
  };

  try {
    const manifest = readJson(join(root, "package.json"));
    const pi = resolveLocalPi(manifest.devDependencies?.["@earendil-works/pi-coding-agent"]);
    const tarball = packTarball(packDir);
    runPi(pi, ["install", `npm:jorgex-pi@file:${tarball}`, "--no-approve"], env, cwd);
    const npmRoot = join(agentDir, "npm", "node_modules");
    const installedDir = join(npmRoot, "jorgex-pi");
    const installed = readJson(join(installedDir, "package.json"));
    assert.equal(installed.name, "jorgex-pi");
    assert.equal(installed.version, manifest.version);
    assert.deepEqual(Object.keys(installed.dependencies ?? {}).sort(), [...SIX].sort());
    for (const name of SIX) {
      assert.equal(
        existsSync(join(installedDir, "node_modules", name)),
        false,
        `installed jorgex-pi must not contain nested bundled closure: ${name}`,
      );
    }
    for (const name of SIX) {
      const depManifestPath = join(npmRoot, name, "package.json");
      assert.ok(existsSync(depManifestPath), `npm-installed dep must exist at hoisted resolver path: ${name}`);
      const dep = readJson(depManifestPath);
      assert.equal(dep.name, name, `hoisted dep name must match manifest: ${name}`);
      assert.match(String(dep.version), /^\d+\.\d+\.\d+/, `${name} installed version must be readable without asserting an exact value`);
    }
    runPi(pi, ["list", "--no-approve"], env, cwd);
  } finally {
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

function resolveLocalPi(expected) {
  assert.ok(expected, "local Pi fixture must be declared");
  const manifestPath = join(root, "node_modules", "@earendil-works", "pi-coding-agent", "package.json");
  const manifest = readJson(manifestPath);
  assert.equal(manifest.version, expected);
  const entry = join(dirname(manifestPath), manifest.bin?.pi ?? "");
  assert.ok(existsSync(entry));
  return { command: process.execPath, entry };
}

function runPi(pi, args, env, cwd) {
  return execFileSync(pi.command, [pi.entry, ...args], {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
}

function packTarball(packDir) {
  const corepackEntry = join(dirname(process.execPath), "node_modules", "corepack", "dist", "corepack.js");
  const pm = existsSync(corepackEntry)
    ? { command: process.execPath, args: [corepackEntry, "pnpm"] }
    : { command: "pnpm", args: [] };
  execFileSync(pm.command, [...pm.args, "pack", "--pack-destination", packDir], {
    cwd: root,
    env: { ...process.env, NO_COLOR: "1" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const tarballs = readdirSync(packDir).filter((name) => name.endsWith(".tgz"));
  assert.equal(tarballs.length, 1);
  return join(packDir, tarballs[0]);
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
