// Loader identity fixture: reuses the managed-release sandbox; probe added before rebind, foreign stage never promoted.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createManagedReleaseSandbox, PI_ROOT, rebindManagedRelease } from "./native-managed-release.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

export const PROBE_FILE_NAME = "native-jiti-identity-probe.mjs";
const PROBE_SOURCE_PATH = join(HERE, PROBE_FILE_NAME);
// The real producer closure the release fixture also copies, plus the one
// package the closure imports at runtime (`strip-json-comments`).
const CLOSURE_FILES = ["native-mcp.mjs", "context7-config.mjs", "mcp-engram.mjs"];
const STAGE_DEPENDENCY = "strip-json-comments";

export function prepareJitiIdentityFixture(t) {
  const sandbox = createManagedReleaseSandbox(t);

  // (1) Probe inside the release, before the release tree hash is recomputed.
  const probeBytes = readFileSync(PROBE_SOURCE_PATH);
  writeFileSync(join(sandbox.packageRoot, "extensions", PROBE_FILE_NAME), probeBytes);
  rebindManagedRelease(sandbox);
  const activeProbePath = join(sandbox.linkPath, "extensions", PROBE_FILE_NAME);

  // (2) Foreign stage root: a different physical package root with the same
  // closure. Laid out as an npm package so the relative imports resolve.
  const stageNodeModules = join(sandbox.root, "foreign-stage", "node_modules");
  const stagePackageRoot = join(stageNodeModules, "jorgex-pi");
  const stageExtensions = join(stagePackageRoot, "extensions");
  mkdirSync(stageExtensions, { recursive: true });
  for (const file of CLOSURE_FILES) {
    copyFileSync(join(PI_ROOT, "extensions", file), join(stageExtensions, file));
  }
  copyFileSync(PROBE_SOURCE_PATH, join(stageExtensions, PROBE_FILE_NAME));
  copyFileSync(join(PI_ROOT, "package.json"), join(stagePackageRoot, "package.json"));
  const stageDependency = join(stageNodeModules, STAGE_DEPENDENCY);
  mkdirSync(stageDependency, { recursive: true });
  copyFileSync(
    join(PI_ROOT, "node_modules", STAGE_DEPENDENCY, "index.js"),
    join(stageDependency, "index.js"),
  );
  copyFileSync(
    join(PI_ROOT, "node_modules", STAGE_DEPENDENCY, "package.json"),
    join(stageDependency, "package.json"),
  );

  return {
    sandbox,
    activeProbePath,
    stageProbePath: join(stageExtensions, PROBE_FILE_NAME),
    stagePackageRoot,
  };
}
