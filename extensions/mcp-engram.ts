import { createHash } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectContext7Config, inspectOfficialPackages, readConfig, resolvePiAgentDir } from "./context7-config.mjs";

// Synchronous runtime registration event published by the external
// pi-mcp-adapter contract observed by the smoke harness (version 1):
// { version: 1, name, definition }.
// The adapter answers inline on request.result as
// { ok: true, registration: { dispose } } with no top-level dispose or
// snapshot; snapshots flow through the separate runtime-snapshot:v1 event
// ({ version: 1, name } -> { ok, snapshot?, error? }).
export const RUNTIME_REGISTER_EVENT = "pi-mcp-adapter:runtime-register:v1";
export const RUNTIME_REGISTER_VERSION = 1;
export const RUNTIME_SNAPSHOT_EVENT = "pi-mcp-adapter:runtime-snapshot:v1";
export const RUNTIME_SNAPSHOT_VERSION = 1;
export const CONTEXT7_URL = "https://mcp.context7.com/mcp";
const OFFICIAL_ENGRAM_ARGS = ["mcp", "--tools=agent"];
const DEVTOOLS_HANDOFF_RELATIVE_PATH = ["jorgex-pi", "devtools.v1.json"];
const DEVTOOLS_PACKAGE_PREFIX = "chrome-devtools-mcp@";
const STABLE_EXACT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const DEVTOOLS_FIXED_SUFFIX_ARGS = [
  "--isolated",
  "--redact-network-headers",
  "--no-performance-crux",
  "--no-usage-statistics",
];
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const DEVTOOLS_DIGEST = /^[0-9a-f]{64}$/;
const DEVTOOLS_MAX_LAUNCHER_BYTES = 4 * 1024 * 1024;
const DEVTOOLS_MAX_TREE_BYTES = 512 * 1024 * 1024;
const DEVTOOLS_MAX_TREE_ENTRIES = 100_000;
const DEVTOOLS_MAX_TREE_METADATA_BYTES = 32 * 1024 * 1024;
const DEVTOOLS_MAX_PATH_BYTES = 16 * 1024;
const DEVTOOLS_MAX_SYMLINK_BYTES = 16 * 1024;
const DEVTOOLS_HASH_CHUNK_BYTES = 1024 * 1024;

