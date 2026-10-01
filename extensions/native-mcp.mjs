import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readlinkSync,
  readdirSync,
  readSync,
  realpathSync,
} from "node:fs";
import { dirname, join, posix, relative, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { readConfig, resolvePiAgentDir } from "./context7-config.mjs";
import { digestNativeMcpDefinition, readBoundedRegularFile, resolveNativeDevtoolsDefinition } from "./mcp-engram.mjs";

// Readonly ownership checker for the persistent native MCP configuration.
// It never writes, spawns, downloads or claims a connection. Ownership is authority, never shape:
// a present entry is `unowned` unless a granular `mcpNative` claim matches, and
// a claim is `managed` only after the offline package proof verifies and the
// protected digest matches. The package root is derived internally from this
// module's URL; no public package-root parameter exists, so a checkout or stage
// can never certify another installation.
const SERVER_NAMES = ["engram", "context7", "chrome-devtools"];
const KNOWN_NAMES = new Set(SERVER_NAMES);
const PACKAGE_NAME = "jorgex-pi";
const AUTHORITY_MAX_BYTES = 1024 * 1024;
const DEVTOOLS_HANDOFF_MAX_BYTES = 1024 * 1024;
const RECEIPT_MAX_BYTES = 1024 * 1024;
const SETTINGS_MAX_BYTES = 1024 * 1024;
const MANIFEST_MAX_BYTES = 1024 * 1024;
const LOCK_MAX_BYTES = 4 * 1024 * 1024;
const ARCHIVE_MAX_BYTES = 128 * 1024 * 1024;
const TREE_MAX_BYTES = 512 * 1024 * 1024;
const HASH_CHUNK_BYTES = 1024 * 1024;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const SHA512_HEX = /^[0-9a-f]{128}$/;
const SRI_SHA512_B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const STAGE_NAME = /^stage-[0-9a-f]{32}$/;

// Startup cache: the heavy offline proof is a once-per-startup cost
// keyed by a cheap identity, while configuration, projection authority and
// preferences stay fresh on every inspection. A single module-local entry, never
// a history or dictionary.
let lastIdentityCachedProof;

export async function inspectNativeMcpOwnership({
  env = process.env,
  platform = process.platform,
  cwd = process.cwd(),
  projectTrusted = false,
} = {}) {
  const paths = platform === "win32" ? win32 : posix;
  const home = requireAbsoluteHome(env, platform);
  const agentDir = resolvePiAgentDir({ env, cwd, platform });
  const config = readNativeConfig(paths.join(agentDir, "mcp.json"));
  const authority = readProjectionClaims({ home, agentDir, platform, paths });
  const proof = verifyManagedPackage({ home, agentDir, platform, paths, required: authority.claims.size > 0 });
  const servers = {};
  for (const name of SERVER_NAMES) {
    servers[name] = inspectServer(name, config?.mcpServers?.[name], authority.claims.get(name), proof, {
      devtoolsSha256: authority.devtoolsSha256,
      env,
      platform,
      agentDir,
      paths,
    });
  }
  applyTrustedProjectOverrides(servers, { cwd, projectTrusted, paths });
  return {
    servers,
    package: proof.reason ? { state: proof.state, reason: proof.reason } : { state: proof.state },
    connection: "not-verified",
  };
}

// Trusted project scope: Pi reads `<cwd>/.pi/mcp.json` only for a trusted project
// and a project entry replaces the global entry by name. The readonly reader
// cannot validate that replacement, so the global granular claim must never
// authorize it: any project entry naming a protected server becomes an effective
// conflict (cleanup-ineligible, unavailable), even when the definition is
// identical. Trust is provided by the caller context, never inferred from the
// file; an untrusted project is never read (even a malformed one stays inert),
// and the global inspection result is otherwise unchanged.
function applyTrustedProjectOverrides(servers, { cwd, projectTrusted, paths }) {
  if (projectTrusted !== true) return;
  if (typeof cwd !== "string" || !paths.isAbsolute(cwd)) {
    throw new Error("Native MCP inspection requires an absolute project cwd");
  }
  const projectConfig = readNativeConfig(paths.join(cwd, ".pi", "mcp.json"));
  const projectServers = projectConfig?.mcpServers;
  if (!isRecord(projectServers)) return;
  for (const name of SERVER_NAMES) {
    if (!Object.hasOwn(projectServers, name)) continue;
    servers[name] = {
      state: "conflict",
      cleanupEligible: false,
      availability: "unavailable",
      reason: "Native MCP project override is not validated by the readonly reader",
    };
  }
}

function requireAbsoluteHome(env, platform) {
  const paths = platform === "win32" ? win32 : posix;
  const home = platform === "win32" ? env.USERPROFILE ?? env.HOME : env.HOME ?? env.USERPROFILE;
  if (typeof home !== "string" || !paths.isAbsolute(home)) {
    throw new Error("Native MCP inspection requires an absolute HOME");
  }
  return home;
}

// Pi's native parser is strict JSON; the shared bounded reader is reused with
// its strict mode. Any failure is generic so no raw configuration or user data
// reaches a diagnostic, and an invalid file never becomes a silent success.
function readNativeConfig(mcpPath) {
  let config;
  try {
    config = readConfig(mcpPath, { strict: true });
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw new Error("Native MCP configuration is invalid or unreadable");
  }
  if (!isRecord(config)) throw new Error("Native MCP configuration must be an object");
  if (config.mcpServers !== undefined && !isRecord(config.mcpServers)) {
    throw new Error("Native MCP configuration has an invalid mcpServers section");
  }
  return config;
}

// The granular authority is read only; a symlinked, malformed or unreadable
// receipt fails closed instead of degrading to an unowned success.
function readProjectionClaims({ home, agentDir, platform, paths }) {
  const authorityPath = join(home, ".jorgex-stack", "pi-projection-receipt.json");
  let bytes;
  try {
    bytes = readOptionalRegularBytes(authorityPath, AUTHORITY_MAX_BYTES, "Native MCP projection authority");
  } catch {
    throw new Error("Native MCP projection authority is unreadable");
  }
  if (bytes === undefined) return { claims: new Map(), devtoolsSha256: undefined };
  let authority;
  try {
    authority = parseStrictJson(bytes);
  } catch {
    throw new Error("Native MCP projection authority is invalid");
  }
  if (!isRecord(authority) || authority.schemaVersion !== 1) {
    throw new Error("Native MCP projection authority has an unsupported shape");
  }
  const scope = authority.scope;
  if (!isRecord(scope)
    || (scope.kind !== "real" && scope.kind !== "target-dir")
    || typeof scope.home !== "string" || !samePath(scope.home, home, paths, platform)
    || typeof scope.codingAgentDir !== "string" || !samePath(scope.codingAgentDir, agentDir, paths, platform)) {
    throw new Error("Native MCP projection authority has an incoherent scope");
  }
  if (!Array.isArray(authority.owned)
    || authority.owned.some((entry) => typeof entry !== "string" || !paths.isAbsolute(entry))) {
    throw new Error("Native MCP projection authority has an invalid owned list");
  }
  // The DevTools chain reads the whole-handoff stamp as a sibling authority
  // field; it is carried alongside the claims and never cached.
  const devtoolsSha256 = isRecord(authority.devtools) && typeof authority.devtools.sha256 === "string"
    ? authority.devtools.sha256
    : undefined;
  if (authority.mcpNative === undefined) return { claims: new Map(), devtoolsSha256 };
  const mcpNative = authority.mcpNative;
  if (!isRecord(mcpNative) || mcpNative.schemaVersion !== 1 || !isRecord(mcpNative.entries)) {
    throw new Error("Native MCP projection authority has an unsupported mcpNative shape");
  }
  const claims = new Map();
  for (const [name, claim] of Object.entries(mcpNative.entries)) {
    if (!KNOWN_NAMES.has(name)
      || !isRecord(claim)
      || typeof claim.definitionSha256 !== "string" || !SHA256_HEX.test(claim.definitionSha256)
      || (claim.cleanupSha256 !== undefined
        && (typeof claim.cleanupSha256 !== "string" || !SHA256_HEX.test(claim.cleanupSha256)))) {
      throw new Error("Native MCP projection authority has an invalid claim");
    }
    claims.set(name, { definitionSha256: claim.definitionSha256, cleanupSha256: claim.cleanupSha256 });
  }
  return { claims, devtoolsSha256 };
}

// Offline package proof. The direct channel with no granular claim needs no
// heavy proof, so it is `not-required` and the receipt is not even read (the
// startup cache is cleared conservatively). Once a claim exists the proof is
// mandatory: a missing or incoherent receipt is a visible `conflict` (never a
// silent `not-required` or unowned success). A verified (or failed) proof is
// memoized on the cheap startup identity, so a repeated inspection of the same
// installation never re-opens the archive or the release tree.
function verifyManagedPackage({ home, agentDir, platform, paths, required }) {
  if (!required) {
    lastIdentityCachedProof = undefined;
    return { state: "not-required" };
  }
  const identified = identifyManagedReceipt({ home, agentDir, paths });
  if (identified === undefined) {
    // A missing or unreadable main receipt or active entry is unproven
    // ownership; never let a stale verified cache answer for it.
    lastIdentityCachedProof = undefined;
    return { state: "conflict", reason: "Native MCP package proof is required for claimed entries" };
  }
  if (lastIdentityCachedProof !== undefined && lastIdentityCachedProof.identity === identified.identity) {
    return lastIdentityCachedProof.reason
      ? { state: lastIdentityCachedProof.state, reason: lastIdentityCachedProof.reason }
      : { state: lastIdentityCachedProof.state };
  }
  let proof;
  try {
    assertManagedReceipt(parseStrictJson(identified.bytes), { home, agentDir, platform, paths });
    proof = { state: "verified" };
  } catch {
    proof = { state: "conflict", reason: "Native MCP package proof failed" };
  }
  lastIdentityCachedProof = {
    identity: identified.identity,
    state: proof.state,
    ...(proof.reason ? { reason: proof.reason } : {}),
  };
  return proof;
}

// Cheap startup identity: the raw receipt fingerprint (which already covers the
// candidate version/source and the lock, tree and tarball hashes), the physical
// package root derived from this module's URL, the active entry realpath and the
// home/agent scope, so another installation or fixture can never reuse the
// cached proof. Missing or unreadable identifiers yield undefined.
function identifyManagedReceipt({ home, agentDir, paths }) {
  let bytes;
  try {
    bytes = readOptionalRegularBytes(
      join(home, ".jorgex-stack", "pi-receipt.json"),
      RECEIPT_MAX_BYTES,
      "Native MCP package receipt",
    );
  } catch {
    return undefined;
  }
  if (bytes === undefined) return undefined;
  let ownRoot;
  let entryRealpath;
  try {
    ownRoot = realpathSync(join(dirname(fileURLToPath(import.meta.url)), ".."));
    entryRealpath = realpathSync(join(agentDir, "npm", "node_modules", PACKAGE_NAME));
  } catch {
    return undefined;
  }
  const identity = [
    "v1",
    sha256Hex(bytes),
    ownRoot,
    entryRealpath,
    paths.resolve(home),
    paths.resolve(agentDir),
  ].join("\u0000");
  return { identity, bytes };
}

function assertManagedReceipt(receipt, { home, agentDir, platform, paths }) {
  if (!isRecord(receipt) || receipt.schemaVersion !== 1 || receipt.state !== "installed") throw new Error("receipt");
  const { candidate, scope, engram, managedPackage: managed } = receipt;
  if (!isRecord(candidate) || !isRecord(candidate.package) || !isRecord(candidate.tarball)
    || !isRecord(candidate.provenance) || !isRecord(scope) || !isRecord(engram) || !isRecord(managed)) {
    throw new Error("receipt shape");
  }
  const { name, version, source } = candidate.package;
  if (name !== PACKAGE_NAME || typeof version !== "string" || !version
    || source !== `npm:${name}@${version}`) throw new Error("candidate package");
  const { bytes, sha256, sha512 } = candidate.tarball;
  if (!Number.isSafeInteger(bytes) || bytes < 0
    || typeof sha256 !== "string" || !SHA256_HEX.test(sha256)
    || typeof sha512 !== "string" || !SHA512_HEX.test(sha512)) throw new Error("tarball");
  if (typeof candidate.provenance.commit !== "string" || candidate.provenance.commit.length === 0) {
    throw new Error("provenance");
  }
  if ((scope.kind !== "real" && scope.kind !== "target-dir")
    || typeof scope.codingAgentDir !== "string" || !samePath(scope.codingAgentDir, agentDir, paths, platform)) {
    throw new Error("scope");
  }
  if (typeof engram.binary !== "string" || !paths.isAbsolute(engram.binary)) throw new Error("engram");

  const { releaseDir, linkPath, backupDir, lockSha256, treeSha256, dependencies } = managed;
  if (typeof releaseDir !== "string" || !paths.isAbsolute(releaseDir)
    || typeof linkPath !== "string" || !paths.isAbsolute(linkPath)
    || typeof backupDir !== "string" || !paths.isAbsolute(backupDir)
    || typeof lockSha256 !== "string" || !SHA256_HEX.test(lockSha256)
    || typeof treeSha256 !== "string" || !SHA256_HEX.test(treeSha256)
    || !Array.isArray(dependencies)) throw new Error("managedPackage");

  // The running module root is derived from this module's URL and must be the
  // release package root, the active entry and the manifest the receipt names.
  const ownRoot = realpathSync(join(dirname(fileURLToPath(import.meta.url)), ".."));
  const manifest = parseStrictJson(readRequiredRegularBytes(join(ownRoot, "package.json"), MANIFEST_MAX_BYTES, "manifest"));
  if (manifest.name !== name || manifest.version !== version) throw new Error("manifest identity");

  const releasesRoot = join(agentDir, "npm", "jorgex-pi-managed", "releases");
  const expectedReleaseId = sha256Hex(Buffer.from(`${sha256}:${lockSha256}:${treeSha256}`, "utf8"));
  if (paths.basename(releaseDir) !== expectedReleaseId
    || !samePath(paths.dirname(releaseDir), releasesRoot, paths, platform)) throw new Error("release id");
  if (!samePath(linkPath, join(agentDir, "npm", "node_modules", PACKAGE_NAME), paths, platform)) {
    throw new Error("link path");
  }
  if (paths.basename(backupDir) !== ".activate-backup"
    || paths.basename(paths.dirname(backupDir)) !== "pi-agent"
    || !STAGE_NAME.test(paths.basename(paths.dirname(paths.dirname(backupDir))))
    || !samePath(paths.dirname(paths.dirname(paths.dirname(backupDir))), agentDir, paths, platform)) {
    throw new Error("backup path");
  }
  const activeRoot = realpathSync(join(agentDir, "npm", "node_modules", PACKAGE_NAME));
  const releasePackageRoot = realpathSync(join(releaseDir, "node_modules", PACKAGE_NAME));
  if (!samePath(ownRoot, activeRoot, paths, platform) || !samePath(ownRoot, releasePackageRoot, paths, platform)) {
    throw new Error("root bind");
  }

  assertManagedSettings(
    parseStrictJson(readRequiredRegularBytes(join(agentDir, "settings.json"), SETTINGS_MAX_BYTES, "settings")),
    version,
  );

  // The archive is hashed by fd streaming with a single reused 1 MiB buffer, so
  // a legal 128 MiB tarball is never concatenated into memory. SHA256, SHA512
  // (hex) and the canonical SRI all come from the same streamed pass.
  const archive = hashStreamedArchive(join(home, ".jorgex-stack", "packages", `${PACKAGE_NAME}-${version}.tgz`));
  if (archive.bytes !== bytes || archive.sha256Hex !== sha256 || archive.sha512Hex !== sha512) {
    throw new Error("archive");
  }

  const lockBytes = readRequiredRegularBytes(join(releaseDir, "package-lock.json"), LOCK_MAX_BYTES, "lock");
  if (sha256Hex(lockBytes) !== lockSha256) throw new Error("lock hash");
  const lock = parseStrictJson(lockBytes);
  if (!isRecord(lock) || lock.lockfileVersion !== 3 || !isRecord(lock.packages)) throw new Error("lock shape");
  const installed = lock.packages[`node_modules/${PACKAGE_NAME}`];
  if (!isRecord(installed) || installed.version !== version) throw new Error("lock installed entry");
  if (typeof installed.integrity === "string" && installed.integrity !== archive.sri) {
    throw new Error("lock installed integrity");
  }

  const manifestDependencies = isRecord(manifest.dependencies) ? Object.keys(manifest.dependencies) : [];
  if (dependencies.length === 0 || dependencies.length !== manifestDependencies.length
    || new Set(dependencies.map((dep) => dep?.name)).size !== dependencies.length) {
    throw new Error("dependencies");
  }
  for (const dependency of dependencies) {
    if (!isRecord(dependency)
      || typeof dependency.name !== "string" || !manifestDependencies.includes(dependency.name)
      || typeof dependency.version !== "string"
      || canonicalSha512Bytes(dependency.integrity) === undefined) {
      throw new Error("dependency shape");
    }
    const lockEntry = lock.packages[`node_modules/${dependency.name}`];
    if (!isRecord(lockEntry)
      || lockEntry.version !== dependency.version
      || lockEntry.integrity !== dependency.integrity) throw new Error("dependency lock");
    const dependencyManifest = parseStrictJson(readRequiredRegularBytes(
      join(releaseDir, "node_modules", dependency.name, "package.json"),
      MANIFEST_MAX_BYTES,
      "dependency manifest",
    ));
    if (dependencyManifest.name !== dependency.name || dependencyManifest.version !== dependency.version) {
      throw new Error("dependency manifest");
    }
  }

  if (specTreeSha256(releaseDir, paths) !== treeSha256) throw new Error("tree hash");
}

// The published Stack contract (`filterProjectedPiPackage` /
// `isJorgeXPiSource` in `src/lib/pi-package-lifecycle.ts`) locates the managed
// registration as the one own `jorgex-pi` entry inside `settings.packages`.
// `packages` is a global list shared with other packages, so foreign and
// gentle-engram entries stay preserved and untouched: only the own record is
// identified and validated, and ambiguity (zero or duplicate own records) fails
// closed instead of picking one.
function packageSourceValue(entry) {
  if (typeof entry === "string") return entry;
  if (isRecord(entry) && typeof entry.source === "string") return entry.source;
  return undefined;
}

// The own registration is the exact unscoped package source: `npm:jorgex-pi`
// alone or `npm:jorgex-pi@...`. A foreign package whose name merely contains the
// substring (e.g. `npm:my-jorgex-pi-helper`) or another scoped package is never
// an own registration, so its presence cannot claim the user's local files nor
// fabricate a duplicate own identity. A bare `npm:jorgex-pi` still counts as own
// and is then disallowed by the exact managed source/version validation below.
function isJorgeXPiSource(source) {
  return typeof source === "string" && /^npm:jorgex-pi(?:@|$)/.test(source);
}

function assertManagedSettings(settings, version) {
  if (!isRecord(settings) || !Array.isArray(settings.packages)) throw new Error("settings");
  const ownEntries = settings.packages.filter((entry) => isJorgeXPiSource(packageSourceValue(entry)));
  if (ownEntries.length !== 1) throw new Error("settings own registration");
  const entry = ownEntries[0];
  if (!isRecord(entry)
    || Object.keys(entry).sort().join(",") !== "prompts,skills,source"
    || entry.source !== `npm:${PACKAGE_NAME}@${version}`
    || !Array.isArray(entry.skills) || entry.skills.length !== 0
    || !Array.isArray(entry.prompts) || entry.prompts.length !== 0) {
    throw new Error("settings entry");
  }
}

// Release tree hash: `kind` NUL `rel` NUL raw payload, relative slash paths, JS
// ordinal sort, no root entry and no browser-v2 framing. File bytes are streamed
// into the running hash with the same reused 1 MiB buffer, and every symlink
// must satisfy the published containment walk (`readContainedLinkTarget`).
function specTreeSha256(root, paths) {
  const resolvedRoot = realpathSync(root);
  const entries = [];
  const pending = [resolvedRoot];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const dirent of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, dirent.name);
      const rel = relative(resolvedRoot, full).split(sep).join("/");
      if (dirent.isSymbolicLink()) {
        entries.push({ rel, kind: "symlink", target: readContainedLinkTarget(full, resolvedRoot, paths) });
      } else if (dirent.isDirectory()) {
        entries.push({ rel, kind: "dir" });
        pending.push(full);
      } else if (dirent.isFile()) {
        entries.push({ rel, kind: "file", full });
      } else {
        throw new Error("Native MCP release contains an unsupported entry");
      }
    }
  }
  entries.sort((left, right) => (left.rel < right.rel ? -1 : left.rel > right.rel ? 1 : 0));
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
  let total = 0;
  for (const entry of entries) {
    hash.update(entry.kind, "utf8");
    hash.update("\0", "utf8");
    hash.update(entry.rel, "utf8");
    hash.update("\0", "utf8");
    if (entry.kind === "symlink") hash.update(entry.target, "utf8");
    else if (entry.kind === "file") {
      total += streamFileChunks(entry.full, "tree file", TREE_MAX_BYTES - total, (chunk) => hash.update(chunk), buffer);
    }
  }
  return hash.digest("hex");
}

