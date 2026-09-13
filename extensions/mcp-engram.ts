import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { isAbsolute, posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { buildEngramChildSpec } from "./engram-mcp-wrapper.mjs";
import { inspectContext7Config, resolvePiAgentDir } from "./context7-config.mjs";

const wrapperPath = fileURLToPath(new URL("./engram-mcp-wrapper.mjs", import.meta.url));
const DEVTOOLS_HANDOFF_RELATIVE_PATH = ["jorgex-pi", "devtools.v1.json"];
const DEVTOOLS_HANDOFF_ARGS = [
  "dlx",
  "chrome-devtools-mcp@1.6.0",
  "--isolated",
  "--redact-network-headers",
  "--no-performance-crux",
  "--no-usage-statistics",
];
const recoveryInstruction = [
  "FIRST ACTION REQUIRED after compaction: call mem_session_summary with the compacted session outcome.",
  "Then call mem_context for the active project before continuing work.",
].join(" ");

export { buildEngramChildSpec };

export async function resolveMcpEngramConfig({
  resolveEngramBinary,
  nodePath = process.execPath,
  wrapperPath: managedWrapperPath = wrapperPath,
  env = process.env,
  platform = process.platform,
  cwd = process.cwd(),
} = {}) {
  const config = { mcpServers: {} };
  const context7 = inspectContext7Config({ env, platform, cwd });
  if (context7.state === "available") {
    config.mcpServers.context7 = {
      url: "https://mcp.context7.com/mcp",
      auth: false,
      lifecycle: "lazy",
      directTools: false,
      ...(env.CONTEXT7_API_KEY?.trim() ? { headers: { CONTEXT7_API_KEY: "${CONTEXT7_API_KEY}" } } : {}),
    };
  }
  try {
    const binary = await (resolveEngramBinary ?? (() => resolveConfiguredEngramBinary({ env, platform })))();
    if (!binary) return { state: "missing", config, context7 };
    if (!isAbsolute(nodePath) || !isAbsolute(managedWrapperPath) || !isAbsolute(binary)) {
      throw new Error("Managed Engram command paths must be absolute");
    }
    config.mcpServers.engram = {
      command: nodePath,
      args: [managedWrapperPath, binary],
      lifecycle: "lazy",
      directTools: true,
      toolPrefix: "none",
      excludeTools: ["mem_capture_passive"],
    };
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

export async function installMcpEngram(pi, {
  resolveEngramBinary,
  env = process.env,
  platform = process.platform,
  cwd = process.cwd(),
} = {}) {
  const resolution = await resolveMcpEngramConfig({
    resolveEngramBinary,
    env,
    platform,
    cwd,
  });
  if (resolution.state !== "managed") return resolution;
  const adapterEntry = import.meta.resolve("pi-mcp-adapter");
  const { createMcpAdapter } = await import(adapterEntry);
  createMcpAdapter({ config: resolution.config })(pi);
  if (resolution.context7.state === "available") resolution.context7 = { state: "registered" };
  registerEngramCompactionRecovery(pi, { isAvailable: () => resolution.state === "managed" });
  return resolution;
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
  if (handoff.schemaVersion !== 1 || handoff.enabled !== true) {
    throw new Error(`Chrome DevTools handoff has an unsupported schema at ${handoffPath}`);
  }
  if (typeof handoff.command !== "string" || !paths.isAbsolute(handoff.command)) {
    throw new Error(`Chrome DevTools handoff command must be an absolute path at ${handoffPath}`);
  }
  if (!isExecutable(handoff.command, platform)) {
    throw new Error(`Chrome DevTools handoff command is not executable at ${handoffPath}`);
  }
  if (!Array.isArray(handoff.args)
    || handoff.args.length !== DEVTOOLS_HANDOFF_ARGS.length
    || handoff.args.some((arg, index) => arg !== DEVTOOLS_HANDOFF_ARGS[index])) {
    throw new Error(`Chrome DevTools handoff has invalid arguments at ${handoffPath}`);
  }
  return { command: handoff.command, args: handoff.args };
}

export function registerEngramCompactionRecovery(pi, { isAvailable }) {
  const pending = new Set();
  pi.on("session_compact", (_event, ctx) => {
    const sessionId = readSessionId(ctx);
    if (sessionId && isAvailable()) pending.add(sessionId);
  });
  pi.on("before_agent_start", (event, ctx) => {
    const sessionId = readSessionId(ctx);
    const base = typeof event?.systemPrompt === "string" ? event.systemPrompt : "";
    if (!sessionId || !pending.delete(sessionId)) return { systemPrompt: base };
    return { systemPrompt: base ? `${base}\n\n${recoveryInstruction}` : recoveryInstruction };
  });
  pi.on("session_shutdown", (_event, ctx) => {
    const sessionId = readSessionId(ctx);
    if (sessionId) pending.delete(sessionId);
  });
}

function readSessionId(ctx) {
  const value = ctx?.sessionId ?? ctx?.sessionManager?.getSessionId?.();
  return typeof value === "string" && value ? value : undefined;
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
    return isExecutable(configured, platform) ? configured : undefined;
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
