import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import stripJsonComments from "strip-json-comments";

const maxConfigBytes = 1024 * 1024;
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// Official provider-owned packages: exactly one global gentle-engram@<semver>
// and one global pi-mcp-adapter own the Engram channel. Concrete versions are
// provider-managed and never asserted here, only the semver shape.
const gentleSourcePattern = /^npm:gentle-engram@([^/\s]+)$/;
const adapterSourcePattern = /^npm:pi-mcp-adapter(?:@([^/\s]+))?$/;
const semverPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function entrySource(entry) {
  return typeof entry === "string" ? entry : entry?.source;
}

function isGentleEntry(source) {
  if (typeof source !== "string") return false;
  const match = gentleSourcePattern.exec(source);
  return match !== null && semverPattern.test(match[1]);
}

function isAdapterEntry(source) {
  if (typeof source !== "string") return false;
  const match = adapterSourcePattern.exec(source);
  return match !== null && (match[1] === undefined || semverPattern.test(match[1]));
}

function isOfficialPackageName(source) {
  return typeof source === "string"
    && (source === "npm:gentle-engram"
      || source.startsWith("npm:gentle-engram@")
      || source === "npm:pi-mcp-adapter"
      || source.startsWith("npm:pi-mcp-adapter@"));
}

function isGentleOfficialName(source) {
  return typeof source === "string"
    && (source === "npm:gentle-engram" || source.startsWith("npm:gentle-engram@"));
}

function isAdapterOfficialName(source) {
  return typeof source === "string"
    && (source === "npm:pi-mcp-adapter" || source.startsWith("npm:pi-mcp-adapter@"));
}

function isUnreadableByIntent(file) {
  try {
    return (statSync(file).mode & 0o444) === 0;
  } catch {
    return false;
  }
}

export function resolvePiAgentDir({ env = process.env, cwd = process.cwd(), platform = process.platform, configDir = ".pi" } = {}) {
  const paths = platform === "win32" ? win32 : posix;
  const home = (platform === "win32" ? env.USERPROFILE ?? env.HOME : env.HOME ?? env.USERPROFILE) ?? homedir();
  let configured = env.PI_CODING_AGENT_DIR || paths.join(home, configDir, "agent");
  if (typeof configured !== "string" || !paths.isAbsolute(home)) throw new Error("Invalid Pi agent directory");
  if (configured === "~") configured = home;
  else if (configured.startsWith("~/") || (platform === "win32" && configured.startsWith("~\\"))) configured = paths.join(home, configured.slice(2));
  else if (configured.startsWith("file://")) configured = fileURLToPath(configured, { windows: platform === "win32" });
  else if (platform === "win32" && !configured.includes("\\")) {
    const drive = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(configured);
    if (drive) configured = `${drive[1].toUpperCase()}:\\${(drive[2] ?? "").replaceAll("/", "\\")}`;
  }
  return paths.resolve(cwd, configured);
}

// Shared official package-pair gate: exactly one global gentle-engram@semver
// and one global pi-mcp-adapter own the channel. Exposed separately so the
// bridge can block managed on package ownership even when an independent
// Context7 MCP conflict would otherwise hide the missing gate.
export function inspectOfficialPackages({ env = process.env, cwd = process.cwd(), platform = process.platform } = {}) {
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
  let agentDir;
  try { agentDir = resolvePiAgentDir({ env, cwd, platform, configDir }); }
  catch { return invalid("pi-global", "invalid-path"); }
  // Total official package gate: exactly one valid global gentle-engram@semver
  // and one valid global pi-mcp-adapter entry own the channel. Duplicate
  // official names, project entries, or any missing/empty/foreign-only or
  // malformed package declaration fail closed as missing.
  let globalGentleValid = 0;
  let globalAdapterValid = 0;
  let globalGentleOfficial = 0;
  let globalAdapterOfficial = 0;
  let projectDuplicateSource;
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
    if (isUnreadableByIntent(file)) return invalid(source, "unreadable-settings");
    if (!isRecord(settings) || (settings.packages !== undefined && !Array.isArray(settings.packages))) return invalid(source, "invalid-settings");
    for (const entry of settings.packages ?? []) {
      const packageSource = entrySource(entry);
      if (source === "pi-project-settings") {
        if (!projectDuplicateSource && isOfficialPackageName(packageSource)) projectDuplicateSource = packageSource;
        continue;
      }
      if (isGentleOfficialName(packageSource)) globalGentleOfficial += 1;
      if (isAdapterOfficialName(packageSource)) globalAdapterOfficial += 1;
      if (isGentleEntry(packageSource)) globalGentleValid += 1;
      if (isAdapterEntry(packageSource)) globalAdapterValid += 1;
    }
  }
  if (projectDuplicateSource) {
    const gentle = projectDuplicateSource.startsWith("npm:gentle-engram");
    return { state: "conflict", source: "pi-project-settings", code: gentle ? "duplicate-gentle-engram" : "duplicate-pi-mcp-adapter", agentDir, configDir };
  }
  if (globalGentleOfficial > 1) return { state: "conflict", source: "pi-global-settings", code: "duplicate-gentle-engram", agentDir, configDir };
  if (globalAdapterOfficial > 1) return { state: "conflict", source: "pi-global-settings", code: "duplicate-pi-mcp-adapter", agentDir, configDir };
  if (globalGentleValid !== 1 || globalAdapterValid !== 1) {
    return { state: "missing", source: "pi-global-settings", code: "missing-official-packages", agentDir, configDir };
  }
  return { state: "ready", agentDir, configDir };
}

export function inspectContext7Config({ env = process.env, cwd = process.cwd(), platform = process.platform, argv = process.argv } = {}) {
  const paths = platform === "win32" ? win32 : posix;
  const home = (platform === "win32" ? env.USERPROFILE ?? env.HOME : env.HOME ?? env.USERPROFILE) ?? homedir();
  const invalid = (source, code) => ({ state: "invalid", source, code });
  if (!paths.isAbsolute(home) || !paths.isAbsolute(cwd)) return invalid("runtime", "invalid-path");
  const packages = inspectOfficialPackages({ env, cwd, platform });
  if (packages.state === "invalid") return { state: "invalid", source: packages.source, code: packages.code };
  if (packages.state === "conflict") return { state: packages.state, source: packages.source, code: packages.code };
  const agentDir = packages.agentDir;
  const configDir = packages.configDir ?? ".pi";
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
  // Total gate runs after duplicate checks and MCP-scan diagnosis: absent,
  // undeclared, empty, foreign-only, or malformed-sole all fail closed as
  // missing. MCP-scan invalid/conflict already returned above and is preserved.
  if (packages.state === "missing") {
    return { state: "missing", source: packages.source, code: packages.code };
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
