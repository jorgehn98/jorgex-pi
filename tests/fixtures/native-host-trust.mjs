// T73 real-host project-trust fixture wrapper (test artifact, never production).
//
// It reuses the shared synthetic managed-release fixture READ-ONLY and only adds
// two artifacts this tracer needs, inside the owned temporary tree the shared
// fixture already tears down on success, failure and cancellation:
//
//   1. the host-trust probe extension INSIDE the release `extensions` directory.
//      It is written before the release tree hash is taken and the shared
//      fixture's own `rebindManagedRelease` then recomputes the raw lock/tree
//      hashes, the release id and the active symlink, so the managed release
//      stays self-consistent.
//
//   2. a project source `<cwd>/.pi/mcp.json` that overrides the protected
//      `context7` server with a distinct, non-sensitive URL. It is inert while
//      the project is untrusted and effective (and therefore unverifiable) once
//      the real host trust resolves the project as trusted.
//
// Nothing is downloaded, executed, signed or authenticated here, and no shared
// fixture is edited.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createManagedReleaseSandbox, rebindManagedRelease } from "./native-managed-release.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

export const HOST_TRUST_PROBE_FILE_NAME = "native-host-trust-probe.mjs";
export const HOST_TRUST_PROJECT_OVERRIDE_URL = "https://example.invalid/host-trust";
const PROBE_SOURCE_PATH = join(HERE, HOST_TRUST_PROBE_FILE_NAME);

export function prepareHostTrustFixture(t) {
  const sandbox = createManagedReleaseSandbox(t);

  // (1) Probe inside the release, before the release tree hash is recomputed.
  writeFileSync(
    join(sandbox.packageRoot, "extensions", HOST_TRUST_PROBE_FILE_NAME),
    readFileSync(PROBE_SOURCE_PATH),
  );
  rebindManagedRelease(sandbox);

  // (2) Project source overriding the protected context7 server.
  const projectConfigPath = join(sandbox.root, ".pi", "mcp.json");
  mkdirSync(dirname(projectConfigPath), { recursive: true });
  writeFileSync(
    projectConfigPath,
    `${JSON.stringify({ mcpServers: { context7: { url: HOST_TRUST_PROJECT_OVERRIDE_URL } } }, null, 2)}\n`,
  );

  return {
    sandbox,
    activeProbePath: join(sandbox.linkPath, "extensions", HOST_TRUST_PROBE_FILE_NAME),
    projectConfigPath,
  };
}
