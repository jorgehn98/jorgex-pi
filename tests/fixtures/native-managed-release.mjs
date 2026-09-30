// Synthetic offline managed Pi release, built for the heavy ownership proof
// tracer (Spec 71, "Proof offline y bind del checker").
//
// The release layout mirrors the authoritative Stack contract, consulted
// read-only:
// - `src/lib/pi-package-lifecycle.ts` release verification reads
//   `<releaseDir>/package-lock.json` (raw sha256), requires a JSON `packages`
//   object and, per receipt dependency, `packages["node_modules/<name>"]`
//   with matching `version` and canonical `integrity`, then rehashes the whole
//   release tree.
// - `src/lib/pi-staged-lock.ts` fixes the npm lock shape: lockfileVersion 3,
//   a `packages` root entry and `node_modules/<name>` entries with canonical
//   sha512 SRI. No `resolved` URL is validated for the release, so none is
//   invented here.
// Only the minimum real code files are copied (the checker plus its import
// closure and the one runtime dependency), never a whole SDK or cache. The tree
// hash uses the Spec closure encoding (`kind` NUL `rel` NUL raw payload, ordinal
// sort), deliberately NOT the browser-v2 encoding. Nothing is executed and no
// signature, registry or published-release claim is made.
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTEXT7_URL, digestNativeMcpDefinition } from "../../extensions/mcp-engram.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PI_ROOT = join(HERE, "..", "..");
const RELEASE_PACKAGE_ROOT = "jorgex-pi";
const LOCK_ROOT_NAME = "pi-extensions";

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha512Sri(bytes) {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

// Spec 71 closure: entries `dir`/`file`/`symlink` without the root, relative
// slash paths sorted by JS ordinal, SHA256(kind+NUL+rel+NUL+payload) where the
// payload is the file bytes or the raw relative symlink target and nothing for a
// directory. No browser-v2 framing.
export function specTreeSha256(root) {
  const entries = [];
  const stack = [root];
  while (stack.length > 0) {
    const directory = stack.pop();
    for (const dirent of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, dirent.name);
      const rel = relative(root, full).split(sep).join("/");
      if (dirent.isSymbolicLink()) {
        const target = readlinkSync(full);
        if (isAbsolute(target)) throw new Error(`fixture symlink must be relative: ${full}`);
        entries.push({ rel, kind: "symlink", target });
        continue;
      }
      if (dirent.isDirectory()) {
        entries.push({ rel, kind: "dir" });
        stack.push(full);
        continue;
      }
      if (dirent.isFile()) {
        entries.push({ rel, kind: "file", full });
        continue;
      }
      throw new Error(`fixture contains an unsupported entry: ${full}`);
    }
  }
  entries.sort((left, right) => (left.rel < right.rel ? -1 : left.rel > right.rel ? 1 : 0));
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(entry.kind, "utf8");
    hash.update("\0", "utf8");
    hash.update(entry.rel, "utf8");
    hash.update("\0", "utf8");
    if (entry.kind === "symlink") hash.update(entry.target, "utf8");
    else if (entry.kind === "file") hash.update(readFileSync(entry.full));
  }
  return hash.digest("hex");
}

// Files and contents of a whole tree, so any write by the checker is observable.
export function snapshotTree(root) {
  const files = {};
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = join(directory, entry.name);
      const rel = relative(root, target);
      if (entry.isSymbolicLink()) files[rel] = `symlink:${readlinkSync(target)}`;
      else if (entry.isDirectory()) walk(target);
      else files[rel] = readFileSync(target, "utf8");
    }
  };
  walk(root);
  return files;
}

function manifest() {
  return JSON.parse(readFileSync(join(PI_ROOT, "package.json"), "utf8"));
}

// The six direct dependencies are read from the checked-in pnpm lock only as a
// fixture DATA SOURCE (current versions and canonical sha512 SRI); the release
// itself carries a materialized npm lock, never the pnpm YAML.
function dependenciesFromPnpmLock(lockText, names) {
  return names.map((name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`^ {2}'?${escaped}@(\\d[^:'\\n]*)'?:$`, "m");
    const match = pattern.exec(lockText);
    if (!match) throw new Error(`fixture source lock has no entry for ${name}`);
    const integrity = /resolution: \{integrity: (sha512-[A-Za-z0-9+/=]+)\}/.exec(lockText.slice(match.index));
    if (!integrity) throw new Error(`fixture source lock has no integrity for ${name}`);
    return { name, version: match[1], integrity: integrity[1] };
  });
}

function copyFile(source, target) {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, readFileSync(source));
}