// Mirrors the canonical Stack `readContainedLinkTarget` in
// `src/lib/pi-staged-lock.ts`: walk the raw relative target component by
// component from the link parent with lstat, never following. Absolute targets,
// lexical escapes, broken entries and symlink chains are rejected, including an
// intermediate directory symlink whose final component is an ordinary file.
// Direct npm `.bin` links (`../pkg/bin/file` through real directories) stay
// accepted and the target is recorded raw, never followed. Messages stay
// generic so no path or user value is echoed.
function readContainedLinkTarget(linkPath, allowedRoot, paths) {
  let target;
  try {
    target = readlinkSync(linkPath);
  } catch {
    throw new Error("Native MCP release symlink is broken or unreadable");
  }
  if (target === "" || paths.isAbsolute(target)) {
    throw new Error("Native MCP release symlink must be relative");
  }
  const linkParent = paths.dirname(paths.resolve(linkPath));
  const isStrictChild = (child) => {
    const rel = paths.relative(allowedRoot, child);
    return rel !== "" && rel !== ".." && !rel.startsWith(`..${paths.sep}`) && !paths.isAbsolute(rel);
  };
  // Windows targets may use either separator (`/` or `\`); POSIX backslash is a
  // valid file name and must never be split. The raw target string is still
  // returned unchanged and fed into the tree hash exactly as read.
  const parts = target.split(paths === win32 ? /[\\/]/ : "/").filter((part) => part !== "" && part !== ".");
  if (parts.length === 0) throw new Error("Native MCP release symlink escapes its tree");
  let current = linkParent;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    const isLast = index === parts.length - 1;
    const next = part === ".." ? paths.dirname(current) : paths.join(current, part);
    if (next !== allowedRoot && !isStrictChild(next)) {
      throw new Error("Native MCP release symlink escapes its tree");
    }
    const stat = lstatOrUndefined(next);
    if (stat === undefined) throw new Error("Native MCP release symlink is broken");
    if (stat.isSymbolicLink()) throw new Error("Native MCP release symlink chain");
    if (isLast) {
      // A final `..` must resolve to a directory; a final ordinary part may be a
      // file or a directory.
      const acceptable = part === ".." ? stat.isDirectory() : stat.isFile() || stat.isDirectory();
      if (!acceptable) throw new Error("Native MCP release symlink must point to a file or directory");
    } else if (!stat.isDirectory()) {
      throw new Error("Native MCP release symlink walks through a non-directory");
    }
    current = next;
  }
  return target;
}

