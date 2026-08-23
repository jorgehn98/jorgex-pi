#!/usr/bin/env node

import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let manifest;
let packageInfo = { name: "jorgex-pi", version: "unknown", root };
const commands = new Set(["status", "doctor", "models", "sync", "cleanup"]);
const exitCodes = { success: 0, unhealthy: 1, usage: 2, internal: 3 };
const maxStdoutBytes = 65536;

try {
  manifest = readJson(join(root, "package.json"));
  packageInfo = { name: manifest.name, version: manifest.version, root };
  const args = process.argv.slice(2);
  const command = args[0];
  const validArgs = args.length === 1 || (args.length === 2 && args[1] === "--json");
  if (!validArgs || !commands.has(command)) {
    emit("unknown", false, {}, {
      phase: "arguments",
      code: "USAGE",
      message: "Expected one command: status, doctor, models, sync, or cleanup.",
    }, exitCodes.usage);
  } else if (command === "models") {
    emit(command, true, { mode: "inherit-session", tiers: ["strong", "standard", "cheap"] });
  } else if (command === "sync" || command === "cleanup") {
    emit(command, true, { changed: false, actions: [] });
  } else {
    const state = inspectState();
    if (command === "status") {
      const healthy = state.installation.state !== "invalid" && state.engram.state !== "invalid";
      emit(command, healthy, state, healthy ? undefined : stateError(state), healthy ? exitCodes.success : exitCodes.unhealthy);
    } else {
      const checks = [
        {
          id: "package",
          status: state.installation.state === "registered" ? "ok" : "error",
        },
        {
          id: "engram",
          status: state.engram.state === "ready" ? "ok" : "error",
        },
      ];
      const healthy = checks.every(({ status }) => status === "ok");
      emit(command, healthy, { healthy, checks }, healthy ? undefined : {
        phase: "doctor",
        code: "UNHEALTHY",
        message: "One or more required runtime checks failed.",
        remedy: state.installation.state !== "registered"
          ? `Register exactly npm:${manifest.name}@${manifest.version} in Pi settings and retry.`
          : state.engram.state === "missing"
            ? "Set ENGRAM_BIN to the existing Engram executable and retry."
            : undefined,
      }, healthy ? exitCodes.success : exitCodes.unhealthy);
    }
  }
} catch (error) {
  emit("unknown", false, {}, {
    phase: "runner",
    code: "INTERNAL",
    message: error instanceof Error ? error.message : String(error),
  }, exitCodes.internal);
}

function inspectState() {
  return {
    installation: inspectInstallation(),
    engram: inspectEngram(),
  };
}

function inspectInstallation() {
  const settingsPath = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "settings.json");
  let settings;
  try {
    settings = readJson(settingsPath);
  } catch (error) {
    if (error?.code === "ENOENT") return { state: "unregistered", matches: 0 };
    const reason = error instanceof SyntaxError
      ? `Invalid JSON in Pi settings: ${error.message}`
      : `Unable to read Pi settings: ${error instanceof Error ? error.message : String(error)}`;
    return { state: "invalid", matches: 0, path: settingsPath, reason };
  }
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
    return { state: "invalid", matches: 0 };
  }
  if (settings.packages === undefined) return { state: "unregistered", matches: 0 };
  if (!Array.isArray(settings.packages)) return { state: "invalid", matches: 0 };
  const source = `npm:${manifest.name}@${manifest.version}`;
  const matches = settings.packages.filter((entry) => {
    const candidate = typeof entry === "string" ? entry : entry?.source;
    return candidate === source;
  }).length;
  return { state: matches === 0 ? "unregistered" : matches === 1 ? "registered" : "invalid", matches };
}

function inspectEngram() {
  const configured = process.env.ENGRAM_BIN;
  if (typeof configured === "string" && configured.length > 0) {
    if (!isAbsolute(configured)) {
      return { state: "invalid", ownership: "user", reason: "ENGRAM_BIN must be an absolute path" };
    }
    if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(configured)) {
      return { state: "invalid", ownership: "user", path: configured, source: "environment", reason: "ENGRAM_BIN must point to a native executable, not a .cmd or .bat shim" };
    }
    return isExecutable(configured)
      ? { state: "ready", ownership: "user", path: configured, source: "environment" }
      : { state: "missing", ownership: "user", path: configured, source: "environment" };
  }
  const path = findOnPath("engram");
  return path
    ? { state: "ready", ownership: "user", path, source: "path" }
    : { state: "missing", ownership: "user" };
}

function findOnPath(name) {
  const directories = (process.env.PATH ?? "").split(delimiter).filter((directory) => isAbsolute(directory));
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = join(directory, `${name}${extension}`);
      if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(candidate)) continue;
      if (isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}

function isExecutable(path) {
  try {
    accessSync(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function stateError(state) {
  if (state.installation.state === "invalid") {
    return {
      phase: "status",
      code: "INVALID_SETTINGS",
      message: state.installation.reason,
      remedy: `Correct the Pi settings JSON at ${state.installation.path} and retry.`,
    };
  }
  if (state.engram.state === "invalid") {
    return {
      phase: "engram",
      code: "INVALID_ENGRAM_BIN",
      message: state.engram.reason,
      remedy: "Set ENGRAM_BIN to an absolute executable path or remove it to use PATH discovery.",
    };
  }
  return {
    phase: "status",
    code: "INVALID_STATE",
    message: "Pi settings contain duplicate JorgeX registrations.",
    remedy: "Keep exactly one package entry for this jorgex-pi version and retry.",
  };
}

function emit(command, ok, result, error, exitCode = exitCodes.success) {
  const response = {
    schemaVersion: 1,
    command,
    ok,
    package: packageInfo,
    result,
    ...(error ? { error: withoutUndefined(error) } : {}),
  };
  let output = `${JSON.stringify(response)}\n`;
  if (Buffer.byteLength(output) > maxStdoutBytes) {
    output = `${JSON.stringify({
      schemaVersion: 1,
      command: "unknown",
      ok: false,
      package: packageInfo,
      result: {},
      error: {
        phase: "output",
        code: "OUTPUT_LIMIT",
        message: "Runner output exceeded the public size limit.",
      },
    })}\n`;
    exitCode = exitCodes.internal;
  }
  process.stdout.write(output);
  process.exitCode = exitCode;
}

function withoutUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
