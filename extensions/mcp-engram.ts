import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { isAbsolute, posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { buildEngramChildSpec } from "./engram-mcp-wrapper.mjs";

const wrapperPath = fileURLToPath(new URL("./engram-mcp-wrapper.mjs", import.meta.url));
const recoveryInstruction = [
  "FIRST ACTION REQUIRED after compaction: call mem_session_summary with the compacted session outcome.",
  "Then call mem_context for the active project before continuing work.",
].join(" ");

export { buildEngramChildSpec };

export async function resolveMcpEngramConfig({
  resolveEngramBinary = () => resolveConfiguredEngramBinary(),
  nodePath = process.execPath,
  wrapperPath: managedWrapperPath = wrapperPath,
} = {}) {
  const config = { mcpServers: {} };
  try {
    const binary = await resolveEngramBinary();
    if (!binary) return { state: "missing", config };
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
    return { state: "managed", config, binary };
  } catch (error) {
    return {
      state: "failed",
      config,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function installMcpEngram(pi, {
  resolveEngramBinary,
} = {}) {
  const resolution = await resolveMcpEngramConfig({
    resolveEngramBinary,
  });
  if (resolution.state !== "managed") return resolution;
  const adapterEntry = import.meta.resolve("pi-mcp-adapter");
  const { createMcpAdapter } = await import(adapterEntry);
  createMcpAdapter({ config: resolution.config })(pi);
  registerEngramCompactionRecovery(pi, { isAvailable: () => resolution.state === "managed" });
  return resolution;
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
  const codingAgentDir = env.PI_CODING_AGENT_DIR ?? paths.join(home, ".pi", "agent");
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