function lstatOrUndefined(filePath) {
  try {
    return lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw new Error("Native MCP release symlink is unreadable");
  }
}

function inspectServer(name, entry, claim, proof, context) {
  if (entry === undefined) {
    return {
      state: claim ? "conflict" : "absent",
      cleanupEligible: false,
      availability: "unavailable",
      ...(claim ? { reason: "Claimed native MCP entry is absent from mcp.json" } : {}),
    };
  }
  let digest;
  try {
    digest = digestNativeMcpDefinition(name, entry);
  } catch {
    // A present entry that is not a valid managed definition can never be
    // silently digested or reported unowned: it fails closed as conflict.
    return {
      state: "conflict",
      cleanupEligible: false,
      availability: "unavailable",
      reason: "Native MCP definition is invalid or unsupported",
    };
  }
  const availability = entry.enabled === false || entry.exposure === "hidden"
    ? "disabled"
    : hasRawExecutionCustomization(entry) ? "unsupported-execution" : "configured";
  if (claim) {
    if (proof.state !== "verified" || digest !== claim.definitionSha256) {
      return {
        state: "conflict",
        cleanupEligible: false,
        availability,
        reason: "Native MCP ownership claim could not be verified",
      };
    }
    // DevTools requires the whole-handoff receipt stamp AND the trusted v3
    // guard: a matching definition digest alone never owns a script.
    if (name === "chrome-devtools" && !devtoolsChainOwned(entry, context)) {
      return {
        state: "conflict",
        cleanupEligible: false,
        availability,
        reason: "Native Chrome DevTools ownership could not be verified",
      };
    }
    return {
      state: "managed",
      cleanupEligible: typeof claim.cleanupSha256 === "string"
        && sha256Hex(Buffer.from(JSON.stringify(entry), "utf8")) === claim.cleanupSha256,
      availability,
    };
  }
  // Availability is syntax only: a present definition is configured, never a
  // connection claim, and without a claim it is never owned or cleanup-eligible.
  return { state: "unowned", cleanupEligible: false, availability };
}

