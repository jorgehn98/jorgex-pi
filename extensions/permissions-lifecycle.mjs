import { createHash } from "node:crypto";
import {
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const CONFIG_RELATIVE_PATH = join("extensions", "pi-permission-system", "config.json");
const RECEIPT_RELATIVE_PATH = join("jorgex-pi", "permissions-lifecycle.v1.json");
const DEFAULTS_RELATIVE_PATH = join("assets", "permissions", "defaults.json");
const BACKUP_PREFIX = "permissions-backup-";
const MAX_JSON_BYTES = 1024 * 1024;

export class PermissionsLifecycleError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function syncPermissions({ agentDir, packageRoot }) {
  const paths = permissionPaths(agentDir, packageRoot);
  const defaults = readDefaults(paths.defaults);
  const current = readPermissionFile(paths.config);
  if (current.exists && (!current.regular || !current.readable)) {
    throw new PermissionsLifecycleError("INVALID_CONFIG", current.error ?? "Pi permission config is not a readable regular file.");
  }
  const receipt = readReceipt(paths.receipt);
  const actions = [];
  let changed = false;

  if (receipt.owned !== undefined) {
    const ownedHash = receipt.owned.configSha256;
    const currentHash = current.readable ? sha256(current.bytes) : undefined;
    if (!current.exists || currentHash !== ownedHash) {
      delete receipt.owned;
      actions.push("released:permissions.config");
      changed = true;
    }
  }

  if (!current.exists && !receipt.exists) {
    const publication = publishExclusive(paths.config, defaults.bytes, paths.agentDir);
    if (publication.created) {
      receipt.owned = { configSha256: sha256(defaults.bytes) };
      actions.push("created:permissions.config");
      changed = true;
    } else {
      actions.push("preserved:permissions.config");
    }
  } else if (current.exists && receipt.owned === undefined && receipt.initialized !== true) {
    actions.push("preserved:permissions.config");
  }

  if (receipt.initialized !== true) {
    receipt.initialized = true;
    actions.push("initialized:permissions");
    changed = true;
  }

  if (changed || !receipt.exists) {
    writeReceipt(paths.receipt, receipt, paths.agentDir);
    changed = true;
  }

  return { changed, actions };
}

export function cleanupPermissions({ agentDir }) {
  const paths = permissionPaths(agentDir);
  for (const path of [paths.config, paths.receipt]) {
    ensureManagedDirectory(paths.agentDir, dirname(path), "permission cleanup directory", false);
  }
  const current = readPermissionFile(paths.config);
  if (current.exists && (!current.regular || !current.readable)) {
    throw new PermissionsLifecycleError("INVALID_CONFIG", current.error ?? "Pi permission config is not a readable regular file.");
  }
  const receipt = readReceipt(paths.receipt);
  if (!receipt.exists) return { changed: false, actions: [] };

  const actions = [];
  if (receipt.owned !== undefined) {
    if (!current.readable || sha256(current.bytes) !== receipt.owned.configSha256) {
      actions.push("released:permissions.config");
    } else {
      removeOwnedConfigWithBackup(paths.config, paths.receipt, receipt.owned.configSha256, actions, paths.agentDir);
    }
    delete receipt.owned;
  }

  removeReceipt(paths.receipt);
  return { changed: true, actions };
}

export function inspectPermissions({ agentDir, packageRoot }) {
  const paths = permissionPaths(agentDir, packageRoot);
  let receipt;
  try {
    receipt = readReceipt(paths.receipt);
  } catch (error) {
    return {
      state: "invalid",
      path: paths.config,
      receiptPath: paths.receipt,
      initialized: false,
      owned: false,
      reason: error.message,
    };
  }

  const current = readPermissionFile(paths.config);
  if (current.error) {
    return {
      state: current.valid === false || current.regular === false ? "invalid" : "unreadable",
      path: paths.config,
      receiptPath: paths.receipt,
      initialized: receipt.initialized === true,
      owned: receipt.owned !== undefined,
      reason: current.error,
    };
  }
  if (!current.exists) {
    return {
      state: receipt.owned ? "missing-owned" : "absent",
      path: paths.config,
      receiptPath: paths.receipt,
      initialized: receipt.initialized === true,
      owned: receipt.owned !== undefined,
    };
  }
  if (!current.regular) {
    return {
      state: "invalid",
      path: paths.config,
      receiptPath: paths.receipt,
      initialized: receipt.initialized === true,
      owned: receipt.owned !== undefined,
      reason: "Pi permission config must be a regular file.",
    };
  }
  const currentHash = current.readable ? sha256(current.bytes) : undefined;
  const owned = receipt.owned?.configSha256 === currentHash;
  return {
    state: owned ? "managed" : "preexisting",
    path: paths.config,
    receiptPath: paths.receipt,
    initialized: receipt.initialized === true,
    owned,
  };
}

function permissionPaths(agentDir, packageRoot = agentDir) {
  if (typeof agentDir !== "string" || typeof packageRoot !== "string") {
    throw new PermissionsLifecycleError("INVALID_PATH", "Pi permission lifecycle paths must be strings.");
  }
  return {
    agentDir,
    config: join(agentDir, CONFIG_RELATIVE_PATH),
    receipt: join(agentDir, RECEIPT_RELATIVE_PATH),
    defaults: join(packageRoot, DEFAULTS_RELATIVE_PATH),
  };
}

function readDefaults(path) {
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    throw fsError("READ_DEFAULTS_FAILED", "read permission defaults", path, error);
  }
  if (bytes.length > MAX_JSON_BYTES) {
    throw new PermissionsLifecycleError("DEFAULTS_TOO_LARGE", "Pi permission defaults exceed the supported size limit.");
  }
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new PermissionsLifecycleError("INVALID_DEFAULTS", "Pi permission defaults contain invalid JSON.");
  }
  if (!isRecord(value?.permission)) {
    throw new PermissionsLifecycleError("INVALID_DEFAULTS", "Pi permission defaults must contain a permission object.");
  }
  return { bytes };
}

