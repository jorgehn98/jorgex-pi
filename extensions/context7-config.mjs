import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import stripJsonComments from "strip-json-comments";

const maxConfigBytes = 1024 * 1024;
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export function inspectContext7Config({ env = process.env, cwd = process.cwd(), platform = process.platform, argv = process.argv } = {}) {
  const paths = platform === "win32" ? win32 : posix;
  const home = (platform === "win32" ? env.USERPROFILE ?? env.HOME : env.HOME ?? env.USERPROFILE) ?? homedir();
  const invalid = (source, code) => ({ state: "invalid", source, code });
  if (!paths.isAbsolute(home) || !paths.isAbsolute(cwd)) return invalid("runtime", "invalid-path");
  let configDir = ".pi";
  if (env.PI_PACKAGE_DIR) {
    try {
      const manifest = readConfig(paths.resolve(cwd, env.PI_PACKAGE_DIR, "package.json"));
      if (manifest?.piConfig?.name && manifest.piConfig.name !== "pi") return invalid("runtime", "unsupported-pi-identity");
      const configured = manifest?.piConfig?.configDir;
      if (configured !== undefined) {
        if (typeof configured !== "string" || !configured.trim() || /[\\/]/.test(configured)) return invalid("runtime", "invalid-config-dir");
        configDir = configured.trim();
      }
    } catch { return invalid("runtime", "invalid-pi-manifest"); }
  }
  const agentDir = env.PI_CODING_AGENT_DIR ?? paths.join(home, configDir, "agent");
  if (!paths.isAbsolute(agentDir)) return invalid("pi-global", "invalid-path");
  for (const [source, file] of [
    ["pi-global-settings", paths.join(agentDir, "settings.json")],
    ["pi-project-settings", paths.join(cwd, configDir, "settings.json")],
  ]) {
    let settings;
    try { settings = readConfig(file); }
    catch (error) {
      if (error?.code === "ENOENT") continue;
      return invalid(source, "unreadable-settings");
    }
    if (!isRecord(settings) || (settings.packages !== undefined && !Array.isArray(settings.packages))) return invalid(source, "invalid-settings");
    if (settings.packages?.some((entry) => {
      const registered = typeof entry === "string" ? entry : entry?.source;
      return typeof registered === "string" && /^npm:pi-mcp-adapter(?:@[^/\s]+)?$/.test(registered);
    })) return { state: "conflict", source, code: "external-mcp-adapter" };
  }
  const sources = [
    ["shared-global", paths.join(home, ".config", "mcp", "mcp.json")],
    ["agents-global", paths.join(home, ".agents", "mcp.json")],
    ["agents-nested-global", paths.join(home, ".agents", "mcp", "mcp.json")],
    ["pi-global", paths.join(agentDir, "mcp.json")],
    ["shared-project", paths.join(cwd, ".mcp.json")],
    ["pi-project", paths.join(cwd, configDir, "mcp.json")],
  ];
  const flagIndex = argv.indexOf("--mcp-config");
  const override = flagIndex >= 0 ? argv[flagIndex + 1] : argv.find((arg) => arg.startsWith("--mcp-config="))?.slice(13);
  if (flagIndex >= 0 && (!override || override.startsWith("--"))) return invalid("explicit-config", "invalid-path");
  if (override) sources.push(["explicit-config", paths.resolve(cwd, override)]);

  for (const [source, file] of sources) {
    let config;
    try { config = readConfig(file); }
    catch (error) {
      if (error?.code === "ENOENT") continue;
      return invalid(source, error instanceof SyntaxError ? "invalid-json" : "unreadable-config");
    }
    if (!isRecord(config)) return invalid(source, "invalid-shape");
    for (const key of ["mcpServers", "mcp-servers"]) {
      if (config[key] !== undefined && !isRecord(config[key])) return invalid(source, "invalid-shape");
      if (isRecord(config[key]) && Object.hasOwn(config[key], "context7")) return { state: "conflict", source, code: "existing-context7" };
    }
    if (config.imports !== undefined && (!Array.isArray(config.imports) || config.imports.length > 0)) return invalid(source, "imports-unverified");
    if (config.settings !== undefined && !isRecord(config.settings)) return invalid(source, "invalid-shape");
    if ((config.settings?.hostConfigDiscovery !== undefined && config.settings.hostConfigDiscovery !== "off")
      || (config.settings?.agentPluginPaths !== undefined && (!Array.isArray(config.settings.agentPluginPaths) || config.settings.agentPluginPaths.length > 0))
      || config.claudePlugins !== undefined) return invalid(source, "discovery-unverified");
  }
  return { state: "available" };
}

function readConfig(file) {
  const stat = statSync(file);
  if (!stat.isFile() || stat.size > maxConfigBytes) throw new Error("Invalid MCP configuration file");
  const bytes = readFileSync(file);
  if (bytes.length > maxConfigBytes) throw new Error("MCP configuration exceeds the size limit");
  const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return JSON.parse(stripJsonComments(raw, { trailingCommas: true }));
}
