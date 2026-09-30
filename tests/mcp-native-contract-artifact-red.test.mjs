// T70/T73 tracer — public native MCP contract/capability of the real Pi package
// (Spec 71, "Autoridad readonly de MCP persistente: contrato para ambos
// consumidores").
//
// Published Stack selects a Pi candidate by the EXACT root contract, never by
// semver: the artifact must truthfully declare the genuine `mcp-native-v1`
// capability and the `mcpNative` binding, and ship the closed-shape
// `contract/native-mcp.v1.json` whose readonly entrypoint/export declarations
// resolve to real functions inside the package. Without those bytes the previous
// Stack cannot fail closed before activating/projecting Pi, and the next Stack
// cannot consume the readonly authority. The capability describes implemented
// behavior; it is never a fabricated marker.
//
// Expected RED before implementation (T71): `contract/jorgex-pi.v1.json` has no
// `mcpNative` binding and no `mcp-native-v1` capability, and
// `contract/native-mcp.v1.json` is absent. Every module is imported only AFTER
// the declaration that names it has been read and its file exists, so the RED is
// always the missing contract data — never an import crash from a fixture.
//
// The artifact half (T73) runs a REAL `pnpm pack` in an owned on-disk temp dir
// with the runner teardown registered before any IO; the source binding is
// validated first, so this case can never pass from a fabricated tarball while
// the feature is absent.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

const testDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(testDir, "..");
const expected = readJson(join(testDir, "fixtures", "native-mcp-contract.expected.json"), "native MCP contract fixture");

test("the root Pi contract adds mcp-native-v1 additively with the mcpNative binding", () => {
  const contract = readJson(join(root, expected.rootContractPath), "root jorgex-pi contract");

  assert.deepEqual(
    contract.mcpNative,
    expected.rootBinding,
    "the root contract must bind the native authority as mcpNative { schemaVersion: 1, contractPath: \"contract/native-mcp.v1.json\" }",
  );
  assert.ok(Array.isArray(contract.capabilities), "the root contract must declare capabilities as an array");
  assert.deepEqual(
    contract.capabilities,
    expected.capabilities,
    "the historical capabilities must keep their relative order and mcp-native-v1 must be added as the genuine 23rd entry (additive, never a replacement)",
  );
  assert.equal(
    contract.capabilities.filter((name) => name === expected.capability).length,
    1,
    "the native capability must be declared exactly once",
  );
});

test("the shipped native MCP authority is closed and binds its declared readonly exports", async () => {
  const contract = readJson(join(root, expected.rootBinding.contractPath), "native MCP authority contract");

  assert.deepEqual(
    contract,
    expected.contract,
    "contract/native-mcp.v1.json must contain exactly the closed v1 authority shape, with no invented fields",
  );
  assert.equal(
    contract.capability,
    expected.capability,
    "the file capability must be the same genuine capability declared by the root contract",
  );

  const entrypoints = [
    ["definitions.entrypoint", contract.definitions.entrypoint],
    ["ownership.entrypoint", contract.ownership.entrypoint],
  ];
  for (const [label, entrypoint] of entrypoints) {
    assertPackageRelativeModule(entrypoint, label);
    assert.equal(
      existsSync(join(root, entrypoint)),
      true,
      `${label} must exist inside the package at ${entrypoint}`,
    );
  }

  // Contract -> implementation binding: the declared names must be real named
  // function exports, so a Stack consumer can load them from the verified
  // artifact. The plain-`node_modules` import mechanism itself is protected by
  // the existing `mcp-native-consumer-entrypoint-red.test.mjs`.
  const definitions = await import(pathToFileURL(join(root, contract.definitions.entrypoint)).href);
  assert.equal(
    typeof definitions[contract.definitions.digestExport],
    "function",
    `${contract.definitions.entrypoint} must export the declared pure ${contract.definitions.digestExport}`,
  );
  assert.equal(
    typeof definitions[contract.definitions.devtoolsExport],
    "function",
    `${contract.definitions.entrypoint} must export the declared ${contract.definitions.devtoolsExport}`,
  );

  const ownership = await import(pathToFileURL(join(root, contract.ownership.entrypoint)).href);
  assert.equal(
    typeof ownership[contract.ownership.export],
    "function",
    `${contract.ownership.entrypoint} must export the declared readonly ${contract.ownership.export}`,
  );
});

