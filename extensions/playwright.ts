import { execFileSync as nodeExecFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { browserTreeSha256, readBoundedRegularFile } from "./mcp-engram.ts";

const HANDOFF_RELATIVE_PATH = ["jorgex-pi", "playwright.v1.json"];
const STABLE_EXACT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const VERSION_TIMEOUT_MS = 5_000;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const WINDOWS_CMD_METACHARACTERS = /[&|<>()^%!"\r\n]/;
const DIGEST = /^[0-9a-f]{64}$/;
const MAX_PATH_BYTES = 16 * 1024;
const MAX_DISPATCHER_BYTES = 4 * 1024 * 1024;
const MAX_LAUNCHER_BYTES = 4 * 1024 * 1024;
const TRUSTED_KEYS = [
  "command", "commandSha256", "enabled", "entryPath", "launcherPath", "launcherSha256",
  "rootPath", "schemaVersion", "treePath", "treeSha256", "version",
];

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
    const handoff = readHandoff(handoffPath, paths, platform);
    if (!handoff) return hiddenCapability();

    const invocation = planExecutable(handoff.command, platform, env, handoff.trusted === true);
    if (invocation === undefined || !isExecutable(handoff.command, platform)) return hiddenCapability();

    const output = execFileSync(invocation.command, invocation.args, {
      encoding: "utf8",
      timeout: VERSION_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      env: { ...env, NO_UPDATE_NOTIFIER: "1" },
    });
    if (!isExpectedVersion(output, handoff.version)) return hiddenCapability();

    return { status: "ready", commandPath: handoff.command, ...(handoff.trusted ? { trusted: true } : {}) };
  } catch {
    return hiddenCapability();
  }
}

function readHandoff(handoffPath, paths, platform) {
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
  if (parsed.schemaVersion === 2) return readTrustedHandoff(parsed, keys, paths, platform);
  if (keys.join("\0") !== ["command", "enabled", "schemaVersion", "version"].join("\0")) return undefined;
  if (parsed.schemaVersion !== 1 || parsed.enabled !== true || !isStableExactVersion(parsed.version)) return undefined;
  if (typeof parsed.command !== "string" || CONTROL_CHARACTERS.test(parsed.command)) return undefined;
  if (!paths.isAbsolute(parsed.command)) return undefined;
  return { command: parsed.command, version: parsed.version };
}

function readTrustedHandoff(handoff, keys, paths, platform) {
  if (keys.join("\0") !== TRUSTED_KEYS.join("\0")
    || handoff.enabled !== true || !isStableExactVersion(handoff.version)
    || !DIGEST.test(handoff.commandSha256) || !DIGEST.test(handoff.launcherSha256)
    || !DIGEST.test(handoff.treeSha256)) return undefined;

  for (const [label, value, directory] of [
    ["dispatcher", handoff.command, false],
    ["root", handoff.rootPath, true],
    ["tree", handoff.treePath, true],
    ["entry", handoff.entryPath, false],
    ["launcher", handoff.launcherPath, false],
  ]) {
    if (!trustedPath(value, directory, paths)) return undefined;
  }
  if (!contained(handoff.rootPath, handoff.treePath, paths)
    || !contained(handoff.rootPath, handoff.launcherPath, paths)
    || !contained(handoff.treePath, handoff.entryPath, paths)
    || contained(handoff.rootPath, handoff.command, paths)) return undefined;

  const dispatcher = readBoundedRegularFile(handoff.command, MAX_DISPATCHER_BYTES, "Playwright dispatcher");
  const launcher = readBoundedRegularFile(handoff.launcherPath, MAX_LAUNCHER_BYTES, "Playwright launcher");
  if (!Buffer.from(launcher.toString("utf8"), "utf8").equals(launcher)) return undefined;
  if (sha256(dispatcher) !== handoff.commandSha256 || sha256(launcher) !== handoff.launcherSha256) return undefined;
  if (browserTreeSha256(handoff.treePath, platform) !== handoff.treeSha256) return undefined;
  return { command: handoff.command, version: handoff.version, trusted: true };
}

function trustedPath(value, directory, paths) {
  if (typeof value !== "string" || CONTROL_CHARACTERS.test(value)
    || !paths.isAbsolute(value) || paths.resolve(value) !== value
    || Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES) return false;
  const resolved = realpathSync(value);
  if ((paths === win32 ? resolved.toLowerCase() !== value.toLowerCase() : resolved !== value)) return false;
  const stat = lstatSync(value);
  return !stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile());
}

function contained(root, candidate, paths) {
  const rel = paths.relative(paths.resolve(root), paths.resolve(candidate));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${paths.sep}`) && !paths.isAbsolute(rel);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
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

function planExecutable(command, platform, env, trusted) {
  if (platform === "win32" && trusted && /\.js$/i.test(command)) {
    return { command: process.execPath, args: [command, "--version"] };
  }
  if (platform !== "win32" || !/\.(cmd|bat)$/i.test(command)) return { command, args: ["--version"] };
  if (WINDOWS_CMD_METACHARACTERS.test(command)) return undefined;
  const quote = (part) => part === "" || /\s/.test(part) ? `"${part}"` : part;
  return {
    command: env?.ComSpec ?? env?.COMSPEC ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${[quote(command), "--version"].join(" ")}"`],
    windowsVerbatimArguments: true,
  };
}

function isExpectedVersion(output, version) {
  const trimmed = String(output).trim();
  const reported = /^playwright-cli\s+/i.test(trimmed) ? trimmed.replace(/^playwright-cli\s+/i, "") : trimmed;
  return reported === version;
}

function isStableExactVersion(version) {
  return typeof version === "string" && STABLE_EXACT_SEMVER.test(version);
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
