// Runner native-ownership harness (Spec 71, "Runner: diagnóstico local nativo
// sin falso conflicto legacy").
//
// The real CLI must be executed from the ACTIVE managed package root, so its own
// module-relative root and the readonly ownership checker certify the same
// installation. This fixture extends the shared managed release with the runner's
// real local closure (its bin plus the local extension modules it imports at
// runtime), then rebinds the synthetic release so the package proof still covers
// the enlarged tree. Nothing is fetched, no SDK is copied and no ownership is
// injected: only real bytes already in this repository.
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { rebindManagedRelease, sha256Hex } from "./native-managed-release.mjs";

export const PI_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Trace of the runner's own runtime closure: the bin, the local extension
// modules it imports and the permission defaults asset the lifecycle reads from
// its own package root. Everything is plain JS plus one small JSON asset, so no
// hook, SDK or network is involved; `strip-json-comments` (already present in the
// release closure) covers the rest. The asset is copied byte-identical.
export const RUNNER_FILES = [
  "bin/jorgex-pi.mjs",
  "extensions/permissions-lifecycle.mjs",
  "extensions/context7-config.mjs",
  "extensions/mcp-engram.mjs",
  "assets/permissions/defaults.json",
];

export function installRunnerClosure(sandbox) {
  for (const relativePath of RUNNER_FILES) {
    const target = join(sandbox.packageRoot, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    const source = join(PI_ROOT, relativePath);
    writeFileSync(target, readFileSync(source));
  }
  // The released tree changed, so the synthetic release id, lock hash, tree hash
  // and active entry are recomputed from the mutated bytes. Still synthetic and
  // local: no issuer, signature or registry claim.
  return rebindManagedRelease(sandbox);
}

// Minimal, explicit environment for the subprocess: isolated HOME and agent dir,
// plus a plain PATH and the current Node. No auth variables are inherited.
// `engramBin` points ENGRAM_BIN at the harmless executable the shared fixture
// already writes; the runner only checks presence/executability, it never runs
// it, so no Engram version or HTTP handshake is claimed.
export function runnerEnv(sandbox, { engramBin = false } = {}) {
  const env = {
    HOME: sandbox.home,
    USERPROFILE: sandbox.home,
    PI_CODING_AGENT_DIR: sandbox.agentDir,
    PATH: process.env.PATH ?? "/usr/bin:/bin",
  };
  if (engramBin) env.ENGRAM_BIN = join(sandbox.root, "bin", "engram");
  return env;
}

export function runRunnerCommand(sandbox, args, options = {}) {
  return spawnSync(process.execPath, [join(sandbox.packageRoot, "bin", "jorgex-pi.mjs"), ...args], {
    cwd: sandbox.root,
    env: runnerEnv(sandbox, options),
    encoding: "utf8",
    timeout: 20000,
  });
}

export function readSettings(sandbox) {
  return JSON.parse(readFileSync(join(sandbox.agentDir, "settings.json"), "utf8"));
}

// Digests of the paths Pi sync must never rewrite: the main receipt, the global
// MCP configuration and the granular projection authority. Comparing digests
// keeps failure output free of receipt or configuration content.
export function protectedDigests(sandbox) {
  return [
    sandbox.receiptPath,
    join(sandbox.agentDir, "mcp.json"),
    sandbox.projectionPath,
  ].map((file) => sha256Hex(readFileSync(file)));
}

export function readProjection(sandbox) {
  return JSON.parse(readFileSync(sandbox.projectionPath, "utf8"));
}

export function writeProjection(sandbox, projection) {
  writeFileSync(sandbox.projectionPath, `${JSON.stringify(projection, null, 2)}\n`);
}

// Rewrites the global Pi settings for the official-package policy under test.
// The own registration is always preserved EXACTLY (the checker and the runner
// both require it); `gentle`/`adapter` add the official package DECLARATIONS as
// offline fixture data only. Nothing is installed and no runtime, tool or memory
// claim is made. Settings live outside the release tree, so the lock, tree hash
// and release id stay untouched.
export function writeGlobalSettings(sandbox, { gentle = false, adapter = false } = {}) {
  const packages = [{ source: `npm:jorgex-pi@${sandbox.version}`, skills: [], prompts: [] }];
  if (gentle) packages.push("npm:gentle-engram@0.1.16");
  if (adapter) packages.push("npm:pi-mcp-adapter@3.3.0");
  const settingsPath = join(sandbox.agentDir, "settings.json");
  writeFileSync(settingsPath, `${JSON.stringify({ packages }, null, 2)}\n`);
  return settingsPath;
}

// The official-package policy premise, read from the ACTIVE managed root (never
// the checkout): it is the selector that decides native versus legacy.
export async function officialPackagesPolicy(sandbox) {
  const module = await import(
    pathToFileURL(join(sandbox.packageRoot, "extensions", "context7-config.mjs")).href
  );
  return module.inspectOfficialPackages({ env: sandbox.env, cwd: sandbox.root, platform: process.platform });
}

// Raw global native scan file (`PI_CODING_AGENT_DIR/mcp.json`). Cases that need
// an extra permission, an additional source or a preference change mutate this
// exact file; the protected ownership digest is untouched by preferences.
export function readGlobalMcpConfig(sandbox) {
  return JSON.parse(readFileSync(join(sandbox.agentDir, "mcp.json"), "utf8"));
}

export function writeGlobalMcpConfig(sandbox, config) {
  const configPath = join(sandbox.agentDir, "mcp.json");
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return configPath;
}

// An additional project source (`.pi/mcp.json`) carrying its own entry.
export function writeProjectMcpConfig(sandbox, config) {
  const configPath = join(sandbox.root, ".pi", "mcp.json");
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return configPath;
}

// The existing readonly scan, invoked from the ACTIVE managed root with an
// explicit `nativeContext7` permit. Used as a premise to show which validation
// guards a source; the product acceptance stays the CLI diagnostic.
export async function context7Scan(sandbox, { nativeContext7 = false } = {}) {
  const module = await import(
    pathToFileURL(join(sandbox.packageRoot, "extensions", "context7-config.mjs")).href
  );
  return module.inspectContext7Config({
    env: sandbox.env,
    cwd: sandbox.root,
    platform: process.platform,
    nativeContext7,
  });
}

// Copies a directory tree of real bytes (used only when a closure needs assets).
export function copyTree(source, target) {
  cpSync(source, target, { recursive: true });
}
