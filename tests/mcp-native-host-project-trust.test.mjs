// T73 real HOST TRUST seam for the native MCP project override.
//
// Testing decision
//   Risk: the bootstrap's native project-override gate claims to read the REAL
//   `ctx.isProjectTrusted()`, but the existing coverage only proves the pure
//   readonly checker with a fixture boolean passed straight into
//   `inspectNativeMcpOwnership` (`mcp-native-effective-project-ownership-red`)
//   and an injected fake context (`mcp-native-guide-integration-red`). Neither
//   shows that the public host session produces that boolean from its real trust
//   state, so a regression in the plumbing (a forced value, a stale or duplicated
//   trust source, or a settings manager the session ignores) could pass every
//   existing test while the guide gate would be wrong in production.
//   Existing protection: `mcp-native-effective-project-ownership-red.test.mjs`
//   (conflict/managed for an explicit `projectTrusted` boolean) and
//   `mcp-native-guide-integration-red.test.mjs` (guide policy against an injected
//   context). Both feed the trust value themselves.
//   New behavior: with a real public `AgentSession` (real `DefaultResourceLoader`,
//   real `ProjectTrustStore` and real `SettingsManager`), `ctx.isProjectTrusted()`
//   is the host's own decision, and the real exported checker flips from
//   `conflict` (a trusted project override of the protected context7 server) to
//   `managed` (untrusted, so the same override is inert) accordingly.
//   Seam: a real SDK session in an isolated child process whose probe extension is
//   loaded BY PATH from the ACTIVE managed symlink; the only scripted input is the
//   trust decision persisted through the public `ProjectTrustStore`.
//
// SDK resolution: JORGEX_PI_NATIVE_SDK_ROOT when provided (invalid => fail
// closed, never skip). Without it the case is skipped: the legacy repo SDK does
// not expose the native trust/loader surface, and a false GREEN from an unrelated
// build would be worse than no evidence.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { snapshotTree } from "./fixtures/native-managed-release.mjs";
import { prepareHostTrustFixture } from "./fixtures/native-host-trust.mjs";

const testDir = fileURLToPath(new URL(".", import.meta.url));
const CHANNEL = "jorgex-pi:native-host-trust";
const requestedSdkRoot = process.env.JORGEX_PI_NATIVE_SDK_ROOT?.trim() || undefined;

