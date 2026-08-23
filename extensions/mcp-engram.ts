import { accessSync, constants, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildEngramChildSpec } from "./engram-mcp-wrapper.mjs";

const wrapperPath = fileURLToPath(new URL("./engram-mcp-wrapper.mjs", import.meta.url));
const recoveryInstruction = [
  "FIRST ACTION REQUIRED after compaction: call mem_session_summary with the compacted session outcome.",
  "Then call mem_context for the active project before continuing work.",
].join(" ");

export { buildEngramChildSpec };

export async function resolveMcpEngramConfig({
  loadMcpConfig,
  resolveEngramBinary = () => findEngramBinary(process.env),
  nodePath = process.execPath,
  wrapperPath: managedWrapperPath = wrapperPath,
} = {}) {
  const ambient = structuredClone(await loadMcpConfig());
  ambient.mcpServers ??= {};
  if (Object.hasOwn(ambient.mcpServers, "engram")) return { state: "collision", config: ambient };
  try {
    const binary = await resolveEngramBinary();
    if (!binary) return { state: "missing", config: ambient };
    if (!isAbsolute(nodePath) || !isAbsolute(managedWrapperPath) || !isAbsolute(binary)) {
      throw new Error("Managed Engram command paths must be absolute");
    }
    const config = structuredClone(ambient);
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
      config: ambient,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function installMcpEngram(pi, {
  resolveEngramBinary,
  cwd = process.cwd(),
} = {}) {
  const adapterEntry = import.meta.resolve("pi-mcp-adapter");
  const [{ createMcpAdapter }, { loadMcpConfig }] = await Promise.all([
    import(adapterEntry),
    import(new URL("./config.ts", adapterEntry).href),
  ]);
  const resolution = await resolveMcpEngramConfig({
    loadMcpConfig: () => loadMcpConfig(undefined, cwd),
    resolveEngramBinary,
  });
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
}

function readSessionId(ctx) {
  const value = ctx?.sessionId ?? ctx?.sessionManager?.getSessionId?.();
  return typeof value === "string" && value ? value : undefined;
}

function findEngramBinary(env) {
  const configured = env.ENGRAM_BIN;
  if (typeof configured === "string" && configured) {
    if (!isAbsolute(configured)) throw new Error("ENGRAM_BIN must be absolute");
    return isExecutable(configured) ? configured : undefined;
  }
  const suffixes = process.platform === "win32"
    ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  for (const directory of (env.PATH ?? "").split(delimiter).filter(isAbsolute)) {
    for (const suffix of suffixes) {
      const candidate = join(directory, `engram${suffix}`);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}

function isExecutable(path) {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return false;
    if (process.platform !== "win32") accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