// DevTools ownership: a DevTools claim is owned only when the projection stamped the
// WHOLE handoff file (`devtools.sha256`) and the persisted command/args EXACTLY
// equal the trusted v3 resolution of that handoff. A plain launcher, a v1/v2
// fallback or any arbitrary script with a matching definition digest is never
// enough. Re-read fresh on every inspection; never cached, never writing.
function devtoolsChainOwned(entry, { devtoolsSha256, env, platform, agentDir, paths }) {
  if (typeof devtoolsSha256 !== "string" || !SHA256_HEX.test(devtoolsSha256)) return false;
  const handoffPath = paths.join(agentDir, "jorgex-pi", "devtools.v1.json");
  let handoffBytes;
  try {
    handoffBytes = readOptionalRegularBytes(handoffPath, DEVTOOLS_HANDOFF_MAX_BYTES, "Chrome DevTools handoff");
  } catch {
    return false;
  }
  if (handoffBytes === undefined || sha256Hex(handoffBytes) !== devtoolsSha256) return false;
  let guard;
  try {
    guard = resolveNativeDevtoolsDefinition({ env, platform });
  } catch {
    return false;
  }
  if (!isRecord(guard)) return false;
  return sameGuardDefinition(entry, guard);
}

function sameGuardDefinition(entry, guard) {
  if (typeof entry.command !== "string" || entry.command !== guard.command) return false;
  if (!Array.isArray(entry.args) || !Array.isArray(guard.args) || entry.args.length !== guard.args.length) {
    return false;
  }
  return entry.args.every((value, index) => value === guard.args[index]);
}