// npm package-lock v3 as the release root must carry it: a `packages` map with
// the installed package entry (manifest version and the cached archive's SRI)
// plus one entry per direct dependency. No `resolved` URL is invented because
// the release verification does not require one.
function releaseLock({ version, dependencies, installedIntegrity }) {
  const packages = {
    "": {
      name: LOCK_ROOT_NAME,
      version,
      dependencies: Object.fromEntries(dependencies.map((dep) => [dep.name, dep.version])),
    },
    [`node_modules/${RELEASE_PACKAGE_ROOT}`]: {
      version,
      integrity: installedIntegrity,
      dependencies: Object.fromEntries(dependencies.map((dep) => [dep.name, dep.version])),
    },
  };
  for (const dep of dependencies) {
    packages[`node_modules/${dep.name}`] = { version: dep.version, integrity: dep.integrity };
  }
  return { name: LOCK_ROOT_NAME, version, lockfileVersion: 3, requires: true, packages };
}

export function createManagedReleaseSandbox(t, { projectTrusted = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "jorgex-pi-native-managed-"));
  // Owned temporary tree: the runner-hook teardown is registered immediately
  // after the owned mkdtemp and before any other IO, so it runs on success,
  // failure and a setup failure alike. Nothing here starts a process.
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const home = join(root, "home");
  const agentDir = join(root, "agent");
  const stackDir = join(home, ".jorgex-stack");
  const projectionPath = join(stackDir, "pi-projection-receipt.json");
  const receiptPath = join(stackDir, "pi-receipt.json");
  const npmDir = join(agentDir, "npm");
  const linkPath = join(npmDir, "node_modules", RELEASE_PACKAGE_ROOT);
  const releaseRoot = join(npmDir, "jorgex-pi-managed", "releases");
  const stageDir = join(agentDir, `stage-${sha256Hex("fixture-stage").slice(0, 32)}`, "pi-agent");
  const backupDir = join(stageDir, ".activate-backup");
  const pkg = manifest();
  const version = pkg.version;
  const dependencyNames = Object.keys(pkg.dependencies ?? {});
  if (dependencyNames.length !== 6) throw new Error(`fixture expects six direct dependencies, got ${dependencyNames.length}`);

  for (const directory of [
    home,
    agentDir,
    stackDir,
    join(stackDir, "packages"),
    join(npmDir, "node_modules"),
    releaseRoot,
    backupDir,
    join(agentDir, "skills", "demo"),
  ]) {
    mkdirSync(directory, { recursive: true });
  }

  // --- synthetic cached archive bytes (the receipt's candidate.tarball and the
  // installed lock entry refer to exactly these bytes; no gzip or online claim).
  const archiveBytes = Buffer.from(`jorgex-pi@${version} synthetic offline fixture archive\n`, "utf8");
  const cachePath = join(stackDir, "packages", `jorgex-pi-${version}.tgz`);
  writeFileSync(cachePath, archiveBytes);
  const tarball = {
    bytes: archiveBytes.length,
    sha256: sha256Hex(archiveBytes),
    sha512: createHash("sha512").update(archiveBytes).digest("hex"),
  };
  if (tarball.sha512.length !== 128) throw new Error("fixture tarball sha512 must be hex128");

  // --- release tree: package-lock.json at the release root, the package under
  // node_modules/jorgex-pi, and the six direct dependencies at top level.
  const buildRoot = join(npmDir, ".release-build");
  const nodeModules = join(buildRoot, "node_modules");
  const buildPackageRoot = join(nodeModules, RELEASE_PACKAGE_ROOT);
  const extensionsDir = join(buildPackageRoot, "extensions");
  for (const file of ["native-mcp.mjs", "context7-config.mjs", "mcp-engram.mjs"]) {
    copyFile(join(PI_ROOT, "extensions", file), join(extensionsDir, file));
  }
  copyFile(join(PI_ROOT, "package.json"), join(buildPackageRoot, "package.json"));

  const dependencies = dependenciesFromPnpmLock(
    readFileSync(join(PI_ROOT, "pnpm-lock.yaml"), "utf8"),
    dependencyNames,
  );
  // The one dependency the copied checker actually imports at runtime is a real
  // byte-identical copy; the other five are manifest stubs whose identity and
  // version match the lock.
  const strip = join(PI_ROOT, "node_modules", "strip-json-comments");
  copyFile(join(strip, "index.js"), join(nodeModules, "strip-json-comments", "index.js"));
  copyFile(join(strip, "package.json"), join(nodeModules, "strip-json-comments", "package.json"));
  for (const dependency of dependencies) {
    if (dependency.name === "strip-json-comments") continue;
    const stub = join(nodeModules, dependency.name, "package.json");
    mkdirSync(dirname(stub), { recursive: true });
    writeFileSync(stub, `${JSON.stringify({ name: dependency.name, version: dependency.version }, null, 2)}\n`);
  }

  const lock = releaseLock({
    version,
    dependencies,
    installedIntegrity: sha512Sri(archiveBytes),
  });
  const lockBytes = Buffer.from(`${JSON.stringify(lock, null, 2)}\n`, "utf8");
  writeFileSync(join(buildRoot, "package-lock.json"), lockBytes);
  assertReleaseLock(join(buildRoot, "package-lock.json"), { version, dependencies, installedIntegrity: sha512Sri(archiveBytes) });

  const copiedBytes = ["native-mcp.mjs", "context7-config.mjs", "mcp-engram.mjs"]
    .reduce((total, file) => total + readFileSync(join(extensionsDir, file)).length, 0)
    + readFileSync(join(buildPackageRoot, "package.json")).length
    + lockBytes.length
    + readFileSync(join(strip, "index.js")).length
    + readFileSync(join(strip, "package.json")).length;
  if (copiedBytes > 4 * 1024 * 1024) throw new Error(`fixture copy too large for a temp base: ${copiedBytes} bytes`);

  // The tree hash is taken after the npm lock and the dependencies are in place
  // and before the release id is derived, so the release path is never part of
  // the hashed content.
  const treeSha256 = specTreeSha256(buildRoot);
  const lockSha256 = sha256Hex(lockBytes);
  const releaseId = sha256Hex(Buffer.from(`${tarball.sha256}:${lockSha256}:${treeSha256}`, "utf8"));
  const releaseDir = join(releaseRoot, releaseId);
  renameSync(buildRoot, releaseDir);
  const packageRoot = join(releaseDir, "node_modules", RELEASE_PACKAGE_ROOT);
  if (specTreeSha256(releaseDir) !== treeSha256) throw new Error("fixture release tree changed while publishing");

  // Active managed entry: an exact relative symlink to the release package root.
  symlinkSync(`../jorgex-pi-managed/releases/${releaseId}/node_modules/${RELEASE_PACKAGE_ROOT}`, linkPath);

  // --- settings: the managed singleton entry is an object, not a bare string.
  writeFileSync(
    join(agentDir, "settings.json"),
    `${JSON.stringify({ packages: [{ source: `npm:jorgex-pi@${version}`, skills: [], prompts: [] }] }, null, 2)}\n`,
  );

  // --- strict native mcp.json: the official Engram definition plus the context7
  // entry the projection receipt claims.
  const context7Entry = { url: CONTEXT7_URL };
  writeFileSync(
    join(agentDir, "mcp.json"),
    `${JSON.stringify({
      mcpServers: {
        engram: { command: process.execPath, args: ["mcp", "--tools=agent"], exposure: "deferred" },
        context7: context7Entry,
      },
    }, null, 2)}\n`,
  );

  // --- protected owned projection files (never the shared mcp.json).
  const agentsFile = join(agentDir, "AGENTS.md");
  const skillFile = join(agentDir, "skills", "demo", "SKILL.md");
  writeFileSync(agentsFile, "# fixture projected policy\n");
  writeFileSync(skillFile, "# fixture projected skill\n");

  const engramBinary = join(root, "bin", "engram");
  mkdirSync(dirname(engramBinary), { recursive: true });
  writeFileSync(engramBinary, "fake Engram binary; never execute\n");
  chmodSync(engramBinary, 0o755);

  // --- schema-1 main receipt with the published managedPackage evidence.
  const receipt = {
    schemaVersion: 1,
    state: "installed",
    candidate: {
      package: { name: pkg.name, version, source: `npm:jorgex-pi@${version}` },
      tarball,
      provenance: { commit: sha256Hex("fixture-provenance").slice(0, 40) },
    },
    scope: { kind: "real", codingAgentDir: agentDir },
    engram: { binary: engramBinary },
    managedPackage: {
      releaseDir,
      linkPath,
      backupDir,
      lockSha256,
      treeSha256,
      dependencies,
    },
  };
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  writeFileSync(join(backupDir, ".keep"), "fixture backup marker\n");

  // --- granular projection receipt: the only authority that makes an entry
  // owned. The digest comes from the public export of the running package; the
  // cleanup stamp is the Spec's JSON.stringify authorization for a wholly
  // created entry.
  const projection = {
    schemaVersion: 1,
    scope: { kind: "real", home, codingAgentDir: agentDir, receiptFile: projectionPath },
    owned: [agentsFile, skillFile],
    mcpNative: {
      schemaVersion: 1,
      entries: {
        context7: {
          definitionSha256: digestNativeMcpDefinition("context7", context7Entry),
          cleanupSha256: sha256Hex(JSON.stringify(context7Entry)),
        },
      },
    },
  };
  writeFileSync(projectionPath, `${JSON.stringify(projection, null, 2)}\n`);

  return {
    root,
    home,
    agentDir,
    projectDir: root,
    env: { HOME: home, PI_CODING_AGENT_DIR: agentDir, XDG_CONFIG_HOME: join(root, "xdg-config") },
    projectTrusted,
    version,
    receiptPath,
    projectionPath,
    cachePath,
    lockPath: join(releaseDir, "package-lock.json"),
    linkPath,
    releaseDir,
    packageRoot,
    releaseId,
    backupDir,
    entryModulePath: join(linkPath, "extensions", "native-mcp.mjs"),
    copiedBytes,
    lockSha256,
    treeSha256,
    dependencies,
    tarball,
  };
}

