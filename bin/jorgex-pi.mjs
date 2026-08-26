#!/usr/bin/env node

import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let manifest;
let packageInfo = { name: "jorgex-pi", version: "unknown", root };
const commands = new Set(["status", "doctor", "models", "sync", "cleanup"]);
const exitCodes = { success: 0, unhealthy: 1, usage: 2, internal: 3 };
const maxStdoutBytes = 65536;
const maxLifecycleJsonBytes = 1024 * 1024;
const lifecycleReceiptName = "sol-lifecycle.v1.json";
const lifecycleFields = [
  {
    key: "settings.defaultProvider",
    config: "settings",
    path: ["defaultProvider"],
    value: "openai-codex",
  },
  {
    key: "settings.defaultModel",
    config: "settings",
    path: ["defaultModel"],
    value: "gpt-5.6-sol",
  },
  {
    key: "models.providers.openai-codex.modelOverrides.gpt-5.6-sol.contextWindow",
    config: "models",
    path: ["providers", "openai-codex", "modelOverrides", "gpt-5.6-sol", "contextWindow"],
    value: 872000,
  },
];
const lifecycleFieldByKey = new Map(lifecycleFields.map((field) => [field.key, field]));
const lifecycleContainerPaths = new Map(
  lifecycleFields.flatMap((field) => field.path.slice(0, -1).map((_, index) => {
    const path = field.path.slice(0, index + 1);
    return [`${field.config}.${path.join(".")}`, { config: field.config, path }];
  })),
);
const lifecycleContainerKeys = new Set(lifecycleContainerPaths.keys());
const lifecycleFileKeys = new Set(["settings", "models"]);
let temporaryFileCounter = 0;
let currentCommand = "unknown";

class LifecycleError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

try {
  manifest = readJson(join(root, "package.json"));
  packageInfo = { name: manifest.name, version: manifest.version, root };
  const args = process.argv.slice(2);
  const command = args[0];
  currentCommand = command ?? "unknown";
  const validArgs = args.length === 1 || (args.length === 2 && args[1] === "--json");
  if (!validArgs || !commands.has(command)) {
    emit("unknown", false, {}, {
      phase: "arguments",
      code: "USAGE",
      message: "Expected one command: status, doctor, models, sync, or cleanup.",
    }, exitCodes.usage);
  } else if (command === "models") {
    emit(command, true, {
      mode: "managed-primary",
      primary: { provider: "openai-codex", model: "gpt-5.6-sol", contextWindow: 872000 },
      tiers: ["strong", "standard", "cheap"],
    });
  } else if (command === "sync" || command === "cleanup") {
    emit(command, true, command === "sync" ? syncLifecycle() : cleanupLifecycle());
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
  if (error instanceof LifecycleError) {
    emit(currentCommand, false, { changed: false, actions: [] }, {
      phase: "lifecycle",
      code: error.code,
      message: error.message,
    }, exitCodes.unhealthy);
  } else {
    emit("unknown", false, {}, {
      phase: "runner",
      code: "INTERNAL",
      message: error instanceof Error ? error.message : String(error),
    }, exitCodes.internal);
  }
}

function inspectState() {
  return {
    installation: inspectInstallation(),
    engram: inspectEngram(),
  };
}

function inspectInstallation() {
  const settingsPath = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "settings.json");
  const invalid = (reason, matches = 0) => ({ state: "invalid", matches, path: settingsPath, reason });
  let settings;
  try {
    settings = readJson(settingsPath);
  } catch (error) {
    if (error?.code === "ENOENT") return { state: "unregistered", matches: 0 };
    const reason = error instanceof SyntaxError
      ? `Invalid JSON in Pi settings: ${error.message}`
      : `Unable to read Pi settings: ${error instanceof Error ? error.message : String(error)}`;
    return invalid(reason);
  }
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
    return invalid("Pi settings root must be a JSON object.");
  }
  if (settings.packages === undefined) return { state: "unregistered", matches: 0 };
  if (!Array.isArray(settings.packages)) return invalid("Pi settings packages must be an array.");
  const source = `npm:${manifest.name}@${manifest.version}`;
  const matches = settings.packages.filter((entry) => {
    const candidate = typeof entry === "string" ? entry : entry?.source;
    return candidate === source;
  }).length;
  if (matches > 1) return invalid(`Pi settings contain ${matches} exact registrations for ${source}.`, matches);
  return { state: matches === 0 ? "unregistered" : "registered", matches };
}

