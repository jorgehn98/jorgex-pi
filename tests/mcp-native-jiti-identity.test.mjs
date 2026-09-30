// T73 seam: the REAL Pi loader binds the checker to the module root it loaded.
//
// Testing decision
//   Risk: `inspectNativeMcpOwnership` derives its package root from
//   `import.meta.url` and requires physical equality between the running module,
//   the active entry `agentDir/npm/node_modules/jorgex-pi` and
//   `<releaseDir>/node_modules/jorgex-pi`. Every existing case loads the checker
//   with a plain Node import (the managed-entry positive and the imported
//   checkout control in `mcp-native-managed-proof-red.test.mjs`) or a test-side
//   `module.registerHooks` bridge. None proves that the REAL Pi loader, which
//   loads extensions through its Jiti `additionalExtensionPaths` path, keeps
//   that binding when the entry is an active relative symlink. A loader that
//   rewrote the module URL, resolved through a copy, or inferred identity from
//   `sourceInfo`/a file suffix would let a checkout or stage certify the active
//   installation (or the reverse) while every plain-import test stayed green.
//   Existing protection: the plain-import positive/checkout control and the
//   damaged-release seams in `mcp-native-managed-proof-red.test.mjs`, plus the
//   plain-Node `.mjs` consumer surface in
//   `mcp-native-consumer-entrypoint-red.test.mjs`. All of those bypass the Pi
//   loader.
//   New behavior: a probe extension LOADED BY PATH through the real Pi
//   `DefaultResourceLoader` from the ACTIVE managed symlink inside a coherent
//   managed release imports `native-mcp.mjs` relatively and reports
//   `package.state = verified` with the claimed context7 server `managed`; the
//   SAME probe chain loaded from a foreign stage package root against the same
//   active receipt reports `conflict`.
//   Seam: the real loader plus a real `AgentSession` (public
//   `DefaultResourceLoader`, `createAgentSession`, `SettingsManager`,
//   `SessionManager`, event bus, `AgentSession.bindExtensions`) in an isolated
//   child process. No model, no prompt, no network, no API key, no real HOME.
//
// SDK resolution: JORGEX_PI_NATIVE_SDK_ROOT when provided (invalid => fail
// closed, never skip). Without it the case is skipped: the legacy repo SDK is
// not the installed native lane this seam is about, and a false GREEN from an
// unrelated loader build would be worse than no evidence.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { prepareJitiIdentityFixture, PROBE_FILE_NAME } from "./fixtures/native-jiti-identity.mjs";

const testDir = dirname(fileURLToPath(import.meta.url));
const CHANNEL = "jorgex-pi:native-jiti-identity";
const requestedSdkRoot = process.env.JORGEX_PI_NATIVE_SDK_ROOT?.trim() || undefined;