// Fixture coherence: the release root must carry a lockfileVersion 3 npm lock
// whose `packages` map holds the installed package entry and one entry per
// dependency with matching version and SRI. A RED can never be produced by a
// bad fixture when this passes before the checker is called.
function assertReleaseLock(lockPath, { version, dependencies, installedIntegrity }) {
  if (!existsSync(lockPath)) throw new Error(`fixture release misses package-lock.json at ${lockPath}`);
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  if (lock.lockfileVersion !== 3) throw new Error("fixture release lock must be lockfileVersion 3");
  const installed = lock.packages?.[`node_modules/${RELEASE_PACKAGE_ROOT}`];
  if (installed?.version !== version) throw new Error("fixture release lock installed version != manifest version");
  if (installed?.integrity !== installedIntegrity) throw new Error("fixture release lock installed integrity != cached archive SRI");
  for (const dep of dependencies) {
    const entry = lock.packages?.[`node_modules/${dep.name}`];
    if (entry?.version !== dep.version || entry?.integrity !== dep.integrity) {
      throw new Error(`fixture release lock entry mismatch for ${dep.name}`);
    }
  }
}

export function assertReleaseLockCoherence(sandbox) {
  assertReleaseLock(sandbox.lockPath, {
    version: sandbox.version,
    dependencies: sandbox.dependencies,
    installedIntegrity: sha512Sri(readFileSync(sandbox.cachePath)),
  });
}