function inspectEngram() {
  const configured = process.env.ENGRAM_BIN;
  if (typeof configured === "string" && configured.length > 0) {
    if (!isAbsolute(configured)) {
      return { state: "invalid", ownership: "user", reason: "ENGRAM_BIN must be an absolute path" };
    }
    if (process.platform === "win32" && !/\.exe$/i.test(configured)) {
      return { state: "invalid", ownership: "user", path: configured, source: "environment", reason: "ENGRAM_BIN must point to a native .exe executable" };
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

function syncLifecycle() {
  return withLifecycleLocks(syncLifecycleUnlocked, true);
}

function syncLifecycleUnlocked() {
  const state = loadLifecycleState();
  const { receipt } = state;
  const actions = [];

  for (const field of lifecycleFields) {
    const config = state.configs[field.config];
    const current = readPath(config.value, field.path);
    if (current.exists) {
      if (hasOwn(receipt.value.fields, field.key) && !Object.is(current.value, field.value)) {
        delete receipt.value.fields[field.key];
        receipt.dirty = true;
        actions.push(`released:${field.key}`);
      }
      continue;
    }
    if (!shouldCreateLifecycleField(field, state)) continue;

    markOwnedFile(config, receipt, actions);
    const parent = ensureObjectPath(config, field.path.slice(0, -1), receipt, actions);
    parent[field.path.at(-1)] = field.value;
    config.dirty = true;
    actions.push(`created:${field.key}`);
    if (!hasOwn(receipt.value.fields, field.key)) {
      receipt.value.fields[field.key] = field.value;
      receipt.dirty = true;
    }
  }

  releaseUnusedContainerOwnership(receipt);
  finalizeReceipt(state);
  return persistLifecycle(state, actions);
}

function cleanupLifecycle() {
  return withLifecycleLocks(cleanupLifecycleUnlocked, false);
}

function cleanupLifecycleUnlocked() {
  const state = loadLifecycleState();
  const { receipt } = state;
  const actions = [];
  if (!receipt.exists) return { changed: false, actions };

  for (const field of lifecycleFields) {
    if (!hasOwn(receipt.value.fields, field.key)) continue;
    const current = readPath(state.configs[field.config].value, field.path);
    if (current.exists && Object.is(current.value, field.value)) {
      delete current.parent[current.key];
      state.configs[field.config].dirty = true;
      actions.push(`removed:${field.key}`);
    } else {
      actions.push(`released:${field.key}`);
    }
    delete receipt.value.fields[field.key];
    receipt.dirty = true;
  }

  for (const containerKey of [...lifecycleContainerKeys].sort((left, right) => right.length - left.length)) {
    if (!hasOwn(receipt.value.containers, containerKey)) continue;
    const container = lifecycleContainerPaths.get(containerKey);
    const current = readPath(state.configs[container.config].value, container.path);
    if (current.exists && isJsonObject(current.value) && Object.keys(current.value).length === 0) {
      delete current.parent[current.key];
      state.configs[container.config].dirty = true;
      actions.push(`pruned:${containerKey}`);
    }
    delete receipt.value.containers[containerKey];
    receipt.dirty = true;
  }

  for (const configName of lifecycleFileKeys) {
    if (!hasOwn(receipt.value.files, configName)) continue;
    const config = state.configs[configName];
    if (config.exists && isJsonObject(config.value) && Object.keys(config.value).length === 0) {
      config.remove = true;
      config.dirty = true;
      actions.push(`removed:${configName}.json`);
    }
    delete receipt.value.files[configName];
    receipt.dirty = true;
  }

  finalizeReceipt(state);
  return persistLifecycle(state, actions);
}

function shouldCreateLifecycleField(field, state) {
  if (field.config === "settings") {
    const otherPath = field.key === "settings.defaultProvider" ? ["defaultModel"] : ["defaultProvider"];
    const otherValue = field.key === "settings.defaultProvider" ? "gpt-5.6-sol" : "openai-codex";
    const other = readPath(state.configs.settings.value, otherPath);
    return !other.exists || Object.is(other.value, otherValue);
  }
  const provider = readPath(state.configs.settings.value, ["defaultProvider"]);
  const model = readPath(state.configs.settings.value, ["defaultModel"]);
  return provider.exists
    && Object.is(provider.value, "openai-codex")
    && model.exists
    && Object.is(model.value, "gpt-5.6-sol");
}

function withLifecycleLocks(callback, createAgentDir) {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  if (!createAgentDir && !existsSync(agentDir)) return callback();
  const lockPaths = [join(agentDir, "settings.json.lock"), join(agentDir, "models.json.lock")];
  const acquired = [];
  let result;
  let failure;
  try {
    try {
      mkdirSync(agentDir, { recursive: true });
    } catch (error) {
      throw lifecycleFsError("LOCK_FAILED", "prepare lock directory", agentDir, error);
    }
    for (const lockPath of lockPaths) {
      try {
        mkdirSync(lockPath);
        acquired.push(lockPath);
      } catch (error) {
        if (error?.code === "EEXIST") {
          throw new LifecycleError("CONFIG_LOCKED", "Pi configuration is being updated by another process; retry.");
        }
        throw lifecycleFsError("LOCK_FAILED", "lock", lockPath, error);
      }
    }
    result = callback();
  } catch (error) {
    failure = error;
  }

  let releaseFailure;
  for (const lockPath of acquired.reverse()) {
    try {
      rmdirSync(lockPath);
    } catch (error) {
      if (error?.code !== "ENOENT" && releaseFailure === undefined) {
        releaseFailure = lifecycleFsError("UNLOCK_FAILED", "unlock", lockPath, error);
      }
    }
  }
  if (failure !== undefined) throw failure;
  if (releaseFailure !== undefined) throw releaseFailure;
  return result;
}

function loadLifecycleState() {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  const configs = {
    settings: readLifecycleConfig("settings", join(agentDir, "settings.json"), "Pi settings"),
    models: readLifecycleConfig("models", join(agentDir, "models.json"), "Pi models"),
  };
  const receiptPath = join(agentDir, "jorgex-pi", lifecycleReceiptName);
  return { configs, receipt: readLifecycleReceipt(receiptPath) };
}

function readLifecycleConfig(name, path, label) {
  const document = readBoundedJsonObject(path, label, "INVALID_JSON", "CONFIG_TOO_LARGE");
  return { ...document, name, path, label, dirty: false, remove: false };
}

function readLifecycleReceipt(path) {
  const document = readBoundedJsonObject(path, "Pi lifecycle receipt", "INVALID_RECEIPT", "RECEIPT_TOO_LARGE");
  if (!document.exists) {
    return { exists: false, path, value: emptyReceipt(), dirty: false, remove: false };
  }
  validateReceipt(document.value);
  return { ...document, path, dirty: false, remove: false };
}

function readBoundedJsonObject(path, label, invalidCode, tooLargeCode) {
  let stats;
  try {
    stats = statSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, value: {} };
    throw new LifecycleError("READ_FAILED", `Unable to read ${label}.`);
  }
  if (!stats.isFile()) throw new LifecycleError("INVALID_PATH", `${label} must be a regular file.`);
  if (stats.size > maxLifecycleJsonBytes) {
    throw new LifecycleError(tooLargeCode, `${label} exceeds the supported size limit.`);
  }
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw lifecycleFsError("READ_FAILED", "read", path, error);
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new LifecycleError(invalidCode, `Invalid JSON in ${label}.`);
  }
  if (!isJsonObject(value)) throw new LifecycleError(invalidCode, `${label} root must be a JSON object.`);
  return { exists: true, value };
}

function ensureObjectPath(config, path, receipt, actions) {
  let target = config.value;
  const segments = [];
  for (const segment of path) {
    segments.push(segment);
    if (!hasOwn(target, segment)) {
      target[segment] = {};
      config.dirty = true;
      const containerKey = `${config.name}.${segments.join(".")}`;
      if (!hasOwn(receipt.value.containers, containerKey)) {
        receipt.value.containers[containerKey] = true;
        receipt.dirty = true;
      }
      actions.push(`created:${containerKey}`);
    } else if (!isJsonObject(target[segment])) {
      throw new LifecycleError("INVALID_CONFIG_SHAPE", `${config.label} cannot merge the managed Sol configuration.`);
    }
    target = target[segment];
  }
  return target;
}

function markOwnedFile(config, receipt, actions) {
  if (config.exists || hasOwn(receipt.value.files, config.name)) return;
  const configName = config.name;
  receipt.value.files[configName] = true;
  receipt.dirty = true;
  actions.push(`created:${configName}.json`);
}

function releaseUnusedContainerOwnership(receipt) {
  for (const containerKey of Object.keys(receipt.value.containers)) {
    if (Object.keys(receipt.value.fields).some((fieldKey) => fieldKey.startsWith(`${containerKey}.`))) continue;
    delete receipt.value.containers[containerKey];
    receipt.dirty = true;
  }
  for (const configName of Object.keys(receipt.value.files)) {
    if (Object.keys(receipt.value.fields).some((fieldKey) => fieldKey.startsWith(`${configName}.`))) continue;
    delete receipt.value.files[configName];
    receipt.dirty = true;
  }
}

function finalizeReceipt(state) {
  const { receipt } = state;
  if (isReceiptEmpty(receipt.value) && receipt.exists) {
    receipt.remove = true;
    receipt.dirty = true;
  }
}

function persistLifecycle(state, actions) {
  const configChanges = Object.values(state.configs).some((config) => config.dirty);
  const receiptChanges = state.receipt.dirty;
  if (!configChanges && !receiptChanges) return { changed: false, actions: [] };

  if (state.receipt.dirty && !state.receipt.remove) writeJsonAtomic(state.receipt.path, orderedReceipt(state.receipt.value));
  for (const config of Object.values(state.configs)) {
    if (!config.dirty) continue;
    if (config.remove) removeFile(config.path);
    else writeJsonAtomic(config.path, config.value);
  }
  if (state.receipt.remove) {
    removeFile(state.receipt.path);
    removeEmptyDirectory(dirname(state.receipt.path));
  }
  return { changed: true, actions };
}

function writeJsonAtomic(path, value) {
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch (error) {
    throw lifecycleFsError("WRITE_FAILED", "create directory for", path, error);
  }
  const temporaryPath = join(dirname(path), `.${process.pid}.${temporaryFileCounter += 1}.tmp`);
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    renameSync(temporaryPath, path);
  } catch (error) {
    let cleanupError;
    try {
      unlinkSync(temporaryPath);
    } catch (candidate) {
      if (candidate?.code !== "ENOENT") cleanupError = candidate;
    }
    const suffix = cleanupError === undefined
      ? ""
      : `; temporary cleanup also failed (${cleanupError?.code ?? "unknown"})`;
    throw lifecycleFsError("WRITE_FAILED", "write", path, error, suffix);
  }
}

