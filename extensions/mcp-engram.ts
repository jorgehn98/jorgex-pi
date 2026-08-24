import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute } from "node:path";
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
  if (typeof configured !== "string" || !configured) return undefined;
  if (!isAbsolute(configured)) throw new Error("ENGRAM_BIN must be absolute");
  if (platform === "win32" && !/\.exe$/i.test(configured)) {
    throw new Error("ENGRAM_BIN must point to a native .exe executable on Windows");
  }
  return isExecutable(configured, platform) ? configured : undefined;
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
