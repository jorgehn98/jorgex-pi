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

function isPiOrOfficialName(source) {
  return isOfficialPackageName(source)
    || (typeof source === "string"
      && (source === "npm:jorgex-pi" || source.startsWith("npm:jorgex-pi@")));
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
  let agentDir;
  try { agentDir = resolvePiAgentDir({ env, cwd, platform, configDir }); }
  catch { return invalid("pi-global", "invalid-path"); }
  const packageEntries = [];
  const packageFiles = [];
  let settingsFound = false;
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
    settingsFound = true;
    if (isUnreadableByIntent(file)) return invalid(source, "unreadable-settings");
    if (!isRecord(settings) || (settings.packages !== undefined && !Array.isArray(settings.packages))) return invalid(source, "invalid-settings");
    packageFiles.push({ scope: source, declared: settings.packages !== undefined });
    for (const entry of settings.packages ?? []) {
      packageEntries.push({ scope: source, source: entrySource(entry) });
    }
  }
  // The package gate only evaluates Pi-installation evidence: an explicitly
  // emptied list, a jorgex-pi entry, or an official package name. Foreign-only
  // declarations carry no Pi evidence and never block Context7 on packages.
  // Evidence without the single global pair fails closed.
  const hasPiEvidence = (entries) => entries.length === 0
    || entries.some(({ source }) => isPiOrOfficialName(source));
  const packagesDeclared = packageFiles.some(({ declared }) => declared);
  const evidenceFound = packageFiles.some(({ scope, declared }) => declared
    && hasPiEvidence(packageEntries.filter((entry) => entry.scope === scope)));
  if (settingsFound && packagesDeclared && evidenceFound) {
    // Project duplicates always block: the official pair is global-only.
    const projectDuplicate = packageEntries.find(({ scope, source }) => scope === "pi-project-settings" && isOfficialPackageName(source));
    if (projectDuplicate) {
      const gentle = projectDuplicate.source.startsWith("npm:gentle-engram");
      return { state: "conflict", source: projectDuplicate.scope, code: gentle ? "duplicate-gentle-engram" : "duplicate-pi-mcp-adapter" };
    }
    const globalEntries = packageEntries.filter(({ scope }) => scope === "pi-global-settings");
    const gentleCount = globalEntries.filter(({ source }) => isGentleEntry(source)).length;
    const adapterCount = globalEntries.filter(({ source }) => isAdapterEntry(source)).length;
    if (gentleCount > 1) return { state: "conflict", source: "pi-global-settings", code: "duplicate-gentle-engram" };
    if (adapterCount > 1) return { state: "conflict", source: "pi-global-settings", code: "duplicate-pi-mcp-adapter" };
    // Absent settings files carry no evidence and stay permissive (isolated
    // resolvers rely on it); present settings without the single official
    // pair fail closed without any bundled fallback.
    if (gentleCount !== 1 || adapterCount !== 1) {
      return { state: "missing", source: "pi-global-settings", code: "missing-official-packages" };
    }
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