function readPermissionFile(path) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, readable: false, regular: false };
    return { exists: true, readable: false, regular: false, error: `Unable to inspect Pi permission config (${error?.code ?? "unknown"}).` };
  }
  if (!stat.isFile()) {
    return { exists: true, readable: false, regular: false, error: "Pi permission config must be a regular file." };
  }
  if (stat.size > MAX_JSON_BYTES) {
    return { exists: true, readable: false, regular: true, error: "Pi permission config exceeds the supported size limit." };
  }
  try {
    const bytes = readFileSync(path);
    if (bytes.length === 0) return { exists: true, readable: true, regular: true, valid: false, bytes, error: "Pi permission config contains invalid JSON." };
    let value;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      return { exists: true, readable: true, regular: true, valid: false, bytes, error: "Pi permission config contains invalid JSON." };
    }
    if (!isRecord(value)) {
      return { exists: true, readable: true, regular: true, valid: false, bytes, error: "Pi permission config root must be a JSON object." };
    }
    const issue = permissionConfigIssue(value);
    if (issue) return { exists: true, readable: true, regular: true, valid: false, bytes, error: issue };
    return { exists: true, readable: true, regular: true, valid: true, bytes };
  } catch (error) {
    return { exists: true, readable: false, regular: true, error: `Unable to read Pi permission config (${error?.code ?? "unknown"}).` };
  }
}

function readReceipt(path) {
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { exists: false, initialized: false };
    }
    throw fsError("READ_RECEIPT_FAILED", "read permission lifecycle receipt", path, error);
  }
  if (bytes.length > MAX_JSON_BYTES) {
    throw new PermissionsLifecycleError("RECEIPT_TOO_LARGE", "Pi permission lifecycle receipt exceeds the supported size limit.");
  }
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new PermissionsLifecycleError("INVALID_RECEIPT", "Pi permission lifecycle receipt contains invalid JSON.");
  }
  validateReceipt(value);
  return { exists: true, ...value };
}