test(
  "the real Pi loader binds the probe to the active managed module root, and a foreign stage root conflicts",
  { skip: resolveNativeSdkSkip() },
  (t) => {
    if (requestedSdkRoot && !existsSync(join(requestedSdkRoot, "dist", "index.js"))) {
      assert.fail(`JORGEX_PI_NATIVE_SDK_ROOT=${requestedSdkRoot} has no dist/index.js`);
    }
    // Owned temporary tree: `createManagedReleaseSandbox` registers the runner
    // teardown right after its own mkdtemp and before any other IO, and every
    // path this helper adds lives inside that tree.
    const fixture = prepareJitiIdentityFixture(t);
    const { sandbox, activeProbePath, stageProbePath } = fixture;

    // Fixture coherence before the loader runs: the code under test is reached
    // through the ACTIVE relative symlink, which physically is the release
    // package root, and the foreign stage is a different physical root.
    assert.equal(
      realpathSync(activeProbePath),
      join(realpathSync(sandbox.packageRoot), "extensions", PROBE_FILE_NAME),
      "the active probe path must physically resolve inside the active release package root",
    );
    assert.notEqual(
      realpathSync(stageProbePath),
      realpathSync(activeProbePath),
      "the foreign stage probe must live in a different physical package root",
    );

    // Both loader runs happen before asserting, so a failure in one half never
    // hides the other half's result.
    const active = runIdentityFixture(sandbox, activeProbePath);
    const foreign = runIdentityFixture(sandbox, stageProbePath);

    // Positive: the probe loaded through the active managed symlink is bound to
    // the release package root, so the package proof verifies and the claimed
    // context7 entry is managed.
    assert.equal(active.errors.length, 0, `the real loader must load the active probe without errors: ${JSON.stringify(active.errors)}`);
    assert.equal(active.extensionCount, 1, "the real loader must load exactly the probe extension");
    assert.ok(active.probe, "the probe must report through the shared extension event bus");
    assert.equal(active.probe.ok, true, `the active probe must not fail: ${active.probe.error ?? "no diagnostic"}`);
    assert.equal(active.probe.result?.package?.state, "verified", `an active managed probe must verify the package proof: ${active.probe.result?.package?.reason ?? "no diagnostic"}`);
    assert.equal(active.probe.result?.servers?.context7?.state, "managed", `the claimed context7 entry must be managed: ${active.probe.result?.servers?.context7?.reason ?? "no diagnostic"}`);
    assert.equal(active.isolated.home, sandbox.env.HOME, "the active run must use the isolated sandbox HOME");
    assert.equal(active.isolated.agentDir, sandbox.env.PI_CODING_AGENT_DIR, "the active run must resolve the isolated agent dir");

    // Control: the same probe chain loaded from a foreign stage root cannot
    // certify the active installation, even with the active receipt present.
    assert.equal(foreign.errors.length, 0, `the real loader must load the stage probe without errors: ${JSON.stringify(foreign.errors)}`);
    assert.ok(foreign.probe, "the stage probe must report through the shared extension event bus");
    assert.equal(foreign.probe.ok, true, `the stage probe must not fail: ${foreign.probe.error ?? "no diagnostic"}`);
    assert.notEqual(foreign.probe.result?.package?.state, "verified", "a foreign stage root must never verify the active receipt");
    assert.equal(foreign.probe.result?.package?.state, "conflict", "a foreign stage root must fail closed as a package conflict");
    assert.equal(foreign.probe.result?.servers?.context7?.state, "conflict", "a claim stays conflict unless the probe runs from the matching managed package root");
    assert.equal(foreign.isolated.home, sandbox.env.HOME, "the control run must use the isolated sandbox HOME");
  },
);

// The explicit root is a mandatory requirement: an invalid one fails, and only
// an absent native lane skips.
function resolveNativeSdkSkip() {
  if (requestedSdkRoot) return false;
  return "no native lane supplied; set JORGEX_PI_NATIVE_SDK_ROOT to the installed Pi SDK root to exercise the real loader identity";
}

function runIdentityFixture(sandbox, probePath) {
  const root = sandbox.root;
  mkdirSync(join(root, "tmp"), { recursive: true });
  const result = spawnSync(
    process.execPath,
    [join(testDir, "fixtures", "load-native-jiti-identity.mjs"), probePath],
    {
      cwd: root,
      env: {
        ...allowedHostEnv(),
        ...sandbox.env,
        USERPROFILE: sandbox.env.HOME,
        XDG_CACHE_HOME: join(root, "xdg-cache"),
        XDG_DATA_HOME: join(root, "xdg-data"),
        TMPDIR: join(root, "tmp"),
        TMP: join(root, "tmp"),
        TEMP: join(root, "tmp"),
        PI_OFFLINE: "1",
        PI_TELEMETRY: "0",
        NO_COLOR: "1",
        JORGEX_PI_NATIVE_SDK_ROOT: requestedSdkRoot,
        JORGEX_PI_JITI_IDENTITY_CHANNEL: CHANNEL,
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