test(
  "the real host session trust drives the native project override to conflict or managed",
  { skip: resolveNativeSdkSkip() },
  async (t) => {
    if (requestedSdkRoot && !existsSync(join(requestedSdkRoot, "dist", "index.js"))) {
      assert.fail(`JORGEX_PI_NATIVE_SDK_ROOT=${requestedSdkRoot} has no dist/index.js`);
    }

    await t.test("a trusted project makes the protected override effective as conflict", () => {
      const { sandbox, activeProbePath, projectConfigPath } = prepareHostTrustFixture(t);
      const before = snapshotReadonly(sandbox, projectConfigPath);

      const output = runHostTrustFixture(sandbox, activeProbePath, true);

      assert.equal(output.storedTrust, true, "the public trust store must persist the trusted decision");
      assert.equal(output.effectiveTrust, true, "the real loader/host must apply the stored trust to the settings manager");
      assert.equal(output.extensionCount, 1, "the real loader must load exactly the probe extension");
      assert.equal(output.probe?.ok, true, `the probe must not fail: ${output.probe?.error ?? "no diagnostic"}`);
      assert.equal(output.probe.projectTrusted, true, "ctx.isProjectTrusted() must be the host's real trusted decision");
      assert.equal(output.probe.cwd, sandbox.root, "the probe must observe the real session cwd");
      assert.equal(
        output.probe.result?.package?.state,
        "verified",
        `the managed package proof must stay verified: ${output.probe.result?.package?.reason ?? "no diagnostic"}`,
      );
      assert.equal(
        output.probe.result?.servers?.context7?.state,
        "conflict",
        `a trusted project override must be effective and conflict with the managed claim: ${output.probe.result?.servers?.context7?.reason ?? "no diagnostic"}`,
      );
      assert.equal(
        output.probe.result?.servers?.context7?.cleanupEligible,
        false,
        "the global managed claim must not own the trusted project replacement",
      );
      assert.equal(output.probe.result?.connection, "not-verified", "the checker never claims a live connection");
      assert.deepEqual(snapshotReadonly(sandbox, projectConfigPath), before, "the trust read must not write configuration or receipts");
    });

    await t.test("the same project stays managed when the host does not trust it", () => {
      const { sandbox, activeProbePath, projectConfigPath } = prepareHostTrustFixture(t);
      const before = snapshotReadonly(sandbox, projectConfigPath);

      const output = runHostTrustFixture(sandbox, activeProbePath, false);

      assert.equal(output.storedTrust, false, "the public trust store must persist the untrusted decision");
      assert.equal(output.effectiveTrust, false, "the real loader/host must apply the stored trust to the settings manager");
      assert.equal(output.extensionCount, 1, "the real loader must load exactly the probe extension");
      assert.equal(output.probe?.ok, true, `the probe must not fail: ${output.probe?.error ?? "no diagnostic"}`);
      assert.equal(output.probe.projectTrusted, false, "ctx.isProjectTrusted() must be the host's real untrusted decision");
      assert.equal(output.probe.cwd, sandbox.root, "the probe must observe the real session cwd");
      assert.equal(
        output.probe.result?.servers?.context7?.state,
        "managed",
        `an untrusted project override must be inert and leave the global claim managed: ${output.probe.result?.servers?.context7?.reason ?? "no diagnostic"}`,
      );
      assert.equal(output.probe.result?.servers?.context7?.cleanupEligible, true, "the global managed baseline stays cleanup-eligible");
      assert.equal(output.probe.result?.servers?.context7?.availability, "configured", "availability is syntax only, never a connection claim");
      assert.deepEqual(snapshotReadonly(sandbox, projectConfigPath), before, "the trust read must not write configuration or receipts");
    });
  },
);

// The explicit root is a mandatory requirement: an invalid one fails, and only
// an absent native lane skips.
function resolveNativeSdkSkip() {
  if (requestedSdkRoot) return false;
  return "no native lane supplied; set JORGEX_PI_NATIVE_SDK_ROOT to a build exposing ProjectTrustStore/DefaultResourceLoader/createAgentSession";
}

// Read-only snapshot of the files the trust/override inspection must never
// change. `agent/trust.json` is intentionally excluded: the fixture persists the
// decision through the public store before the run, which is setup, not an
// inspection write.
function snapshotReadonly(sandbox, projectConfigPath) {
  return {
    release: snapshotTree(sandbox.releaseDir),
    globalConfig: readFileSync(join(sandbox.agentDir, "mcp.json"), "utf8"),
    settings: readFileSync(join(sandbox.agentDir, "settings.json"), "utf8"),
    receipt: readFileSync(sandbox.receiptPath, "utf8"),
    projection: readFileSync(sandbox.projectionPath, "utf8"),
    projectOverride: readFileSync(projectConfigPath, "utf8"),
  };
}

function runHostTrustFixture(sandbox, probePath, decision) {
  const result = spawnSync(
    process.execPath,
    [join(testDir, "fixtures", "load-native-host-trust.mjs"), probePath],
    {
      cwd: sandbox.root,
      env: {
        ...allowedHostEnv(),
        ...sandbox.env,
        USERPROFILE: sandbox.env.HOME,
        TMPDIR: sandbox.root,
        TMP: sandbox.root,
        TEMP: sandbox.root,
        PI_OFFLINE: "1",
        PI_TELEMETRY: "0",
        NO_COLOR: "1",
        JORGEX_PI_NATIVE_SDK_ROOT: requestedSdkRoot,
        JORGEX_PI_HOST_TRUST_CHANNEL: CHANNEL,
        JORGEX_PI_HOST_TRUST_DECISION: String(decision),
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    },
  );
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout);
}

function allowedHostEnv() {
  const allowed = {};
  for (const key of ["PATH", "PATHEXT", "SYSTEMROOT", "SystemRoot", "COMSPEC", "ComSpec", "WINDIR", "windir"]) {
    if (process.env[key] !== undefined) allowed[key] = process.env[key];
  }
  return allowed;
}