function validateReceipt(value) {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.initialized !== true) {
    throw new PermissionsLifecycleError("INVALID_RECEIPT", "Pi permission lifecycle receipt has an unsupported shape.");
  }
  if (value.owned !== undefined
    && (!isRecord(value.owned)
      || typeof value.owned.configSha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(value.owned.configSha256))) {
    throw new PermissionsLifecycleError("INVALID_RECEIPT", "Pi permission lifecycle receipt contains unsupported ownership.");
  }
}

function publishExclusive(path, bytes, agentDir) {
  try {
    ensureManagedDirectory(agentDir, dirname(path), "permission config directory");
  } catch (error) {
    throw fsError("WRITE_FAILED", "prepare permission config directory", dirname(path), error);
  }

  const temporaryPath = join(dirname(path), `.${process.pid}.${Date.now()}.permissions.tmp`);
  try {
    writeFileSync(temporaryPath, bytes, { flag: "wx" });
    try {
      linkSync(temporaryPath, path);
      return { created: true };
    } catch (error) {
      if (error?.code === "EEXIST") return { created: false };
      throw fsError("WRITE_FAILED", "publish permission config", path, error);
    }
  } catch (error) {
    if (error instanceof PermissionsLifecycleError) throw error;
    throw fsError("WRITE_FAILED", "write permission config", path, error);
  } finally {
    try {
      unlinkSync(temporaryPath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw fsError("WRITE_FAILED", "remove permission config temporary file", temporaryPath, error);
    }
  }
}

function removeOwnedConfigWithBackup(path, receiptPath, expectedHash, actions, agentDir) {
  let backupRoot;
  try {
    const backups = join(dirname(receiptPath), "permissions-backups");
    ensureManagedDirectory(agentDir, backups, "permission config backup directory");
    backupRoot = mkdtempSync(join(dirname(receiptPath), "permissions-backups", BACKUP_PREFIX));
  } catch (error) {
    throw fsError("REMOVE_FAILED", "prepare permission config backup", dirname(receiptPath), error);
  }
  const backupPath = join(backupRoot, "config.json");
  try {
    renameSync(path, backupPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      actions.push("released:permissions.config");
      return;
    }
    throw fsError("REMOVE_FAILED", "move owned permission config to backup", path, error);
  }

  let backupBytes;
  try {
    backupBytes = readFileSync(backupPath);
  } catch (error) {
    throw fsError("REMOVE_FAILED", "verify permission config backup", backupPath, error);
  }
  if (sha256(backupBytes) !== expectedHash) {
    restoreExclusive(backupPath, path);
    actions.push("released:permissions.config");
    return;
  }
  actions.push("backup:permissions.config", "removed:permissions.config");
}

function restoreExclusive(source, target) {
  try {
    linkSync(source, target);
  } catch (error) {
    if (error?.code !== "EEXIST") throw fsError("RESTORE_FAILED", "restore permission config backup", target, error);
  }
}

function writeReceipt(path, value, agentDir) {
  try {
    ensureManagedDirectory(agentDir, dirname(path), "permission receipt directory");
  } catch (error) {
    throw fsError("WRITE_FAILED", "prepare permission receipt directory", dirname(path), error);
  }
  const temporaryPath = join(dirname(path), `.${process.pid}.${Date.now()}.permissions-receipt.tmp`);
  try {
    writeFileSync(temporaryPath, `${JSON.stringify({
      schemaVersion: 1,
      initialized: value.initialized === true,
      ...(value.owned ? { owned: value.owned } : {}),
    }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    renameSync(temporaryPath, path);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch (cleanupError) {
      if (cleanupError?.code !== "ENOENT") {
        throw fsError("WRITE_FAILED", "clean permission receipt temporary file", temporaryPath, cleanupError);
      }
    }
    throw fsError("WRITE_FAILED", "write permission lifecycle receipt", path, error);
  }
}

function removeReceipt(path) {
  try {
    unlinkSync(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw fsError("REMOVE_FAILED", "remove permission lifecycle receipt", path, error);
  }
  try {
    rmdirSync(dirname(path));
  } catch (error) {
    if (error?.code !== "ENOENT" && error?.code !== "ENOTEMPTY") throw fsError("REMOVE_FAILED", "remove permission receipt directory", dirname(path), error);
  }
}

function fsError(code, operation, path, error) {
  return new PermissionsLifecycleError(code, `Unable to ${operation} ${path} (${error?.code ?? error?.message ?? String(error)}).`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function ensureManagedDirectory(baseDir, target, label, create = true) {
  const base = resolve(baseDir);
  const directory = resolve(target);
  let baseStat;
  try {
    baseStat = lstatSync(base);
  } catch (error) {
    if (error?.code !== "ENOENT") throw fsError("WRITE_FAILED", "inspect", base, error);
    if (!create) return;
    try {
      mkdirSync(base, { recursive: true });
      baseStat = lstatSync(base);
    } catch (mkdirError) {
      throw fsError("WRITE_FAILED", "create", base, mkdirError);
    }
  }
  if (baseStat.isSymbolicLink() || !baseStat.isDirectory()) {
    throw new PermissionsLifecycleError("INVALID_PATH", `${label} contains an unsafe Pi agent directory.`);
  }
  const suffix = relative(base, directory);
  if (suffix === "" || suffix === ".." || suffix.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(suffix)) {
    throw new PermissionsLifecycleError("INVALID_PATH", `${label} must remain below the Pi agent directory.`);
  }
  let current = base;
  for (const segment of suffix.split(/[\\/]/).filter(Boolean)) {
    current = join(current, segment);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (error?.code !== "ENOENT") throw fsError("WRITE_FAILED", "inspect", current, error);
      if (!create) return;
      try {
        mkdirSync(current);
        stat = lstatSync(current);
      } catch (mkdirError) {
        if (mkdirError?.code === "EEXIST") {
          stat = lstatSync(current);
        } else {
          throw fsError("WRITE_FAILED", "create", current, mkdirError);
        }
      }
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new PermissionsLifecycleError("INVALID_PATH", `${label} contains an unsafe path component.`);
    }
  }
}

function permissionConfigIssue(value) {
  if (value.$schema !== undefined && typeof value.$schema !== "string") return "Pi permission config $schema must be a string.";
  for (const key of ["debugLog", "permissionReviewLog", "yoloMode", "doublePressToConfirm"]) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") return `Pi permission config ${key} must be a boolean.`;
  }
  for (const key of ["forwardingTimeoutMs", "promptMaxRows", "promptFieldMaxWidth", "reviewLogFieldMaxWidth", "toolInputPreviewMaxLength", "toolTextSummaryMaxLength"]) {
    if (value[key] !== undefined && (!Number.isInteger(value[key]) || value[key] < 1)) return `Pi permission config ${key} must be a positive integer.`;
  }
  for (const key of ["piInfrastructureReadPaths", "authorizerChain"]) {
    if (value[key] !== undefined && (!Array.isArray(value[key]) || value[key].some((entry) => typeof entry !== "string" || entry.length === 0))) {
      return `Pi permission config ${key} must be a non-empty string array.`;
    }
  }
  if (value.permission !== undefined && !isPermissionValue(value.permission)) return "Pi permission config permission must be a valid policy map.";
  return undefined;
}

function isPermissionValue(value) {
  if (!isRecord(value)) return false;
  return Object.entries(value).every(([, entry]) => {
    if (entry === "allow" || entry === "ask" || entry === "deny") return true;
    if (!isRecord(entry)) return false;
    return Object.values(entry).every((action) => action === "allow" || action === "ask" || action === "deny" || (isRecord(action) && action.action === "deny"));
  });
}
