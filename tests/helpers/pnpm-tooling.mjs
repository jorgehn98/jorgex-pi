import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Test-side selection of the exact prepared pnpm for Pi packaging.
 *
 * Pi's packaging callers must never let an unverified pnpm switch versions or
 * acquire packages on its own. This helper resolves an absolute prepared
 * entrypoint, trusts only its package metadata (`name`, version and declared
 * `bin.pnpm`), confirms the real version through a bounded runner, and refuses
 * to continue on missing/incorrect tools without any Corepack or PATH fallback.
 * It also pins the pnpm 11 fail-closed guards on every child so a verified
 * 11.22.0 child refuses with `error` instead of running an implicit
 * `install` (dependency verification) or a version download
 * during preflight or pack, and it keeps every private HOME/XDG/stage on
 * checked disk storage outside workspaces, worktrees and node_modules.
 *
 * The RPC teardown lives in its own test (`pi-sdk-compatibility.test.mjs`);
 * this helper must not grow a second general-purpose process API.
 */

export const PREPARED_PNPM_ENTRY_ENV = "JORGEX_PNPM_ENTRYPOINT";
export const VERIFICATION_DISK_ROOT_ENV = "JORGEX_VERIFICATION_DISK_ROOT";

/**
 * pnpm 11 fail-closed guards (verified in the prepared 11.22.0 dist API):
 * - `pm-on-fail` accepts `error`, read from `pnpm_config_pm_on_fail`, so the
 *   `packageManager` version check refuses instead of downloading a manager.
 *   `npm_config_manage_package_manager_versions` is a pnpm 9/10-era key and
 *   does not gate version switching in pnpm 11.
 * - `verify-deps-before-run` defaults to `install`; the same dist reads
 *   `pnpm_config_verify_deps_before_run` and handles the `error` branch, so
 *   `error` refuses instead of recreating `node_modules` before run/exec.
 */
export const PNPM_PM_ON_FAIL_ENV = "pnpm_config_pm_on_fail";
export const PNPM_VERIFY_DEPS_ENV = "pnpm_config_verify_deps_before_run";
/** Value that makes both pnpm 11 guards fail closed instead of acquiring. */
export const PNPM_FAIL_CLOSED = "error";

export const TREE_KILL_TIMEOUT_MS = 5_000;
export const KILL_GRACE_MS = 2_000;

const TMPFS_MAGIC = 0x01021994;
const RAMFS_MAGIC = 0x858458f6;
const ownedRoots = new Set();
const activeChildren = new Set();
let exitHookInstalled = false;

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function trackRoot(root) {
  ownedRoots.add(root);
  installExitHook();
}

function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    let processesClean = true;
    try {
      cleanupOwnedProcesses();
    } catch (error) {
      processesClean = false;
      // Never swallow: report and keep the failed entries tracked for retry.
      process.stderr.write(`[pnpm-tooling] limpieza de procesos incompleta: ${errorMessage(error)}\n`);
    }
    if (!processesClean) {
      // A live owned process may still be writing inside its root, so the
      // roots are retained instead of being deleted underneath it.
      process.stderr.write("[pnpm-tooling] roots retenidos porque hay procesos propios sin finalizar\n");
      return;
    }
    try {
      cleanupOwnedRoots();
    } catch (error) {
      process.stderr.write(`[pnpm-tooling] limpieza de roots incompleta: ${errorMessage(error)}\n`);
    }
  });
}

/**
 * Removes every owned root. Failed removals are reported and stay tracked
 * instead of being discarded.
 */
export function cleanupOwnedRoots() {
  const remaining = [];
  for (const root of [...ownedRoots]) {
    let failure;
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch (error) {
      failure = error;
    }
    if (failure !== undefined || fs.existsSync(root)) {
      remaining.push(`${root}${failure === undefined ? "" : ` (${errorMessage(failure)})`}`);
      continue;
    }
    ownedRoots.delete(root);
  }
  if (remaining.length > 0) {
    throw new Error(`No se pudieron limpiar los roots de verificación propios: ${remaining.join(", ")}`);
  }
}

