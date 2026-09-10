import { execFileSync as nodeExecFileSync } from "node:child_process";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

const HANDOFF_RELATIVE_PATH = ["jorgex-pi", "playwright.v1.json"];
const PLAYWRIGHT_VERSION = "0.1.18";
const VERSION_TIMEOUT_MS = 5_000;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const WINDOWS_CMD_METACHARACTERS = /[&|<>()^%!"\r\n]/;

export function resolvePlaywrightCapability({
  agentDir,
  env = process.env,
  platform = process.platform,
  execFileSync = nodeExecFileSync,
} = {}) {
  try {
    const paths = platformPaths(platform);
    const resolvedAgentDir = agentDir === undefined
      ? resolveDefaultAgentDir({ env, platform, paths })
      : validateAbsolutePath(agentDir, paths, "agentDir");
    const handoffPath = paths.join(resolvedAgentDir, ...HANDOFF_RELATIVE_PATH);
    const handoff = readHandoff(handoffPath, paths);
    if (!handoff) return hiddenCapability();

    const invocation = planExecutable(handoff.command, platform, env);
    if (invocation === undefined || !isExecutable(handoff.command, platform)) return hiddenCapability();

    const output = execFileSync(invocation.command, invocation.args, {
      encoding: "utf8",
      timeout: VERSION_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      env: { ...env, NO_UPDATE_NOTIFIER: "1" },
    });
    if (!isExpectedVersion(output)) return hiddenCapability();

    return { status: "ready", commandPath: handoff.command };
  } catch {
    return hiddenCapability();
  }
}

function readHandoff(handoffPath, paths) {
  let raw;
  try {
    raw = readFileSync(handoffPath, "utf8");
  } catch {
    return undefined;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const keys = Object.keys(parsed).sort();
  if (keys.join("\0") !== ["command", "enabled", "schemaVersion", "version"].join("\0")) return undefined;
  if (parsed.schemaVersion !== 1 || parsed.enabled !== true || parsed.version !== PLAYWRIGHT_VERSION) return undefined;
  if (typeof parsed.command !== "string" || CONTROL_CHARACTERS.test(parsed.command)) return undefined;
  if (!paths.isAbsolute(parsed.command)) return undefined;
  return { command: parsed.command };
}

function resolveDefaultAgentDir({ env, platform, paths }) {
  const configured = env?.PI_CODING_AGENT_DIR;
  if (configured !== undefined) return validateAbsolutePath(configured, paths, "PI_CODING_AGENT_DIR");

  const configuredHome = platform === "win32"
    ? env?.USERPROFILE ?? env?.HOME
    : env?.HOME ?? env?.USERPROFILE;
  const home = typeof configuredHome === "string" && paths.isAbsolute(configuredHome)
    ? configuredHome
    : homedir();
  return paths.join(paths.resolve(home), ".pi", "agent");
}

function validateAbsolutePath(value, paths, label) {
  if (typeof value !== "string" || !value || CONTROL_CHARACTERS.test(value) || !paths.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path`);
  }
  return paths.resolve(value);
}

function planExecutable(command, platform, env) {
  if (platform !== "win32" || !/\.(cmd|bat)$/i.test(command)) return { command, args: ["--version"] };
  if (WINDOWS_CMD_METACHARACTERS.test(command)) return undefined;
  const quote = (part) => part === "" || /\s/.test(part) ? `"${part}"` : part;
  return {
    command: env?.ComSpec ?? env?.COMSPEC ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${[quote(command), "--version"].join(" ")}"`],
    windowsVerbatimArguments: true,
  };
}

function isExpectedVersion(output) {
  return /^(?:playwright-cli\s+)?0\.1\.18$/i.test(String(output).trim());
}

function isExecutable(path, platform) {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return false;
    if (platform !== "win32") accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function platformPaths(platform) {
  return platform === "win32" ? win32 : posix;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hiddenCapability() {
  return { status: "hidden" };
}
