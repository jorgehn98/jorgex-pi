// Shared owned permission sandbox for the direct and SDK nested native MCP
// permission tests (test artifact, never production).
//
// The two callers used to carry byte-identical `createSandbox`/`allowedHostEnv`
// bodies; this module is the single copy. The executable bodies are moved
// verbatim (only the exported name `createNativePermissionSandbox` differs), and
// callers import it aliased as `createSandbox` so their call sites are unchanged.
//
// The owned temporary tree registers its runner-hook teardown immediately after
// the owned `mkdtemp` and before any other IO, so a failure while the fixture is
// being built still cleans up on success, failure and cancellation. The host
// environment whitelist is intentionally narrow: PATH/PATHEXT/SYSTEMROOT/
// SystemRoot/COMSPEC/ComSpec/WINDIR/windir only.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function createNativePermissionSandbox(t, label) {
  const rootDir = mkdtempSync(join(tmpdir(), `jorgex-pi-${label}-`));
  // Owned temporary tree: register the runner-hook teardown immediately after
  // the owned mkdtemp and before any other IO, so a failure while the fixture is
  // being built still cleans up on success, failure and cancellation.
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const agentDir = join(rootDir, "agent");
  const home = join(rootDir, "home");
  const cwd = join(rootDir, "workspace");
  for (const path of [agentDir, home, cwd, join(rootDir, "xdg-config"), join(rootDir, "xdg-cache"), join(rootDir, "xdg-data")]) {
    mkdirSync(path, { recursive: true });
  }
  return {
    root: rootDir,
    agentDir,
    cwd,
    env: {
      ...allowedHostEnv(),
      HOME: home,
      USERPROFILE: home,
      PI_CODING_AGENT_DIR: agentDir,
      XDG_CONFIG_HOME: join(rootDir, "xdg-config"),
      XDG_CACHE_HOME: join(rootDir, "xdg-cache"),
      XDG_DATA_HOME: join(rootDir, "xdg-data"),
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
      NO_COLOR: "1",
    },
  };
}

export function allowedHostEnv() {
  const result = {};
  for (const key of ["PATH", "PATHEXT", "SYSTEMROOT", "SystemRoot", "COMSPEC", "ComSpec", "WINDIR", "windir"]) {
    if (process.env[key] !== undefined) result[key] = process.env[key];
  }
  return result;
}