/** Finalizes every bounded child still owned. Failures stay tracked and reported. */
export function cleanupOwnedProcesses() {
  const remaining = [];
  for (const child of [...activeChildren]) {
    const kill = killProcessTree(child);
    if (kill.killed) {
      activeChildren.delete(child);
      continue;
    }
    remaining.push(`pid ${kill.pid ?? "desconocido"} (${errorMessage(kill.error)})`);
  }
  if (remaining.length > 0) {
    throw new Error(`No se pudieron finalizar los procesos propios: ${remaining.join(", ")}`);
  }
}

function realpathOrSelf(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

export function readRequiredPnpmVersion(packageJsonPath) {
  let raw;
  try {
    raw = fs.readFileSync(packageJsonPath, "utf8");
  } catch (error) {
    throw new Error(
      `No se pudo leer ${packageJsonPath} para conocer la versión de pnpm exigida: ${errorMessage(error)}`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`package.json inválido en ${packageJsonPath}: ${errorMessage(error)}`);
  }

  const packageManager = parsed?.packageManager;
  if (typeof packageManager !== "string" || packageManager.trim() === "") {
    throw new Error(
      `${packageJsonPath} no declara packageManager; se exige una versión exacta de pnpm para verificar.`,
    );
  }

  const match = /^pnpm@(\d+\.\d+\.\d+)$/.exec(packageManager.trim());
  if (match === null || match[1] === undefined) {
    throw new Error(
      `packageManager debe fijar una versión exacta de pnpm (pnpm@X.Y.Z); se encontró "${packageManager.trim()}".`,
    );
  }
  return match[1];
}

function findPackageJson(startDir) {
  let current = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(current, "package.json");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * Locates the pnpm package metadata that owns `entry`, resolving symlinks
 * before walking up to the declaring `package.json`. Absence or valid-but-
 * incompatible metadata returns `undefined`; an unreadable or malformed
 * manifest fails closed with its unexpected cause preserved.
 */
export function readPnpmPackageMetadata(entry) {
  let resolvedEntry;
  try {
    resolvedEntry = fs.realpathSync(entry);
  } catch {
    return undefined;
  }

  const packageJsonPath = findPackageJson(path.dirname(resolvedEntry));
  if (packageJsonPath === undefined) return undefined;

  let raw;
  try {
    raw = fs.readFileSync(packageJsonPath, "utf8");
  } catch (error) {
    throw new Error(`No se pudo leer la metadata de pnpm en "${packageJsonPath}": ${errorMessage(error)}`, {
      cause: error,
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`package.json de pnpm ilegible en "${packageJsonPath}": ${errorMessage(error)}`, {
      cause: error,
    });
  }

  const record = parsed;
  if (record?.name !== "pnpm" || typeof record.version !== "string" || record.version === "") {
    return undefined;
  }

  const binField = typeof record.bin === "string" ? record.bin : record.bin?.["pnpm"];
  if (typeof binField !== "string" || binField === "") return undefined;

  return {
    packageRoot: path.dirname(packageJsonPath),
    version: record.version,
    binPath: path.resolve(path.dirname(packageJsonPath), binField),
  };
}

/** Resolves an absolute, existing prepared entrypoint without Corepack or PATH. */
export function resolvePreparedEntry(env) {
  const override = typeof env?.[PREPARED_PNPM_ENTRY_ENV] === "string" ? env[PREPARED_PNPM_ENTRY_ENV].trim() : "";
  const execPath = typeof env?.npm_execpath === "string" ? env.npm_execpath.trim() : "";
  const entry = override !== "" ? override : execPath;
  const origin = override !== "" ? PREPARED_PNPM_ENTRY_ENV : "npm_execpath";

  if (entry === "") {
    throw new Error(
      `No hay un pnpm preparado: define ${PREPARED_PNPM_ENTRY_ENV} con la ruta absoluta a su binario preparado o ejecuta la verificación desde pnpm. No se usa Corepack ni PATH.`,
    );
  }
  if (!path.isAbsolute(entry)) {
    throw new Error(`El pnpm preparado indicado por ${origin} debe ser una ruta absoluta: "${entry}".`);
  }
  if (!fs.existsSync(entry) || !fs.statSync(entry).isFile()) {
    throw new Error(`El pnpm preparado indicado por ${origin} no existe como archivo: "${entry}".`);
  }
  return entry;
}

/**
 * Validates a filesystem probe. RAM/ramfs and unknown or zero types fail
 * closed: no code path may assume disk when the probe errors or is unknown.
 */
export function assertDiskBackedFilesystem({ target, fsType }) {
  if (fsType === undefined || fsType === null || fsType === 0) {
    throw new Error(
      `No se pudo comprobar el filesystem de "${target}"; se exige un resultado en disco verificable y no se asume disco ante un valor desconocido.`,
    );
  }
  if (fsType === TMPFS_MAGIC || fsType === RAMFS_MAGIC) {
    throw new Error(
      `La base de disco de verificación "${target}" está en un filesystem temporal en RAM; define ${VERIFICATION_DISK_ROOT_ENV} en disco.`,
    );
  }
  return fsType;
}

function probeDiskFilesystem(target) {
  let fsType;
  try {
    fsType = fs.statfsSync(target).type;
  } catch (error) {
    throw new Error(`No se pudo comprobar el filesystem de "${target}": ${errorMessage(error)}`);
  }
  return assertDiskBackedFilesystem({ target, fsType });
}

function isInsideWorkspace(base, repoRoot) {
  const relative = path.relative(realpathOrSelf(repoRoot), base);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return true;

  let current = base;
  for (;;) {
    if (fs.existsSync(path.join(current, "pnpm-workspace.yaml"))) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function validateDiskBase({ base, repoRoot, origin }) {
  if (!path.isAbsolute(base)) {
    throw new Error(`La base de disco de verificación indicada por ${origin} debe ser absoluta: "${base}".`);
  }
  if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) {
    throw new Error(`La base de disco de verificación indicada por ${origin} no es un directorio existente: "${base}".`);
  }

  const resolved = realpathOrSelf(base);
  if (isInsideWorkspace(resolved, repoRoot)) {
    throw new Error(
      `La base de disco de verificación "${resolved}" está dentro de un workspace; define ${VERIFICATION_DISK_ROOT_ENV} fuera de todo workspace.`,
    );
  }

  const segments = resolved.split(path.sep);
  if (segments.includes("node_modules") || segments.includes("worktrees")) {
    throw new Error(
      `La base de disco de verificación "${resolved}" pasa por node_modules/worktrees; define ${VERIFICATION_DISK_ROOT_ENV} fuera de esas rutas.`,
    );
  }

  probeDiskFilesystem(resolved);
  return resolved;
}

/**
 * Resolves a disk base for private verification roots. It never creates a base:
 * it only accepts an explicit override or an existing disk-backed directory
 * (`os.tmpdir()` when it is real disk, the user cache, or the user HOME), and
 * rejects workspaces, node_modules/worktrees segments, RAM filesystems and
 * unverifiable probes.
 */
export function resolveVerificationDiskBase({ repoRoot, env }) {
  const rawOverride = env?.[VERIFICATION_DISK_ROOT_ENV];
  const override = typeof rawOverride === "string" ? rawOverride.trim() : "";
  if (override !== "") {
    return validateDiskBase({ base: override, repoRoot, origin: VERIFICATION_DISK_ROOT_ENV });
  }

  const candidates = [
    { base: os.tmpdir(), origin: "os.tmpdir()" },
    { base: path.join(os.homedir(), ".cache"), origin: "el cache del HOME" },
    { base: os.homedir(), origin: "el HOME del usuario" },
  ];
  const failures = [];
  for (const candidate of candidates) {
    try {
      return validateDiskBase({ base: candidate.base, repoRoot, origin: candidate.origin });
    } catch (error) {
      failures.push(`${candidate.origin}: ${errorMessage(error)}`);
    }
  }
  throw new Error(
    `No hay una base de disco verificable para la verificación; define ${VERIFICATION_DISK_ROOT_ENV} en disco. Intentos: ${failures.join(" | ")}`,
  );
}

/**
 * Creates a private HOME/stage under a checked disk base. Teardown is armed
 * through `register` (and the module-level exit hook) before the directory
 * exists. A failed creation keeps the root tracked and, when its cleanup also
 * fails, reports both causes as an AggregateError.
 */
export function createVerificationSandbox({ repoRoot, env, prefix, register }) {
  const base = resolveVerificationDiskBase({ repoRoot, env });
  const root = path.join(base, `${prefix}${process.pid}-${randomUUID().slice(0, 8)}`);
  register?.(root);
  trackRoot(root);

  try {
    const dirs = {
      home: path.join(root, "home"),
      userProfile: path.join(root, "user-profile"),
      appData: path.join(root, "app-data"),
      localAppData: path.join(root, "local-app-data"),
      temp: path.join(root, "temp"),
      tmp: path.join(root, "tmp"),
      tmpdir: path.join(root, "tmpdir"),
      xdgConfig: path.join(root, "xdg-config"),
      xdgCache: path.join(root, "xdg-cache"),
      xdgData: path.join(root, "xdg-data"),
      pack: path.join(root, "pack"),
    };
    for (const directory of Object.values(dirs)) fs.mkdirSync(directory, { recursive: true });
    return {
      root,
      dirs,
      packDir: dirs.pack,
      env: {
        HOME: dirs.home,
        USERPROFILE: dirs.userProfile,
        APPDATA: dirs.appData,
        LOCALAPPDATA: dirs.localAppData,
        TEMP: dirs.temp,
        TMP: dirs.tmp,
        TMPDIR: dirs.tmpdir,
        XDG_CONFIG_HOME: dirs.xdgConfig,
        XDG_CACHE_HOME: dirs.xdgCache,
        XDG_DATA_HOME: dirs.xdgData,
      },
    };
  } catch (error) {
    let cleanupFailure;
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 2, retryDelay: 25 });
    } catch (rmError) {
      cleanupFailure = rmError;
    }
    const message = `No se pudo crear el HOME privado de verificación en "${root}": ${errorMessage(error)}`;
    if (cleanupFailure !== undefined) {
      throw new AggregateError(
        [error, cleanupFailure],
        `${message}; además falló su limpieza (root pendiente "${root}"): ${errorMessage(cleanupFailure)}`,
      );
    }
    throw new Error(message);
  }
}

/** Trusts no version output from an unverifiable tree: `cleanupError` fails closed first. */
function observedPnpmVersion(result) {
  if (result.cleanupError !== undefined) throw result.cleanupError;
  if (result.error !== undefined) {
    throw new Error(`No se pudo ejecutar el pnpm preparado: ${result.error.message}`);
  }
  if (result.timedOut) {
    throw new Error("El pnpm preparado no respondió a --version dentro del límite acotado (timed out).");
  }
  if (result.status !== 0) {
    throw new Error(
      `El pnpm preparado falló al comprobar --version (status ${result.status ?? "null"}): ${result.stderr.trim()}`,
    );
  }
  const output = result.stdout.trim();
  const match = /^(\d+\.\d+\.\d+)$/.exec(output);
  if (match === null || match[1] === undefined) {
    throw new Error(`Salida de pnpm --version no exacta (se esperaba solo la versión): "${output}".`);
  }
  return match[1];
}

/**
 * Resolves the exact prepared pnpm and returns the bounded `pnpm pack`
 * base invocation (`[binPath]`). Throws before creating any process when the
 * tool is missing, unknown or does not match the required version.
 */
export async function resolvePnpmPackInvocation(options) {
  const runProcess = options.runProcess;
  const requiredVersion = readRequiredPnpmVersion(path.join(options.repoRoot, "package.json"));
  const entry = resolvePreparedEntry(options.env);
  const metadata = readPnpmPackageMetadata(entry);

  if (metadata === undefined) {
    throw new Error(
      `El pnpm preparado "${entry}" no declara el paquete pnpm (name "pnpm" con bin.pnpm); no se usa Corepack ni PATH.`,
    );
  }
  if (metadata.version !== requiredVersion) {
    throw new Error(
      `El pnpm preparado "${entry}" es ${metadata.version}, pero el repositorio exige pnpm@${requiredVersion}. Instala o selecciona la versión exacta; no se permite instalación ni cambio automático.`,
    );
  }
  if (!fs.existsSync(metadata.binPath) || !fs.statSync(metadata.binPath).isFile()) {
    throw new Error(
      `El pnpm preparado "${entry}" declara bin.pnpm "${metadata.binPath}", que no existe como archivo.`,
    );
  }

  const env = {
    ...options.env,
    [PNPM_PM_ON_FAIL_ENV]: PNPM_FAIL_CLOSED,
    [PNPM_VERIFY_DEPS_ENV]: PNPM_FAIL_CLOSED,
  };
  const result = await runProcess(
    { command: process.execPath, args: [metadata.binPath, "--version"] },
    { cwd: options.repoRoot, env, timeoutMs: options.versionCheckTimeoutMs },
  );

  const observed = observedPnpmVersion(result);
  if (observed !== requiredVersion) {
    throw new Error(
      `El pnpm preparado "${entry}" informó ${observed}, pero el repositorio exige pnpm@${requiredVersion}. No se permite instalación ni cambio automático.`,
    );
  }

  return { command: process.execPath, args: [metadata.binPath], env };
}

/**
 * Real caller wiring: resolves the exact prepared pnpm before altering the
 * environment, then creates a private disk-backed HOME/XDG stage and overlays
 * it while preserving the pnpm fail-closed guards.
 */
export async function preparePnpmPackRun(options) {
  const resolved = await resolvePnpmPackInvocation({
    repoRoot: options.repoRoot,
    env: options.env,
    runProcess: options.runProcess,
    versionCheckTimeoutMs: options.versionCheckTimeoutMs,
  });

  const owned = createVerificationSandbox({
    repoRoot: options.repoRoot,
    env: options.env,
    prefix: ".jorgex-pi-pack-home-",
    register: options.registerRoot,
  });

  return {
    invocation: {
      command: resolved.command,
      args: [...resolved.args, "pack", "--pack-destination", owned.packDir],
    },
    env: { ...resolved.env, ...owned.env },
    root: owned.root,
    packDir: owned.packDir,
    home: owned.env.HOME,
  };
}

/**
 * Resolves the exact prepared pnpm, creates an isolated disk HOME/XDG and runs
 * a bounded `pnpm pack`, returning the single produced tarball. The caller's
 * registered root (or the module exit hook) removes the owned tree.
 */
export async function packProjectTarball(options) {
  const runner = options.runProcess ?? runBoundedProcess;
  const prepared = await preparePnpmPackRun({
    repoRoot: options.repoRoot,
    env: options.env,
    runProcess: runner,
    versionCheckTimeoutMs: options.versionCheckTimeoutMs,
    registerRoot: options.registerRoot,
  });

  const result = await runner(prepared.invocation, {
    cwd: options.repoRoot,
    env: prepared.env,
    timeoutMs: options.timeoutMs,
  });

  if (result.cleanupError !== undefined) throw result.cleanupError;
  if (result.error !== undefined) throw result.error;
  if (result.timedOut) {
    throw new Error("El pack acotado de pnpm superó el tiempo límite (timed out).");
  }
  if (result.status !== 0) {
    throw new Error(`pnpm pack falló (status ${result.status ?? "null"}): ${result.stderr.trim()}`);
  }

  const tarballs = fs.readdirSync(prepared.packDir).filter((name) => name.endsWith(".tgz"));
  if (tarballs.length !== 1) {
    throw new Error(`pnpm pack debía producir exactamente un tarball; produjo ${tarballs.length}.`);
  }

  return {
    tarball: path.join(prepared.packDir, tarballs[0]),
    packDir: prepared.packDir,
    root: prepared.root,
    home: prepared.home,
    stdout: result.stdout,
    stderr: result.stderr,
    env: prepared.env,
  };
}

/**
 * Kills the owned process tree. On POSIX it only signals the owned group and
 * never falls back to `child.kill` pretending the whole tree is clean; a
 * failure is returned with the pid and cause. Windows uses a bounded
 * `taskkill /t /f` by pid (TREE_KILL_TIMEOUT_MS).
 */
export function killProcessTree(child) {
  const pid = child.pid;
  if (pid === undefined) return { killed: false, pid: undefined, noProcess: true };

  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
    const taskkill = path.join(systemRoot, "System32", "taskkill.exe");
    try {
      const result = spawnSync(taskkill, ["/pid", String(pid), "/t", "/f"], {
        shell: false,
        stdio: "ignore",
        timeout: TREE_KILL_TIMEOUT_MS,
        windowsHide: true,
      });
      if (result.error === undefined && result.status === 0) return { killed: true, pid };
      return {
        killed: false,
        pid,
        error: result.error ?? new Error(`taskkill salió con status ${result.status}`),
      };
    } catch (error) {
      return { killed: false, pid, error };
    }
  }

  try {
    process.kill(-pid, "SIGKILL");
    return { killed: true, pid };
  } catch (error) {
    if (error?.code === "ESRCH") return { killed: true, pid };
    return { killed: false, pid, error };
  }
}