test("the real pnpm pack ships the native authority byte-identical with local entrypoints", (t) => {
  // Validate the source binding BEFORE producing any tarball, so an absent
  // feature fails on the missing contract rather than on a pack artifact.
  const sourceRoot = readJson(join(root, expected.rootContractPath), "root jorgex-pi contract before pnpm pack");
  assert.deepEqual(
    sourceRoot.mcpNative,
    expected.rootBinding,
    "the artifact case must fail on the missing root binding before any tarball already exists",
  );
  const nativeContractPath = join(root, "contract", "native-mcp.v1.json");
  const sourceBytes = readBytes(nativeContractPath, "native MCP authority source bytes");

  const packDir = mkdtempSync(join(tmpdir(), "jorgex-pi-native-pack-"));
  // Owned on-disk temp tree: teardown is registered immediately after the owned
  // mkdtemp and before any other IO, so it runs on success, failure and
  // cancellation. The child runs with an isolated HOME and no inherited auth.
  t.after(() => rmSync(packDir, { recursive: true, force: true }));
  const home = join(packDir, "home");
  mkdirSync(home, { recursive: true });

  const packageManager = resolvePnpm();
  execFileSync(
    packageManager.command,
    [...packageManager.args, "pack", "--pack-destination", packDir],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: isolatedChildEnv(home) },
  );

  const tarballs = readdirSync(packDir).filter((name) => name.endsWith(".tgz"));
  assert.equal(tarballs.length, 1, "pnpm pack must produce exactly one tarball");
  const archive = readTgz(join(packDir, tarballs[0]));

  const packedContract = "package/contract/native-mcp.v1.json";
  assert.ok(archive.has(packedContract), `the packed artifact is missing ${packedContract}`);
  assert.deepEqual(
    archive.get(packedContract),
    sourceBytes,
    "the packed native authority must be byte-identical to the tested source",
  );
  for (const entrypoint of [expected.contract.definitions.entrypoint, expected.contract.ownership.entrypoint]) {
    assert.ok(archive.has(`package/${entrypoint}`), `the packed artifact must ship the declared entrypoint ${entrypoint}`);
  }
  const packedRoot = JSON.parse(archive.get(`package/${expected.rootContractPath}`).toString("utf8"));
  assert.deepEqual(
    packedRoot.mcpNative,
    expected.rootBinding,
    "the packed root contract must carry the same mcpNative binding",
  );
});

function readJson(path, label) {
  return JSON.parse(readBytes(path, label).toString("utf8"));
}

function readBytes(path, label) {
  try {
    return readFileSync(path);
  } catch (error) {
    assert.fail(`${label} is missing at ${path} (${error.code ?? error.message})`);
  }
}

function assertPackageRelativeModule(value, label) {
  assert.equal(typeof value, "string", `${label} must be a string`);
  assert.match(value, /^extensions\/[A-Za-z0-9._-]+\.mjs$/, `${label} must be a package-relative .mjs path`);
  assert.equal(
    /^[/\\]|^[A-Za-z]:|\/\.\.\/|\\\.\.\\/.test(value),
    false,
    `${label} must be relative and local to the package (no absolute path, no traversal)`,
  );
}

function resolvePnpm() {
  const corepackEntry = join(dirname(process.execPath), "node_modules", "corepack", "dist", "corepack.js");
  return existsSync(corepackEntry)
    ? { command: process.execPath, args: [corepackEntry, "pnpm"] }
    : process.platform === "win32"
      ? { command: process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe", args: ["/d", "/s", "/c", "pnpm.cmd"] }
      : { command: "pnpm", args: [] };
}

// The pack child must not inherit the real HOME or any ambient credential.
function isolatedChildEnv(home) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/token|auth|password|secret|credential/i.test(key)) continue;
    env[key] = value;
  }
  env.HOME = home;
  env.USERPROFILE = home;
  env.XDG_CONFIG_HOME = join(home, ".config");
  env.XDG_CACHE_HOME = join(home, ".cache");
  env.XDG_DATA_HOME = join(home, ".local", "share");
  env.XDG_STATE_HOME = join(home, ".local", "state");
  return env;
}

// Minimal ustar reader: only the packed files matter here and all package paths
// are short. Directory/pax/gnu-long entries are skipped, not misread as files.
function readTgz(path) {
  const tar = gunzipSync(readFileSync(path));
  const files = new Map();
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = Number.parseInt(tarString(header, 124, 12).trim() || "0", 8);
    const type = String.fromCharCode(header[156] || 48);
    const body = tar.subarray(offset + 512, offset + 512 + size);
    if (type === "0" || type === "\0") {
      const prefix = tarString(header, 345, 155);
      const name = [prefix, tarString(header, 0, 100)].filter(Boolean).join("/");
      files.set(name, Buffer.from(body));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

function tarString(header, start, length) {
  return header.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
}
