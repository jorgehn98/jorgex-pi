import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";

const probeDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(probeDir, "..", "..");

let fetchCount = 0;
globalThis.fetch = async () => {
  fetchCount += 1;
  throw new Error("network blocked by engram child probe");
};

function isolation() {
  return {
    home: process.env.HOME,
    userprofile: process.env.USERPROFILE,
    agentDir: process.env.PI_CODING_AGENT_DIR,
    xdgConfig: process.env.XDG_CONFIG_HOME,
    xdgCache: process.env.XDG_CACHE_HOME,
    xdgData: process.env.XDG_DATA_HOME,
    temp: process.env.TEMP,
    tmp: process.env.TMP,
    tmpdir: process.env.TMPDIR,
    subagentsTemp: process.env.PI_SUBAGENTS_TEMP_ROOT,
    path: process.env.PATH,
    engramBin: process.env.ENGRAM_BIN,
    mcpDirectTools: process.env.MCP_DIRECT_TOOLS,
    hasMcpDirectTools: Object.hasOwn(process.env, "MCP_DIRECT_TOOLS"),
    hasSubagentMcpDirectTools: Object.hasOwn(process.env, "PI_SUBAGENT_MCP_DIRECT_TOOLS"),
    hasRequiredTools: Object.hasOwn(process.env, "PI_SUBAGENT_REQUIRED_TOOLS"),
    cwd: process.cwd(),
    piPackageDirConfigured: Object.hasOwn(process.env, "PI_PACKAGE_DIR"),
  };
}

function readIfExists(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function checkWorktree() {
  const shimPath = join(root, "extensions", "engram-child.ts");
  const agentSource = readIfExists(join(root, "agents", "engram.md")) ?? "";
  const generatorSource = readIfExists(join(root, "scripts", "generate-runtime-agents.mjs")) ?? "";
  let contractEngram;
  try {
    const contract = JSON.parse(readIfExists(join(root, "contract", "runtime-agents.v1.json")) ?? "{}");
    contractEngram = contract.agents?.find(({ name }) => name === "engram");
  } catch {
    contractEngram = undefined;
  }
  const extensionFiles = (() => {
    try {
      return readdirSync(join(root, "extensions"))
        .filter((name) => name.endsWith(".ts") || name.endsWith(".mjs"))
        .map((name) => ({ name, source: readIfExists(join(root, "extensions", name)) ?? "" }));
    } catch {
      return [];
    }
  })();
  return {
    shimExists: existsSync(shimPath),
    agentReferencesShim: agentSource.includes("engram-child"),
    agentHasToolsLine: agentSource.split("\n").some((line) => line.startsWith("tools:")),
    agentToolsLine: agentSource.split("\n").find((line) => line.startsWith("tools:")),
    contractHasTools: Object.hasOwn(contractEngram ?? {}, "tools"),
    contractHasSubagentOnlyExtensions: Object.hasOwn(contractEngram ?? {}, "subagentOnlyExtensions"),
    contractSubagentOnlyExtensions: contractEngram?.subagentOnlyExtensions ?? [],
    contractTools: contractEngram?.tools ?? [],
    contractMaxSubagentDepth: contractEngram?.maxSubagentDepth,
    generatorReferencesShim: generatorSource.includes("engram-child"),
    extensionsWithSelector: extensionFiles.filter(({ source }) => source.includes("ENGRAM_CHILD_ALLOWED_TOOLS")).map(({ name }) => name),
    extensionsWithDirectToolsWiring: extensionFiles
      .filter(({ source }) => /MCP_DIRECT_TOOLS\s*=\s*["'](__none__|engram\/)/.test(source))
      .map(({ name }) => name),
  };
}

function checkInstalledCopy() {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? "";
  const installedPackage = join(agentDir, "npm", "node_modules", "jorgex-pi");
  const shimPath = join(installedPackage, "extensions", "engram-child.ts");
  const agentPath = join(installedPackage, "agents", "engram.md");
  return {
    installedPackage,
    shimExists: agentDir ? existsSync(shimPath) : "no-agent-dir",
    agentExists: agentDir ? existsSync(agentPath) : "no-agent-dir",
    agentReferencesShim: agentDir && existsSync(agentPath)
      ? (readIfExists(agentPath) ?? "").includes("engram-child")
      : false,
  };
}

try {
  writeFileSync(1, `${JSON.stringify({
    isolation: isolation(),
    worktree: checkWorktree(),
    installed: checkInstalledCopy(),
    fetchCount,
  })}\n`);
} catch (error) {
  writeFileSync(1, `${JSON.stringify({ fatal: error instanceof Error ? { message: error.message, stack: error.stack } : String(error) })}\n`);
  process.exitCode = 1;
}