/**
 * Finalizes the owned tree through the injected killer on every platform. A
 * Windows timeout with a live leader runs bounded `taskkill /t /f`; a Windows normal
 * close whose leader already exited cannot verify the tree, so it returns an
 * explicit cleanup error instead of pretending the tree is clean. The child
 * stays tracked whenever the kill fails.
 */
function finalizeOwnedGroup(child, killTree) {
  const kill = killTree(child);
  if (kill.pid === undefined) {
    // Spawn never produced a real process; there is nothing to track or report.
    activeChildren.delete(child);
    return undefined;
  }
  if (kill.killed) {
    activeChildren.delete(child);
    return undefined;
  }
  return kill.error ?? new Error(`no se pudo finalizar el grupo del proceso acotado (pid ${kill.pid})`);
}

function settleChild(child, onFinalized) {
  if (child.stdout) {
    child.stdout.removeAllListeners("data");
    child.stdout.destroy();
  }
  if (child.stderr) {
    child.stderr.removeAllListeners("data");
    child.stderr.destroy();
  }
  child.removeAllListeners("close");
  child.removeAllListeners("error");
  child.on("error", onFinalized);
  child.unref();
}

/**
 * Bounded process runner used for preflight and pack. It finalizes the owned
 * group/tree through the injected killer on every platform both on timeout
 * (live leader: POSIX group kill, Windows bounded `taskkill /t /f`) and on a
 * normal close; a dead Windows leader that already exited cannot be verified,
 * so that path returns an explicit cleanup error. A kill failure is
 * exposed as `cleanupError` and the child stays tracked instead of pretending
 * the tree is clean.
 */