// The bridge never invokes setup or writes settings/MCP state. It inspects the
// official external setup and reports the state; the bootstrap registers only
// Context7 and DevTools over the runtime event bus.
export async function resolveMcpEngramConfig({
  resolveEngramBinary,
  env = process.env,
  platform = process.platform,
  cwd = process.cwd(),
} = {}) {
  const config = { mcpServers: {} };
  const context7 = inspectContext7Config({ env, platform, cwd });
  const packages = inspectOfficialPackages({ env, platform, cwd });
  // Official package ownership gates managed before any Context7 activation:
  // missing/duplicate/invalid packages never resolve managed even when an
  // independent Context7 conflict would otherwise hide the gate. Context7
  // diagnosis is preserved via the context7 field. Unrelated MCP-scan
  // invalidity remains scoped to the managed result with its diagnosis.
  if (packages.state === "invalid"
    && (packages.source === "pi-global-settings" || packages.source === "pi-project-settings")) {
    return {
      state: "failed",
      config,
      context7,
      reason: `Invalid package-scope settings (${packages.source}: ${packages.code})`,
    };
  }
  if (packages.state === "invalid") {
    return {
      state: "failed",
      config,
      context7,
      reason: `Invalid official Engram setup (${packages.source}: ${packages.code}); run \`engram setup pi\` and reload Pi`,
    };
  }
  if (packages.state === "conflict") {
    return {
      state: "failed",
      config,
      context7,
      reason: `Duplicate official Engram packages (${packages.source}: ${packages.code}); remove the duplicate, run \`engram setup pi\` and reload Pi`,
    };
  }
  if (packages.state === "missing") {
    return {
      state: "missing",
      config,
      context7,
      reason: "official Engram MCP setup is missing; run `engram setup pi` and reload Pi",
    };
  }
  if (context7.state === "available") {
    config.mcpServers.context7 = {
      url: CONTEXT7_URL,
      auth: false,
      lifecycle: "lazy",
      directTools: false,
      ...(env.CONTEXT7_API_KEY?.trim() ? { headers: { CONTEXT7_API_KEY: "${CONTEXT7_API_KEY}" } } : {}),
    };
  }
  try {
    const binary = await (resolveEngramBinary ?? (() => resolveConfiguredEngramBinary({ env, platform })))();
    const official = readOfficialEngramServer({ env, platform });
    if (official.error) throw new Error(official.error);
    // The official Engram server from the adapter-selected config is
    // mandatory: an executable binary never substitutes it. Absence fails
    // closed as missing with the Context7 diagnosis and setup remedy
    // preserved; the configured binary only validates its command.
    if (!official.server) {
      return { state: "missing", config, context7, reason: "official Engram MCP setup is missing; run `engram setup pi` and reload Pi" };
    }
    if (binary !== undefined && official.server.command !== binary) {
      throw new Error("Official Engram MCP command does not match the configured Engram binary; explicit configuration takes precedence");
    }
    config.mcpServers.engram = official.server;
    const devtools = readChromeDevToolsHandoff({ env, platform });
    if (devtools) {
      config.mcpServers["chrome-devtools"] = {
        command: devtools.command,
        args: [...devtools.args],
        lifecycle: "lazy",
        directTools: false,
      };
    }
    return { state: "managed", config, binary, context7 };
  } catch (error) {
    return {
      state: "failed",
      config,
      context7,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function readOfficialEngramServer({ env, platform }) {
  const paths = platformPaths(platform);
  const agentDir = resolvePiAgentDir({ env, platform });
  const adapterPath = paths.join(agentDir, "npm", "node_modules", "pi-mcp-adapter", "package.json");
  let configName = "mcp.json";
  try {
    const adapter = JSON.parse(readFileSync(adapterPath, "utf8"));
    if (adapter?.name !== "pi-mcp-adapter" || typeof adapter.version !== "string") {
      return { found: false, error: `Installed pi-mcp-adapter has invalid package metadata at ${adapterPath}` };
    }
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(adapter.version);
    if (!match) return { found: false, error: `Installed pi-mcp-adapter version is invalid at ${adapterPath}` };
    const major = Number(match[1]);
    if (major >= 3) configName = "mcp-adapter.json";
  } catch (error) {
    return { found: false, error: `Installed pi-mcp-adapter package metadata is missing or unreadable at ${adapterPath}` };
  }
  const mcpPath = paths.join(agentDir, configName);
  if (configName === "mcp-adapter.json") {
    const legacyPath = paths.join(agentDir, "mcp.json");
    try {
      const legacy = readConfig(legacyPath);
      if (legacy?.mcpServers?.engram !== undefined || legacy?.["mcp-servers"]?.engram !== undefined) {
        return { found: false, error: `Official Engram server remains in ${legacyPath}, which pi-mcp-adapter no longer reads; migrate it to ${mcpPath} without duplicating the server` };
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        return { found: false, error: `Legacy MCP configuration is unreadable or invalid at ${legacyPath}` };
      }
    }
  }
  let mcp;
  try {
    mcp = readConfig(mcpPath);
  } catch (error) {
    if (error?.code === "ENOENT") return { found: false };
    return { found: false, error: error instanceof SyntaxError
      ? `Official Engram MCP configuration contains invalid JSON at ${mcpPath}`
      : `Official Engram MCP configuration is unreadable at ${mcpPath}` };
  }

  if (!isRecord(mcp)) return { found: false, error: `Official Engram MCP configuration must be an object at ${mcpPath}` };
  const server = mcp.mcpServers?.engram;
  if (server === undefined) return { found: false };
  if (!isRecord(server)) return { found: false, error: `Official ${configName} Engram server must be an object at ${mcpPath}` };
  if (typeof server.command !== "string" || !paths.isAbsolute(server.command)) {
    return { found: false, error: `Official ${configName} Engram command must be an absolute path at ${mcpPath}` };
  }
  if (!isExecutable(server.command, platform)) {
    return { found: false, error: `Official ${configName} Engram command is not executable at ${mcpPath}` };
  }
  if (!Array.isArray(server.args)
    || server.args.length !== OFFICIAL_ENGRAM_ARGS.length
    || server.args.some((arg, index) => arg !== OFFICIAL_ENGRAM_ARGS[index])) {
    return { found: false, error: `Official ${configName} Engram server must use the exact official arguments at ${mcpPath}` };
  }
  if (server.lifecycle !== "lazy") {
    return { found: false, error: `Official ${configName} Engram server must use lifecycle lazy at ${mcpPath}` };
  }
  if (server.directTools !== false) {
    return { found: false, error: `Official ${configName} Engram server must disable direct tools at ${mcpPath}` };
  }
  return {
    found: true,
    server: {
      ...server,
      command: server.command,
      args: [...server.args],
      lifecycle: "lazy",
      directTools: false,
      toolPrefix: "none",
      excludeTools: ["mem_capture_passive"],
    },
  };
}

function readChromeDevToolsHandoff({ env, platform }) {
  const paths = platformPaths(platform);
  const agentDir = resolvePiAgentDir({ env, platform });
  const handoffPath = paths.join(agentDir, ...DEVTOOLS_HANDOFF_RELATIVE_PATH);
  let raw;
  try {
    raw = readFileSync(handoffPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw new Error(`Chrome DevTools handoff is unreadable at ${handoffPath}`);
  }

  let handoff;
  try {
    handoff = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Chrome DevTools handoff contains invalid JSON at ${handoffPath}`);
  }

  if (!isRecord(handoff)) throw new Error(`Chrome DevTools handoff must be an object at ${handoffPath}`);
  const keys = Object.keys(handoff).sort();
  if (handoff.schemaVersion === 3) {
    return readTrustedChromeDevToolsHandoff(handoff, handoffPath, paths, platform);
  }
  if (keys.join("\0") !== ["args", "command", "enabled", "schemaVersion"].join("\0")) {
    throw new Error(`Chrome DevTools handoff has an invalid schema at ${handoffPath}`);
  }
  if ((handoff.schemaVersion !== 1 && handoff.schemaVersion !== 2) || handoff.enabled !== true) {
    throw new Error(`Chrome DevTools handoff has an unsupported schema at ${handoffPath}`);
  }
  if (typeof handoff.command !== "string" || CONTROL_CHARACTERS.test(handoff.command) || !paths.isAbsolute(handoff.command)) {
    throw new Error(`Chrome DevTools handoff command must be an absolute path at ${handoffPath}`);
  }
  if (!isExecutable(handoff.command, platform)) {
    throw new Error(`Chrome DevTools handoff command is not executable at ${handoffPath}`);
  }
  if (handoff.schemaVersion === 2 && !isCurrentNode(handoff.command, paths, platform)) {
    throw new Error(`Chrome DevTools handoff command must be this Pi runtime's Node executable at ${handoffPath}`);
  }
  if (handoff.schemaVersion === 1 ? !isDevToolsArgs(handoff.args) : !isLocalDevToolsArgs(handoff.args, paths)) {
    throw new Error(`Chrome DevTools handoff has invalid arguments at ${handoffPath}`);
  }
  return { command: handoff.command, args: handoff.args };
}

function readTrustedChromeDevToolsHandoff(handoff, handoffPath, paths, platform) {
  const expectedKeys = [
    "args",
    "command",
    "enabled",
    "entryPath",
    "launcherPath",
    "launcherSha256",
    "rootPath",
    "schemaVersion",
    "treePath",
    "treeSha256",
  ];
  if (Object.keys(handoff).sort().join("\0") !== expectedKeys.join("\0")) {
    throw new Error(`Chrome DevTools handoff has an invalid schema at ${handoffPath}`);
  }
  if (handoff.schemaVersion !== 3 || handoff.enabled !== true) {
    throw new Error(`Chrome DevTools handoff has an unsupported schema at ${handoffPath}`);
  }
  if (typeof handoff.command !== "string"
    || CONTROL_CHARACTERS.test(handoff.command)
    || !paths.isAbsolute(handoff.command)
    || !isCurrentNode(handoff.command, paths, platform)
    || !isExecutable(handoff.command, platform)) {
    throw new Error(`Chrome DevTools handoff command must be this Pi runtime's Node executable at ${handoffPath}`);
  }
  if (!Array.isArray(handoff.args)
    || handoff.args.length !== DEVTOOLS_FIXED_SUFFIX_ARGS.length + 1
    || handoff.args.some((arg) => typeof arg !== "string" || CONTROL_CHARACTERS.test(arg))) {
    throw new Error(`Chrome DevTools handoff has invalid arguments at ${handoffPath}`);
  }
  const pathsToValidate = [
    ["root", handoff.rootPath],
    ["tree", handoff.treePath],
    ["launcher", handoff.launcherPath],
    ["entry", handoff.entryPath],
  ];
  for (const [label, value] of pathsToValidate) {
    assertTrustedAbsolutePath(value, label, paths, handoffPath);
  }
  if (handoff.args[0] !== handoff.launcherPath
    || !handoff.args.slice(1).every((arg, index) => arg === DEVTOOLS_FIXED_SUFFIX_ARGS[index])) {
    throw new Error(`Chrome DevTools handoff has invalid arguments at ${handoffPath}`);
  }
  if (!DEVTOOLS_DIGEST.test(handoff.launcherSha256) || !DEVTOOLS_DIGEST.test(handoff.treeSha256)) {
    throw new Error(`Chrome DevTools handoff has invalid digests at ${handoffPath}`);
  }

  assertTrustedRealPath(handoff.rootPath, "root", paths, platform, handoffPath);
  assertTrustedRealPath(handoff.treePath, "tree", paths, platform, handoffPath);
  assertTrustedRealPath(handoff.launcherPath, "launcher", paths, platform, handoffPath);
  assertTrustedRealPath(handoff.entryPath, "entry", paths, platform, handoffPath);
  if (!isContainedPath(handoff.rootPath, handoff.treePath, paths, false)
    || !isContainedPath(handoff.rootPath, handoff.launcherPath, paths, false)
    || !isContainedPath(handoff.treePath, handoff.entryPath, paths, false)) {
    throw new Error(`Chrome DevTools handoff paths must be contained at ${handoffPath}`);
  }
  assertTrustedDirectory(handoff.rootPath, "root", handoffPath);
  assertTrustedDirectory(handoff.treePath, "tree", handoffPath);
  assertTrustedRegularFile(handoff.launcherPath, "launcher", handoffPath);
  assertTrustedRegularFile(handoff.entryPath, "entry", handoffPath);

  const launcherBytes = readBoundedRegularFile(
    handoff.launcherPath,
    DEVTOOLS_MAX_LAUNCHER_BYTES,
    "Chrome DevTools launcher",
  );
  if (sha256Hex(launcherBytes) !== handoff.launcherSha256) {
    throw new Error(`Chrome DevTools launcher digest does not match at ${handoffPath}`);
  }
  if (decodeUtf8(launcherBytes) === undefined) {
    throw new Error(`Chrome DevTools launcher is not valid UTF-8 at ${handoffPath}`);
  }
  if (browserTreeSha256(handoff.treePath, platform) !== handoff.treeSha256) {
    throw new Error(`Chrome DevTools tree digest does not match at ${handoffPath}`);
  }
  return {
    command: process.execPath,
    args: [
      "--input-type=module",
      "--eval",
      buildTrustedDevToolsGuard({
        entryPath: handoff.entryPath,
        launcherPath: handoff.launcherPath,
        launcherSha256: handoff.launcherSha256,
        rootPath: handoff.rootPath,
        treePath: handoff.treePath,
        treeSha256: handoff.treeSha256,
      }, platform),
      handoff.launcherPath,
      ...DEVTOOLS_FIXED_SUFFIX_ARGS,
    ],
  };
}

function assertTrustedAbsolutePath(value, label, paths, handoffPath) {
  if (typeof value !== "string"
    || CONTROL_CHARACTERS.test(value)
    || !paths.isAbsolute(value)
    || paths.resolve(value) !== value
    || Buffer.byteLength(value, "utf8") > DEVTOOLS_MAX_PATH_BYTES) {
    throw new Error(`Chrome DevTools ${label} path must be a canonical contained absolute path at ${handoffPath}`);
  }
}

function assertTrustedRealPath(value, label, paths, platform, handoffPath) {
  let resolved;
  try {
    resolved = realpathSync(value);
  } catch (error) {
    throw new Error(`Chrome DevTools ${label} path is unreadable or symlinked: ${filesystemDiagnostic(`${label} realpath`, value, error).message}`);
  }
  if (!samePath(resolved, value, paths, platform)) {
    throw new Error(`Chrome DevTools ${label} path is unreadable or symlinked at ${handoffPath}`);
  }
}

function assertTrustedDirectory(value, label, handoffPath) {
  let stat;
  try {
    stat = lstatSync(value);
  } catch (error) {
    throw new Error(`Chrome DevTools ${label} path must be a regular directory: ${filesystemDiagnostic(`${label} lstat`, value, error).message}`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Chrome DevTools ${label} path must be a regular directory at ${handoffPath}`);
  }
}

function assertTrustedRegularFile(value, label, handoffPath) {
  let stat;
  try {
    stat = lstatSync(value);
  } catch (error) {
    throw new Error(`Chrome DevTools ${label} path must be a regular file: ${filesystemDiagnostic(`${label} lstat`, value, error).message}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Chrome DevTools ${label} path must be a regular file at ${handoffPath}`);
  }
}

function isContainedPath(parent, child, paths, allowEqual) {
  const relativePath = paths.relative(paths.resolve(parent), paths.resolve(child));
  if (relativePath === "") return allowEqual;
  return relativePath !== ".."
    && !relativePath.startsWith(`..${paths.sep}`)
    && !paths.isAbsolute(relativePath);
}

function diagnosticPath(value) {
  const path = typeof value === "string" ? value : "<unknown>";
  return path.length <= 512 ? path : `${path.slice(0, 512)}…`;
}

function diagnosticCode(error) {
  const code = typeof error?.code === "string" ? error.code : "UNKNOWN";
  return /^[A-Z0-9_]{1,32}$/.test(code) ? code : "UNKNOWN";
}

function filesystemDiagnostic(operation, value, error) {
  const title = operation.startsWith("Chrome DevTools ") ? operation : `Chrome DevTools ${operation}`;
  return new Error(`${title} failed for ${diagnosticPath(value)} (${diagnosticCode(error)})`);
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function decodeUtf8(bytes) {
  const source = bytes.toString("utf8");
  return Buffer.from(source, "utf8").equals(bytes) ? source : undefined;
}

function openTrustedRegularFile(filePath, label) {
  const flags = constants.O_RDONLY
    | (constants.O_NONBLOCK ?? 0)
    | (constants.O_NOFOLLOW ?? 0);
  let fd;
  try {
    fd = openSync(filePath, flags);
  } catch (error) {
    throw filesystemDiagnostic(`${label} open`, filePath, error);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0) {
      throw new Error(`${label} is not a regular file`);
    }
    return { fd, size: stat.size };
  } catch (error) {
    try {
      closeSync(fd);
    } catch {
      // Preserve the primary filesystem error.
    }
    if (error?.code) throw filesystemDiagnostic(`${label} fstat`, filePath, error);
    throw error;
  }
}

export function readBoundedRegularFile(filePath, maxBytes, label) {
  const opened = openTrustedRegularFile(filePath, label);
  let primary;
  try {
    if (opened.size > maxBytes) throw new Error(`${label} exceeds its size bound`);
    const chunks = [];
    const buffer = Buffer.allocUnsafe(Math.min(DEVTOOLS_HASH_CHUNK_BYTES, maxBytes || 1));
    let total = 0;
    for (;;) {
      let read;
      try {
        read = readSync(opened.fd, buffer, 0, buffer.length, null);
      } catch (error) {
        throw filesystemDiagnostic(`${label} read`, filePath, error);
      }
      if (read === 0) break;
      total += read;
      if (total > maxBytes) throw new Error(`${label} exceeds its size bound`);
      chunks.push(Buffer.from(buffer.subarray(0, read)));
    }
    let finalStat;
    try {
      finalStat = fstatSync(opened.fd);
    } catch (error) {
      throw filesystemDiagnostic(`${label} fstat`, filePath, error);
    }
    if (!finalStat.isFile() || finalStat.size !== total) {
      throw new Error(`${label} changed while it was being verified`);
    }
    return Buffer.concat(chunks, total);
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    try {
      closeSync(opened.fd);
    } catch (error) {
      if (!primary) throw filesystemDiagnostic(`${label} close`, filePath, error);
    }
  }
}

function readContainedSymlinkTarget(linkPath, root, paths, platform) {
  let targetBytes;
  try {
    targetBytes = readlinkSync(linkPath, "buffer");
  } catch (error) {
    throw filesystemDiagnostic("symlink readlink", linkPath, error);
  }
  const target = targetBytes.toString("utf8");
  if (!Buffer.from(target, "utf8").equals(targetBytes)
    || target === ""
    || CONTROL_CHARACTERS.test(target)
    || targetBytes.length > DEVTOOLS_MAX_SYMLINK_BYTES
    || paths.isAbsolute(target)
    || (platform === "win32" && /^[a-zA-Z]:/.test(target))) {
    throw new Error(`Chrome DevTools symlink must be an internal relative UTF-8 target: ${linkPath}`);
  }
  const separator = platform === "win32" ? /[\\/]+/ : /\/+/;
  const parts = target.split(separator).filter((part) => part !== "" && part !== ".");
  if (parts.length === 0) throw new Error(`Chrome DevTools symlink target is empty: ${linkPath}`);
  let current = paths.dirname(paths.resolve(linkPath));
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    const last = index === parts.length - 1;
    current = part === ".." ? paths.dirname(current) : paths.join(current, part);
    if (!isContainedPath(root, current, paths, true)) {
      throw new Error(`Chrome DevTools symlink escapes its tree: ${linkPath}`);
    }
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      throw filesystemDiagnostic("symlink target lstat", current, error);
    }
    if (stat.isSymbolicLink()) throw new Error(`Chrome DevTools symlink chain is not allowed: ${linkPath}`);
    if (last) {
      if (!stat.isFile() && !stat.isDirectory()) {
        throw new Error(`Chrome DevTools symlink target is not a file or directory: ${linkPath}`);
      }
    } else if (!stat.isDirectory()) {
      throw new Error(`Chrome DevTools symlink target traverses a non-directory: ${linkPath}`);
    }
  }
  return target;
}

function readDirectoryEntries(directoryPath, label, remainingEntries, root, paths, metadata) {
  let directory;
  try {
    directory = opendirSync(directoryPath);
  } catch (error) {
    throw filesystemDiagnostic(`${label} open directory`, directoryPath, error);
  }
  const entries = [];
  let primary;
  try {
    for (;;) {
      const entry = directory.readSync();
      if (entry === null) break;
      if (entries.length >= remainingEntries) {
        throw new Error(`${label} exceeds its entry bound`);
      }
      const full = paths.join(directoryPath, entry.name);
      const relativePath = paths.relative(paths.resolve(root), full).split(paths.sep).join("/");
      const pathBytes = Buffer.byteLength(relativePath, "utf8");
      if (metadata.bytes + pathBytes > DEVTOOLS_MAX_TREE_METADATA_BYTES) {
        throw new Error(`${label} exceeds its metadata bound`);
      }
      metadata.bytes += pathBytes;
      entries.push({ dirent: entry, full, relativePath });
    }
  } catch (error) {
    primary = error;
    if (error instanceof Error
      && (error.message === `${label} exceeds its entry bound`
        || error.message === `${label} exceeds its metadata bound`)) {
      throw error;
    }
    throw filesystemDiagnostic(`${label} read directory`, directoryPath, error);
  } finally {
    try {
      directory.closeSync();
    } catch (error) {
      if (!primary) throw filesystemDiagnostic(`${label} close directory`, directoryPath, error);
    }
  }
  return entries;
}

export function browserTreeSha256(root, platform = process.platform) {
  const paths = platformPaths(platform);
  const resolvedRoot = paths.resolve(root);
  const entries = [];
  const pending = [resolvedRoot];
  const metadata = { bytes: 0 };
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const item of readDirectoryEntries(
      directory,
      "Chrome DevTools tree",
      DEVTOOLS_MAX_TREE_ENTRIES - entries.length,
      resolvedRoot,
      paths,
      metadata,
    )) {
      const { full, relativePath } = item;
      if (relativePath === ""
        || CONTROL_CHARACTERS.test(relativePath)
        || Buffer.byteLength(relativePath, "utf8") > DEVTOOLS_MAX_PATH_BYTES) {
        throw new Error(`Chrome DevTools tree contains an invalid path: ${full}`);
      }
      if (entries.length >= DEVTOOLS_MAX_TREE_ENTRIES) {
        throw new Error("Chrome DevTools tree exceeds its entry bound");
      }
      let stat;
      try {
        stat = lstatSync(full);
      } catch (error) {
        throw filesystemDiagnostic("tree entry lstat", full, error);
      }
      if (stat.isSymbolicLink()) {
        const target = readContainedSymlinkTarget(full, resolvedRoot, paths, platform);
        const targetBytes = Buffer.byteLength(target, "utf8");
        if (metadata.bytes + targetBytes > DEVTOOLS_MAX_TREE_METADATA_BYTES) {
          throw new Error("Chrome DevTools tree exceeds its metadata bound");
        }
        metadata.bytes += targetBytes;
        entries.push({ kind: "symlink", rel: relativePath, target });
      } else if (stat.isDirectory()) {
        entries.push({ kind: "dir", rel: relativePath });
        pending.push(full);
      } else if (stat.isFile()) {
        entries.push({ kind: "file", rel: relativePath, full });
      } else {
        throw new Error(`Chrome DevTools tree contains an unsupported entry: ${full}`);
      }
    }
  }
  entries.sort((left, right) => left.rel < right.rel ? -1 : left.rel > right.rel ? 1 : 0);
  const hash = createHash("sha256");
  hash.update("browser-v2\0", "utf8");
  const total = { bytes: 0 };
  for (const entry of entries) {
    hash.update(`${entry.kind}\0${entry.rel}\0`, "utf8");
    if (entry.kind === "symlink") {
      const payload = Buffer.from(entry.target, "utf8");
      const length = Buffer.alloc(8);
      length.writeBigUInt64BE(BigInt(payload.length));
      hash.update(length);
      hash.update(payload);
      total.bytes += payload.length;
      if (total.bytes > DEVTOOLS_MAX_TREE_BYTES) throw new Error("Chrome DevTools tree exceeds its byte bound");
    } else if (entry.kind === "dir") {
      hash.update(Buffer.alloc(8));
    } else {
      hashRegularFilePayload(hash, entry.full, total);
    }
  }
  return hash.digest("hex");
}

function hashRegularFilePayload(hash, filePath, total) {
  const opened = openTrustedRegularFile(filePath, "Chrome DevTools tree file");
  let primary;
  try {
    if (opened.size > DEVTOOLS_MAX_TREE_BYTES || total.bytes + opened.size > DEVTOOLS_MAX_TREE_BYTES) {
      throw new Error("Chrome DevTools tree exceeds its byte bound");
    }
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(opened.size));
    hash.update(length);
    const buffer = Buffer.allocUnsafe(DEVTOOLS_HASH_CHUNK_BYTES);
    let readTotal = 0;
    for (;;) {
      let read;
      try {
        read = readSync(opened.fd, buffer, 0, buffer.length, null);
      } catch (error) {
        throw filesystemDiagnostic("tree file read", filePath, error);
      }
      if (read === 0) break;
      readTotal += read;
      if (readTotal > opened.size || total.bytes + readTotal > DEVTOOLS_MAX_TREE_BYTES) {
        throw new Error("Chrome DevTools tree file changed or exceeds its byte bound");
      }
      hash.update(buffer.subarray(0, read));
    }
    let finalStat;
    try {
      finalStat = fstatSync(opened.fd);
    } catch (error) {
      throw filesystemDiagnostic("tree file fstat", filePath, error);
    }
    if (!finalStat.isFile() || finalStat.size !== readTotal || readTotal !== opened.size) {
      throw new Error(`Chrome DevTools tree file changed while it was being verified: ${filePath}`);
    }
    total.bytes += readTotal;
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    try {
      closeSync(opened.fd);
    } catch (error) {
      if (!primary) throw filesystemDiagnostic("tree file close", filePath, error);
    }
  }
}

function buildTrustedDevToolsGuard(expected, platform) {
  const guardExpected = JSON.stringify({ ...expected, platform });
  return `(${runTrustedDevToolsGuard.toString()})(${guardExpected})`;
}

// This function is serialized into the registered Node --eval command. Keep
// every dependency local: the launcher and its tree are mutable, while this
// function comes from the already-loaded Pi module and is the trust boundary.
async function runTrustedDevToolsGuard(expected) {
  const crypto = await import("node:crypto");
  const fs = await import("node:fs");
  const paths = expected.platform === "win32" ? await import("node:path").then(({ win32 }) => win32) : await import("node:path").then(({ posix }) => posix);
  const fixedFlags = [
    "--isolated",
    "--redact-network-headers",
    "--no-performance-crux",
    "--no-usage-statistics",
  ];
  const maxLauncherBytes = 4 * 1024 * 1024;
  const maxTreeBytes = 512 * 1024 * 1024;
  const maxTreeEntries = 100_000;
  const maxTreeMetadataBytes = 32 * 1024 * 1024;
  const maxPathBytes = 16 * 1024;
  const maxSymlinkBytes = 16 * 1024;
  const chunkBytes = 1024 * 1024;
  const controlCharacters = /[\u0000-\u001f\u007f]/;
  const fail = (message) => { throw new Error(`trusted DevTools guard: ${message}`); };
  const diagnosticPath = (value) => {
    const path = typeof value === "string" ? value : "<unknown>";
    return path.length <= 512 ? path : `${path.slice(0, 512)}…`;
  };
  const diagnosticCode = (error) => {
    const code = typeof error?.code === "string" ? error.code : "UNKNOWN";
    return /^[A-Z0-9_]{1,32}$/.test(code) ? code : "UNKNOWN";
  };
  const failFilesystem = (operation, value, error) => {
    fail(`${operation} failed for ${diagnosticPath(value)} (${diagnosticCode(error)})`);
  };
  const contained = (parent, child, allowEqual) => {
    const relativePath = paths.relative(paths.resolve(parent), paths.resolve(child));
    if (relativePath === "") return allowEqual;
    return relativePath !== ".."
      && !relativePath.startsWith(`..${paths.sep}`)
      && !paths.isAbsolute(relativePath);
  };
  const samePath = (left, right) => {
    const resolvedLeft = paths.resolve(left);
    const resolvedRight = paths.resolve(right);
    return expected.platform === "win32"
      ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
      : resolvedLeft === resolvedRight;
  };
  const openRegular = (filePath, label) => {
    const flags = fs.constants.O_RDONLY
      | (fs.constants.O_NONBLOCK ?? 0)
      | (fs.constants.O_NOFOLLOW ?? 0);
    let fd;
    try {
      fd = fs.openSync(filePath, flags);
    } catch (error) {
      failFilesystem(`${label} open`, filePath, error);
    }
    let stat;
    try {
      stat = fs.fstatSync(fd);
    } catch (error) {
      try { fs.closeSync(fd); } catch { /* Preserve the primary error. */ }
      failFilesystem(`${label} fstat`, filePath, error);
    }
    if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0) fail(`${label} is not a regular file`);
    return { fd, size: stat.size };
  };
  const readBounded = (filePath, maxBytes, label) => {
    const opened = openRegular(filePath, label);
    let primary;
    try {
      if (opened.size > maxBytes) fail(`${label} exceeds its size bound`);
      const buffer = Buffer.allocUnsafe(Math.min(chunkBytes, maxBytes || 1));
      const chunks = [];
      let total = 0;
      for (;;) {
        let read;
        try {
          read = fs.readSync(opened.fd, buffer, 0, buffer.length, null);
        } catch (error) {
          failFilesystem(`${label} read`, filePath, error);
        }
        if (read === 0) break;
        total += read;
        if (total > maxBytes) fail(`${label} exceeds its size bound`);
        chunks.push(Buffer.from(buffer.subarray(0, read)));
      }
      let stat;
      try {
        stat = fs.fstatSync(opened.fd);
      } catch (error) {
        failFilesystem(`${label} fstat`, filePath, error);
      }
      if (!stat.isFile() || stat.size !== total) fail(`${label} changed while it was being verified`);
      return Buffer.concat(chunks, total);
    } catch (error) {
      primary = error;
      throw error;
    } finally {
      try { fs.closeSync(opened.fd); } catch (error) { if (!primary) failFilesystem(`${label} close`, filePath, error); }
    }
  };
  const containedSymlinkTarget = (linkPath, root) => {
    let targetBytes;
    try { targetBytes = fs.readlinkSync(linkPath, "buffer"); } catch (error) { failFilesystem("symlink readlink", linkPath, error); }
    const target = targetBytes.toString("utf8");
    if (!Buffer.from(target, "utf8").equals(targetBytes)
      || target === ""
      || controlCharacters.test(target)
      || targetBytes.length > maxSymlinkBytes
      || paths.isAbsolute(target)
      || (expected.platform === "win32" && /^[a-zA-Z]:/.test(target))) {
      fail(`symlink must be an internal relative UTF-8 target: ${linkPath}`);
    }
    const separator = expected.platform === "win32" ? /[\\/]+/ : /\/+/;
    const parts = target.split(separator).filter((part) => part !== "" && part !== ".");
    if (parts.length === 0) fail(`symlink target is empty: ${linkPath}`);
    let current = paths.dirname(paths.resolve(linkPath));
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      const last = index === parts.length - 1;
      current = part === ".." ? paths.dirname(current) : paths.join(current, part);
      if (!contained(root, current, true)) fail(`symlink escapes its tree: ${linkPath}`);
      let stat;
      try { stat = fs.lstatSync(current); } catch (error) { failFilesystem("symlink target lstat", current, error); }
      if (stat.isSymbolicLink()) fail(`symlink chain is not allowed: ${linkPath}`);
      if (last) {
        if (!stat.isFile() && !stat.isDirectory()) fail(`symlink target is not a file or directory: ${linkPath}`);
      } else if (!stat.isDirectory()) {
        fail(`symlink target traverses a non-directory: ${linkPath}`);
      }
    }
    return target;
  };
  const readDirectory = (directoryPath, remainingEntries, root, metadata) => {
    let directory;
    try { directory = fs.opendirSync(directoryPath); } catch (error) { failFilesystem("tree open directory", directoryPath, error); }
    const entries = [];
    let primary;
    try {
      for (;;) {
        const entry = directory.readSync();
        if (entry === null) break;
        if (entries.length >= remainingEntries) fail("tree exceeds its entry bound");
        const full = paths.join(directoryPath, entry.name);
        const rel = paths.relative(paths.resolve(root), full).split(paths.sep).join("/");
        const pathBytes = Buffer.byteLength(rel, "utf8");
        if (metadata.bytes + pathBytes > maxTreeMetadataBytes) fail("tree exceeds its metadata bound");
        metadata.bytes += pathBytes;
        entries.push({ full, rel });
      }
    } catch (error) {
      primary = true;
      if (error?.message === "trusted DevTools guard: tree exceeds its entry bound"
        || error?.message === "trusted DevTools guard: tree exceeds its metadata bound") throw error;
      if (error?.message?.startsWith("trusted DevTools guard:")) throw error;
      failFilesystem("tree read directory", directoryPath, error);
    } finally {
      try { directory.closeSync(); } catch (error) { if (!primary) failFilesystem("tree close directory", directoryPath, error); }
    }
    return entries;
  };
  const hashFilePayload = (hash, filePath, total) => {
    const opened = openRegular(filePath, "tree file");
    let primary;
    try {
      if (opened.size > maxTreeBytes || total.bytes + opened.size > maxTreeBytes) fail("tree exceeds its byte bound");
      const length = Buffer.alloc(8);
      length.writeBigUInt64BE(BigInt(opened.size));
      hash.update(length);
      const buffer = Buffer.allocUnsafe(chunkBytes);
      let readTotal = 0;
      for (;;) {
        let read;
        try {
          read = fs.readSync(opened.fd, buffer, 0, buffer.length, null);
        } catch (error) {
          failFilesystem("tree file read", filePath, error);
        }
        if (read === 0) break;
        readTotal += read;
        if (readTotal > opened.size || total.bytes + readTotal > maxTreeBytes) fail("tree file changed or exceeds its byte bound");
        hash.update(buffer.subarray(0, read));
      }
      let stat;
      try {
        stat = fs.fstatSync(opened.fd);
      } catch (error) {
        failFilesystem("tree file fstat", filePath, error);
      }
      if (!stat.isFile() || stat.size !== readTotal || readTotal !== opened.size) fail(`tree file changed while it was being verified: ${filePath}`);
      total.bytes += readTotal;
    } catch (error) {
      primary = error;
      throw error;
    } finally {
      try { fs.closeSync(opened.fd); } catch (error) { if (!primary) failFilesystem("tree file close", filePath, error); }
    }
  };
  const treeDigest = (root) => {
    const resolvedRoot = paths.resolve(root);
    const entries = [];
    const pending = [resolvedRoot];
    const metadata = { bytes: 0 };
    while (pending.length > 0) {
      const directory = pending.pop();
      for (const item of readDirectory(directory, maxTreeEntries - entries.length, resolvedRoot, metadata)) {
        const { full, rel } = item;
        if (rel === "" || controlCharacters.test(rel) || Buffer.byteLength(rel, "utf8") > maxPathBytes) fail(`tree contains an invalid path: ${full}`);
        if (entries.length >= maxTreeEntries) fail("tree exceeds its entry bound");
        let stat;
        try { stat = fs.lstatSync(full); } catch (error) { failFilesystem("tree entry lstat", full, error); }
        if (stat.isSymbolicLink()) {
          const target = containedSymlinkTarget(full, resolvedRoot);
          const targetBytes = Buffer.byteLength(target, "utf8");
          if (metadata.bytes + targetBytes > maxTreeMetadataBytes) fail("tree exceeds its metadata bound");
          metadata.bytes += targetBytes;
          entries.push({ kind: "symlink", rel, target });
        }
        else if (stat.isDirectory()) { entries.push({ kind: "dir", rel }); pending.push(full); }
        else if (stat.isFile()) entries.push({ kind: "file", rel, full });
        else fail(`tree contains an unsupported entry: ${full}`);
      }
    }
    entries.sort((left, right) => left.rel < right.rel ? -1 : left.rel > right.rel ? 1 : 0);
    const hash = crypto.createHash("sha256");
    hash.update("browser-v2\0", "utf8");
    const total = { bytes: 0 };
    for (const entry of entries) {
      hash.update(`${entry.kind}\0${entry.rel}\0`, "utf8");
      if (entry.kind === "symlink") {
        const payload = Buffer.from(entry.target, "utf8");
        const length = Buffer.alloc(8);
        length.writeBigUInt64BE(BigInt(payload.length));
        hash.update(length);
        hash.update(payload);
        total.bytes += payload.length;
        if (total.bytes > maxTreeBytes) fail("tree exceeds its byte bound");
      } else if (entry.kind === "dir") hash.update(Buffer.alloc(8));
      else hashFilePayload(hash, entry.full, total);
    }
    return hash.digest("hex");
  };
  try {
    if (process.argv[1] !== expected.launcherPath) fail("launcher argv path changed");
    if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(fixedFlags)) fail("privacy flags changed");
    const lstatTrusted = (label, trustedPath) => {
      try {
        return fs.lstatSync(trustedPath);
      } catch (error) {
        failFilesystem(`${label} lstat`, trustedPath, error);
      }
    };
    const rootStat = lstatTrusted("root", expected.rootPath);
    const treeStat = lstatTrusted("tree", expected.treePath);
    const launcherStat = lstatTrusted("launcher", expected.launcherPath);
    const entryStat = lstatTrusted("entry", expected.entryPath);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()
      || !treeStat.isDirectory() || treeStat.isSymbolicLink()
      || !launcherStat.isFile() || launcherStat.isSymbolicLink()
      || !entryStat.isFile() || entryStat.isSymbolicLink()) fail("trusted paths changed kind");
    try {
      for (const [label, trustedPath] of [
        ["root", expected.rootPath],
        ["tree", expected.treePath],
        ["launcher", expected.launcherPath],
        ["entry", expected.entryPath],
      ]) {
        let realPath;
        try {
          realPath = fs.realpathSync(trustedPath);
        } catch (error) {
          failFilesystem(`${label} realpath`, trustedPath, error);
        }
        if (!samePath(realPath, trustedPath)) fail(`trusted ${label} path resolves through a symlink`);
      }
    } catch (error) {
      if (error?.message?.startsWith("trusted DevTools guard:")) throw error;
      fail("trusted paths are unreadable");
    }
    if (!contained(expected.rootPath, expected.treePath, false)
      || !contained(expected.rootPath, expected.launcherPath, false)
      || !contained(expected.treePath, expected.entryPath, false)) fail("trusted paths escaped");
    const launcherBytes = readBounded(expected.launcherPath, maxLauncherBytes, "launcher");
    if (crypto.createHash("sha256").update(launcherBytes).digest("hex") !== expected.launcherSha256) fail("launcher digest changed");
    const source = launcherBytes.toString("utf8");
    if (!Buffer.from(source, "utf8").equals(launcherBytes)) fail("launcher is not valid UTF-8");
    if (treeDigest(expected.treePath) !== expected.treeSha256) fail("tree digest changed");
    await eval(`(async () => {\n${source}\n})()`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`trusted DevTools guard: ${message}\n`);
    process.exitCode = 1;
  }
}

function isDevToolsArgs(args) {
  if (!Array.isArray(args) || args.length !== 6) return false;
  if (args[0] !== "dlx" || !isDevToolsPackageArg(args[1])) return false;
  return args.slice(2).every((arg, index) => arg === DEVTOOLS_FIXED_SUFFIX_ARGS[index]);
}

function isLocalDevToolsArgs(args, paths) {
  if (!Array.isArray(args) || args.length !== DEVTOOLS_FIXED_SUFFIX_ARGS.length + 1) return false;
  const entry = args[0];
  if (typeof entry !== "string" || CONTROL_CHARACTERS.test(entry) || !paths.isAbsolute(entry)
    || ![".js", ".mjs"].includes(paths.extname(entry).toLowerCase())) return false;
  try {
    if (!lstatSync(entry).isFile()) return false;
  } catch {
    return false;
  }
  return args.slice(1).every((arg, index) => arg === DEVTOOLS_FIXED_SUFFIX_ARGS[index]);
}

function isCurrentNode(command, paths, platform) {
  try {
    return samePath(realpathSync(command), realpathSync(process.execPath), paths, platform);
  } catch {
    return false;
  }
}

function isDevToolsPackageArg(arg) {
  if (typeof arg !== "string" || !arg.startsWith(DEVTOOLS_PACKAGE_PREFIX)) return false;
  return isStableExactVersion(arg.slice(DEVTOOLS_PACKAGE_PREFIX.length));
}

function isStableExactVersion(version) {
  return typeof version === "string" && STABLE_EXACT_SEMVER.test(version);
}

export function resolveConfiguredEngramBinary({
  env = process.env,
  platform = process.platform,
} = {}) {
  const configured = env.ENGRAM_BIN;
  if (typeof configured === "string" && configured) {
    if (!platformPaths(platform).isAbsolute(configured)) throw new Error("ENGRAM_BIN must be absolute");
    if (platform === "win32" && !/\.exe$/i.test(configured)) {
      throw new Error("ENGRAM_BIN must point to a native .exe executable on Windows");
    }
    // An explicitly set invalid binary is terminal: never fall through to the
    // receipt or mask the configuration error; the bridge fails closed.
    if (!isExecutable(configured, platform)) {
      throw new Error(`ENGRAM_BIN is set but not executable: ${configured}`);
    }
    return configured;
  }
  return resolveStackReceiptEngramBinary({ env, platform });
}

function resolveStackReceiptEngramBinary({ env, platform }) {
  const paths = platformPaths(platform);
  const home = receiptHome(env, platform);
  if (!home) return undefined;

  let receipt;
  try {
    receipt = JSON.parse(readFileSync(paths.join(home, ".jorgex-stack", "pi-receipt.json"), "utf8"));
  } catch {
    return undefined;
  }

  const packageIdentity = readPackageIdentity();
  const codingAgentDir = resolvePiAgentDir({ env, platform });
  if (!packageIdentity || !paths.isAbsolute(codingAgentDir) || !isExactInstalledReceipt(receipt, packageIdentity, codingAgentDir, platform)) {
    return undefined;
  }

  const binary = receipt.engram.binary;
  if (typeof binary !== "string" || !paths.isAbsolute(binary)) return undefined;
  if (platform === "win32" && !/\.exe$/i.test(binary)) return undefined;
  return isExecutable(binary, platform) ? binary : undefined;
}

function receiptHome(env, platform) {
  const paths = platformPaths(platform);
  const configured = platform === "win32" ? env.USERPROFILE ?? env.HOME : env.HOME ?? env.USERPROFILE;
  return typeof configured === "string" && paths.isAbsolute(configured) ? paths.resolve(configured) : undefined;
}

function readPackageIdentity() {
  try {
    const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
    return typeof manifest?.name === "string" && typeof manifest?.version === "string"
      ? { name: manifest.name, version: manifest.version }
      : undefined;
  } catch {
    return undefined;
  }
}

function isExactInstalledReceipt(receipt, packageIdentity, codingAgentDir, platform) {
  const paths = platformPaths(platform);
  if (!isRecord(receipt) || receipt.schemaVersion !== 1 || receipt.state !== "installed") return false;
  if (!isRecord(receipt.candidate) || !isRecord(receipt.candidate.package) || !isRecord(receipt.scope) || !isRecord(receipt.engram)) {
    return false;
  }
  const packageSource = `npm:${packageIdentity.name}@${packageIdentity.version}`;
  if (receipt.candidate.package.name !== packageIdentity.name
    || receipt.candidate.package.version !== packageIdentity.version
    || receipt.candidate.package.source !== packageSource
    || receipt.scope.kind !== "real"
    || typeof receipt.scope.codingAgentDir !== "string"
    || !paths.isAbsolute(receipt.scope.codingAgentDir)) {
    return false;
  }
  return samePath(receipt.scope.codingAgentDir, codingAgentDir, paths, platform);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function platformPaths(platform) {
  return platform === "win32" ? win32 : posix;
}

function samePath(left, right, paths, platform) {
  const resolvedLeft = paths.resolve(left);
  const resolvedRight = paths.resolve(right);
  return platform === "win32"
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

function isExecutable(path, platform = process.platform) {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return false;
    if (platform !== "win32") accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