// Test-only synthetic rebind: after a test mutates the release tree, the raw
// lock hash, the tree hash, the release id, the release directory and the
// active entry are recomputed from the mutated bytes and the main receipt is
// pointed at them. This is fixture bookkeeping so the ONLY remaining defect is
// the one under test (symlink topology or SRI canonicality), never a stale
// hash; nothing is emitted, signed, downloaded or authenticated, and no
// production acceptance changes. The fixture's own encoder is used, so the
// hashed bytes are exactly the mutated ones.
export function rebindManagedRelease(sandbox) {
  const releasesRoot = dirname(sandbox.releaseDir);
  const lockBytes = readFileSync(sandbox.lockPath);
  const lockSha256 = sha256Hex(lockBytes);
  const treeSha256 = specTreeSha256(sandbox.releaseDir);
  const releaseId = sha256Hex(Buffer.from(`${sandbox.tarball.sha256}:${lockSha256}:${treeSha256}`, "utf8"));
  const releaseDir = join(releasesRoot, releaseId);
  renameSync(sandbox.releaseDir, releaseDir);
  rmSync(sandbox.linkPath);
  symlinkSync(`../jorgex-pi-managed/releases/${releaseId}/node_modules/${RELEASE_PACKAGE_ROOT}`, sandbox.linkPath);

  const receipt = JSON.parse(readFileSync(sandbox.receiptPath, "utf8"));
  receipt.managedPackage.releaseDir = releaseDir;
  receipt.managedPackage.lockSha256 = lockSha256;
  receipt.managedPackage.treeSha256 = treeSha256;
  writeFileSync(sandbox.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

  sandbox.releaseDir = releaseDir;
  sandbox.releaseId = releaseId;
  sandbox.packageRoot = join(releaseDir, "node_modules", RELEASE_PACKAGE_ROOT);
  sandbox.lockPath = join(releaseDir, "package-lock.json");
  sandbox.entryModulePath = join(sandbox.linkPath, "extensions", "native-mcp.mjs");
  sandbox.lockSha256 = lockSha256;
  sandbox.treeSha256 = treeSha256;
  return sandbox;
}