export function runBoundedProcess(invocation, options) {
  return new Promise((resolvePromise, reject) => {
    let child;
    try {
      child = spawn(invocation.command, invocation.args, {
        cwd: options.cwd,
        detached: process.platform !== "win32",
        env: options.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }
    const killTree = options.killTree ?? killProcessTree;
    if (child.pid !== undefined) activeChildren.add(child);

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let spawnError;
    let cleanupError;
    let timeoutTimer;
    let graceTimer;

    const onStdout = (chunk) => { stdout += chunk.toString(); };
    const onStderr = (chunk) => { stderr += chunk.toString(); };
    const onError = (error) => {
      spawnError ??= error;
      // A spawn that never produced a pid cannot emit a usable close; settle
      // here so the caller gets the error instead of hanging.
      if (child.pid === undefined) settle({ status: null, signal: null, stdout, stderr });
    };

    const settle = (result) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      settleChild(child, onError);
      resolvePromise({
        ...result,
        timedOut,
        ...(spawnError === undefined ? {} : { error: spawnError }),
        ...(cleanupError === undefined ? {} : { cleanupError }),
      });
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.on("error", onError);
    child.once("close", (status, signal) => {
      cleanupError ??= finalizeOwnedGroup(child, killTree);
      settle({ status, signal, stdout, stderr });
    });

    const onTimeout = () => {
      if (settled) return;
      timedOut = true;
      cleanupError ??= finalizeOwnedGroup(child, killTree);
      graceTimer = setTimeout(() => {
        if (settled) return;
        cleanupError ??= finalizeOwnedGroup(child, killTree);
        settle({ status: null, signal: "SIGKILL", stdout, stderr });
      }, KILL_GRACE_MS);
    };

    timeoutTimer = setTimeout(onTimeout, options.timeoutMs);
  });
}
