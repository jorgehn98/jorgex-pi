import { accessSync, constants, lstatSync, readFileSync, statSync } from "node:fs";
import { posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectContext7Config, inspectOfficialPackages, resolvePiAgentDir } from "./context7-config.mjs";

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
    // The official mcp.json server is mandatory: an executable binary never
    // substitutes it. Absence fails closed as missing with the Context7
    // diagnosis preserved and the official setup remedy; the configured
    // binary only validates the official command.
    if (!official.server) {
      return { state: "missing", config, context7, reason: "official Engram MCP setup is missing; run `engram setup pi` and reload Pi" };
    }
    if (binary !== undefined && official.server.command !== binary) {
      throw new Error("Official mcp.json Engram command does not match the configured Engram binary; explicit configuration takes precedence");
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
  const mcpPath = paths.join(agentDir, "mcp.json");
  let raw;
  try {
    raw = readFileSync(mcpPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { found: false };
    return { found: false, error: `Official Engram MCP configuration is unreadable at ${mcpPath}` };
  }

  let mcp;
  try {
    mcp = JSON.parse(raw);
  } catch {
    return { found: false, error: `Official Engram MCP configuration contains invalid JSON at ${mcpPath}` };
  }

  if (!isRecord(mcp)) return { found: false, error: `Official Engram MCP configuration must be an object at ${mcpPath}` };
  const server = mcp.mcpServers?.engram;
  if (server === undefined) return { found: false };
  if (!isRecord(server)) return { found: false, error: `Official mcp.json Engram server must be an object at ${mcpPath}` };
  if (typeof server.command !== "string" || !paths.isAbsolute(server.command)) {
    return { found: false, error: `Official mcp.json Engram command must be an absolute path at ${mcpPath}` };
  }
  if (!isExecutable(server.command, platform)) {
    return { found: false, error: `Official mcp.json Engram command is not executable at ${mcpPath}` };
  }
  if (!Array.isArray(server.args)
    || server.args.length !== OFFICIAL_ENGRAM_ARGS.length
    || server.args.some((arg, index) => arg !== OFFICIAL_ENGRAM_ARGS[index])) {
    return { found: false, error: `Official mcp.json Engram server must use the exact official arguments at ${mcpPath}` };
  }
  if (server.lifecycle !== "lazy") {
    return { found: false, error: `Official mcp.json Engram server must use lifecycle lazy at ${mcpPath}` };
  }
  if (server.directTools !== false) {
    return { found: false, error: `Official mcp.json Engram server must disable direct tools at ${mcpPath}` };
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
  if (handoff.schemaVersion === 1 ? !isDevToolsArgs(handoff.args) : !isLocalDevToolsArgs(handoff.args, paths)) {
    throw new Error(`Chrome DevTools handoff has invalid arguments at ${handoffPath}`);
  }
  return { command: handoff.command, args: handoff.args };
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