function removeFile(path) {
  try {
    unlinkSync(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw lifecycleFsError("REMOVE_FAILED", "remove", path, error);
  }
}

function removeEmptyDirectory(path) {
  try {
    rmdirSync(path);
  } catch (error) {
    if (error?.code !== "ENOENT" && error?.code !== "ENOTEMPTY") {
      throw lifecycleFsError("REMOVE_FAILED", "remove directory", path, error);
    }
  }
}

function lifecycleFsError(code, operation, path, error, suffix = "") {
  const reason = error?.code ?? (error instanceof Error ? error.message : String(error));
  return new LifecycleError(code, `Unable to ${operation} ${path} (${reason})${suffix}.`);
}

function readPath(rootValue, path) {
  let parent;
  let current = rootValue;
  for (const key of path) {
    if (!isJsonObject(current) || !hasOwn(current, key)) return { exists: false };
    parent = current;
    current = current[key];
  }
  return { exists: true, parent, key: path.at(-1), value: current };
}

function emptyReceipt() {
  return { schemaVersion: 1, fields: {}, containers: {}, files: {} };
}

function orderedReceipt(receipt) {
  const ordered = emptyReceipt();
  for (const field of lifecycleFields) {
    if (hasOwn(receipt.fields, field.key)) ordered.fields[field.key] = field.value;
  }
  for (const containerKey of [...lifecycleContainerKeys].sort()) {
    if (hasOwn(receipt.containers, containerKey)) ordered.containers[containerKey] = true;
  }
  for (const configName of [...lifecycleFileKeys].sort()) {
    if (hasOwn(receipt.files, configName)) ordered.files[configName] = true;
  }
  return ordered;
}

function validateReceipt(receipt) {
  if (receipt.schemaVersion !== 1 || !isJsonObject(receipt.fields) || !isJsonObject(receipt.containers) || !isJsonObject(receipt.files)) {
    throw new LifecycleError("INVALID_RECEIPT", "Pi lifecycle receipt has an unsupported shape.");
  }
  for (const [key, value] of Object.entries(receipt.fields)) {
    const field = lifecycleFieldByKey.get(key);
    if (!field || !Object.is(value, field.value)) {
      throw new LifecycleError("INVALID_RECEIPT", "Pi lifecycle receipt contains an unsupported field.");
    }
  }
  for (const [key, value] of Object.entries(receipt.containers)) {
    if (!lifecycleContainerKeys.has(key) || value !== true) {
      throw new LifecycleError("INVALID_RECEIPT", "Pi lifecycle receipt contains an unsupported container.");
    }
  }
  for (const [key, value] of Object.entries(receipt.files)) {
    if (!lifecycleFileKeys.has(key) || value !== true) {
      throw new LifecycleError("INVALID_RECEIPT", "Pi lifecycle receipt contains an unsupported file.");
    }
  }
}

function isReceiptEmpty(receipt) {
  return Object.keys(receipt.fields).length === 0
    && Object.keys(receipt.containers).length === 0
    && Object.keys(receipt.files).length === 0;
}

function isJsonObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function findOnPath(name) {
  const directories = (process.env.PATH ?? "").split(delimiter).filter((directory) => isAbsolute(directory));
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE").split(";").filter((extension) => extension.toLowerCase() === ".exe")
    : [""];
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = join(directory, `${name}${extension}`);
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
    const duplicate = state.installation.matches > 1;
    return {
      phase: "status",
      code: duplicate ? "DUPLICATE_REGISTRATION" : "INVALID_SETTINGS",
      message: state.installation.reason,
      remedy: duplicate
        ? `Keep exactly one package entry in Pi settings at ${state.installation.path} and retry.`
        : `Correct the Pi settings JSON at ${state.installation.path} and retry.`,
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
  return { phase: "status", code: "INVALID_STATE", message: "Runtime state is invalid." };
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
