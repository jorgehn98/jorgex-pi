import { lstatSync } from "node:fs";
import { posix, win32 } from "node:path";
import { readConfig, resolvePiAgentDir } from "./context7-config.mjs";
import { digestNativeMcpDefinition, readBoundedRegularFile } from "./mcp-engram.ts";

// Readonly ownership checker for the persistent native MCP configuration
// (Spec 71, "Proof offline y bind del checker"). This first vertical covers the
// direct channel without granular authority: a valid `mcp.json` entry that
// carries no `mcpNative` claim is `unowned`, and no heavy package proof is
// performed. Ownership is authority, never shape, so an equal command/url is
// never claimed. The trusted-project override vertical and the package/tamper
// proof are later; `projectTrusted` is part of the frozen public signature but
// currently does not read any project file, so an explicitly supplied `cwd` is
// the only working directory used.
const SERVER_NAMES = ["engram", "context7", "chrome-devtools"];
const AUTHORITY_RELATIVE_PATH = [".jorgex-stack", "pi-projection-receipt.json"];
const AUTHORITY_MAX_BYTES = 1024 * 1024;

export async function inspectNativeMcpOwnership({
  env = process.env,
  platform = process.platform,
  cwd = process.cwd(),
} = {}) {
  const paths = platform === "win32" ? win32 : posix;
  const home = requireAbsoluteHome(env, platform);
  const agentDir = resolvePiAgentDir({ env, cwd, platform });
  const config = readNativeConfig(paths.join(agentDir, "mcp.json"));
  const claims = readProjectionClaims(paths.join(home, ...AUTHORITY_RELATIVE_PATH)) ?? new Set();
  const servers = {};
  for (const name of SERVER_NAMES) {
    servers[name] = inspectServer(name, config?.mcpServers?.[name], claims.has(name));
  }
  return {
    servers,
    package: { state: claims.size > 0 ? "conflict" : "not-required" },
    connection: "not-verified",
  };
}

function requireAbsoluteHome(env, platform) {
  const paths = platform === "win32" ? win32 : posix;
  const home = platform === "win32" ? env.USERPROFILE ?? env.HOME : env.HOME ?? env.USERPROFILE;
  if (typeof home !== "string" || !paths.isAbsolute(home)) {
    throw new Error("Native MCP inspection requires an absolute HOME");
  }
  return home;
}

// Pi's native parser is strict JSON; the shared bounded reader is reused with
// its strict mode. Any failure is generic so no raw configuration or user data
// reaches a diagnostic, and an invalid file never becomes a silent success.
function readNativeConfig(mcpPath) {
  let config;
  try {
    config = readConfig(mcpPath, { strict: true });
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw new Error("Native MCP configuration is invalid or unreadable");
  }
  if (!isRecord(config)) throw new Error("Native MCP configuration must be an object");
  if (config.mcpServers !== undefined && !isRecord(config.mcpServers)) {
    throw new Error("Native MCP configuration has an invalid mcpServers section");
  }
  return config;
}

// The granular authority is read only; a symlinked, malformed or unreadable
// receipt fails closed instead of degrading to an unowned success.
function readProjectionClaims(authorityPath) {
  let stat;
  try {
    stat = lstatSync(authorityPath);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw new Error("Native MCP projection authority is unreadable");
  }
  if (stat.isSymbolicLink()) throw new Error("Native MCP projection authority must not be a symlink");
  const bytes = readBoundedRegularFile(authorityPath, AUTHORITY_MAX_BYTES, "Native MCP projection authority");
  let authority;
  try {
    authority = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("Native MCP projection authority is invalid");
  }
  if (!isRecord(authority)) throw new Error("Native MCP projection authority must be an object");
  if (authority.mcpNative === undefined) return new Set();
  if (!isRecord(authority.mcpNative)
    || authority.mcpNative.schemaVersion !== 1
    || !isRecord(authority.mcpNative.entries)) {
    throw new Error("Native MCP projection authority has an unsupported shape");
  }
  const { entries } = authority.mcpNative;
  return new Set(SERVER_NAMES.filter((name) => entries[name] !== undefined));
}

function inspectServer(name, entry, claimed) {
  if (entry === undefined) {
    return {
      state: claimed ? "conflict" : "absent",
      cleanupEligible: false,
      availability: "unavailable",
      ...(claimed ? { reason: "Claimed native MCP entry is absent from mcp.json" } : {}),
    };
  }
  try {
    digestNativeMcpDefinition(name, entry);
  } catch {
    // A present entry that is not a valid managed definition can never be
    // silently digested or reported unowned: it fails closed as conflict.
    return {
      state: "conflict",
      cleanupEligible: false,
      availability: "unavailable",
      reason: "Native MCP definition is invalid or unsupported",
    };
  }
  const availability = entry.enabled === false
    ? "disabled"
    : hasRawExecutionCustomization(entry) ? "unsupported-execution" : "configured";
  if (claimed) {
    return {
      state: "conflict",
      cleanupEligible: false,
      availability,
      reason: "Granular native MCP ownership requires package proof that is not implemented",
    };
  }
  // Availability is syntax only: a present definition is configured, never a
  // live connection, and without a claim it is never owned or cleanup-eligible.
  return { state: "unowned", cleanupEligible: false, availability };
}

// Raw, user-authored `!` executions stay inert data: they classify availability
// as unsupported-execution without being resolved, imported or executed.
function hasRawExecutionCustomization(entry) {
  for (const key of ["env", "headers"]) {
    const record = entry?.[key];
    if (isRecord(record) && Object.values(record).some((value) => typeof value === "string" && value.startsWith("!"))) {
      return true;
    }
  }
  return false;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