// Raw, user-authored `!` executions stay inert data: they classify availability
// as unsupported-execution without being resolved, imported or executed.
function hasRawExecutionCustomization(entry) {
  for (const key of ["env", "headers"]) {
    const record = entry?.[key];
    if (isRecord(record) && Object.values(record).some((value) => typeof value === "string" && value.startsWith("!"))) {
      return true;
    }
  }
  return false;
}

function readOptionalRegularBytes(filePath, maxBytes, label) {
  let stat;
  try {
    stat = lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw new Error(`${label} is unreadable`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular file`);
  return readBoundedRegularFile(filePath, maxBytes, label);
}

function readRequiredRegularBytes(filePath, maxBytes, label) {
  const bytes = readOptionalRegularBytes(filePath, maxBytes, label);
  if (bytes === undefined) throw new Error(`${label} is missing`);
  return bytes;
}

function parseStrictJson(bytes) {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// Strict canonical sha512 SRI, mirroring Stack's `assertCanonicalSha512`: the
// base64 body must decode to exactly 64 bytes and re-encode to the same string,
// so a shape-valid but short body is not canonical. Returns the digest bytes or
// undefined; never echoes the value.
function canonicalSha512Bytes(integrity) {
  if (typeof integrity !== "string" || !integrity.startsWith("sha512-")) return undefined;
  const body = integrity.slice("sha512-".length);
  if (!SRI_SHA512_B64.test(body)) return undefined;
  let bytes;
  try {
    bytes = Buffer.from(body, "base64");
  } catch {
    return undefined;
  }
  return bytes.length === 64 && bytes.toString("base64") === body ? bytes : undefined;
}

// Streams a bounded regular file through `onChunk`, reusing the caller's ONE
// 1 MiB buffer and checking the running counter before any bytes reach the
// hashes. The fd is opened O_NOFOLLOW where available, fstat-verified as a
// regular file, and closed on every path.
function streamFileChunks(filePath, label, maxBytes, onChunk, buffer) {
  const opened = openStreamedRegularFile(filePath, label);
  let primary;
  try {
    if (opened.size > maxBytes) throw new Error(`${label} exceeds its size bound`);
    let total = 0;
    for (;;) {
      let read;
      try {
        read = readSync(opened.fd, buffer, 0, buffer.length, null);
      } catch {
        throw new Error(`${label} is unreadable`);
      }
      if (read === 0) break;
      total += read;
      if (total > maxBytes) throw new Error(`${label} exceeds its size bound`);
      onChunk(buffer.subarray(0, read));
    }
    let finalStat;
    try {
      finalStat = fstatSync(opened.fd);
    } catch {
      throw new Error(`${label} is unreadable`);
    }
    if (!finalStat.isFile() || finalStat.size !== total) {
      throw new Error(`${label} changed while it was being verified`);
    }
    return total;
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    try {
      closeSync(opened.fd);
    } catch (error) {
      if (!primary) throw new Error(`${label} is unreadable`);
    }
  }
}

function openStreamedRegularFile(filePath, label) {
  const flags = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0);
  let fd;
  try {
    fd = openSync(filePath, flags);
  } catch {
    throw new Error(`${label} is unreadable`);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0) {
      throw new Error(`${label} must be a regular file`);
    }
    // Best-effort identity: the opened fd must be the same inode the lstat view
    // names, so a swapped file is refused instead of hashed.
    if (Number.isSafeInteger(stat.dev) && Number.isSafeInteger(stat.ino) && stat.ino !== 0) {
      const linkStat = lstatOrUndefined(filePath);
      if (linkStat !== undefined && (linkStat.dev !== stat.dev || linkStat.ino !== stat.ino)) {
        throw new Error(`${label} changed while it was being verified`);
      }
    }
    return { fd, size: stat.size };
  } catch (error) {
    try {
      closeSync(fd);
    } catch {
      // Preserve the primary filesystem error.
    }
    throw error;
  }
}

// One streamed pass over the cached archive yields the byte count, SHA256 hex,
// SHA512 hex and the canonical sha512 SRI without materializing the payload.
function hashStreamedArchive(filePath) {
  const sha256 = createHash("sha256");
  const sha512 = createHash("sha512");
  const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
  const bytes = streamFileChunks(filePath, "archive", ARCHIVE_MAX_BYTES, (chunk) => {
    sha256.update(chunk);
    sha512.update(chunk);
  }, buffer);
  const digest = sha512.digest();
  return {
    bytes,
    sha256Hex: sha256.digest("hex"),
    sha512Hex: digest.toString("hex"),
    sri: `sha512-${digest.toString("base64")}`,
  };
}

function samePath(left, right, paths, platform) {
  const resolvedLeft = paths.resolve(left);
  const resolvedRight = paths.resolve(right);
  return platform === "win32"
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
