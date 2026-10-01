// Host-trust fixture: reuses the managed-release sandbox; probe added before rebind, project override inert unless trusted.
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
