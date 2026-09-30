// T70 tracer: native MCP permission surface (RED, Pi).
//
// Risk: Pi's generated permission policy maps MCP through the legacy `mcp`
// proxy surface only. Pi's built-in MCP extension exposes native tools named
// `mcp__<server>__<tool>` (see `@earendil-works/pi-coding-agent`'s
// `dist/extensions/mcp`), which the provider evaluates on their own surface.
// Without a `mcp__*` mapping in the generated policy those native calls fall to
// the universal `ask` fallback, so every ordinary native MCP tool prompts.
//
// This test drives the REAL permission provider through Pi's real no-LLM
// resource loader + runner and the REAL generated policy
// (`assets/permissions/defaults.json`). It fails today because the native
// surface mapping is missing, not because of fixture setup.
//
// Controls in the same run keep the failure unambiguous:
//   - a native call carrying a protected path must still be denied by the
//     transversal `path` gate (`input.path`);
//   - a tool without the MCP namespace prefix must keep the `ask` fallback;
//   - the legacy `mcp: allow` proxy grant must remain effective.
//
// Nested native calls are not covered here: a real proof must go through
// `ctx.executeTool`, whose dispatcher (`ExtensionRunner.executeToolFn`) is a
// host SDK action this no-LLM harness does not run; emitting a manual
// `parentToolCallId` would fake the pipeline. A native SDK session fixture
// exercises that seam.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(testDir, "..");
const permissionDefaultsBytes = readFileSync(join(root, "assets", "permissions", "defaults.json"));

// Prefer the repo's installed provider/SDK (documented `pnpm test` path); fall
// back to the repo-local T69 sandbox that carries the same real packages for
// local tracer runs. Never resolve the real user HOME or an external store.
const repoProvider = join(root, "node_modules", "@gotgenes", "pi-permission-system", "src", "index.ts");
const repoSdkRoot = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
const sandboxRoot = process.env.JORGEX_PI_T69_SANDBOX ?? join(root, ".t69-sandbox");
const sandboxProvider = join(sandboxRoot, "pihost", "node_modules", "@gotgenes", "pi-permission-system", "src", "index.ts");
const sandboxSdkRoot = join(sandboxRoot, "pihost", "node_modules", "@earendil-works", "pi-coding-agent");

const { providerEntry, sdkRoot, available } = resolveRealPackages();
const skipReason = "no real Pi permission provider/SDK available (run `pnpm install` or set JORGEX_PI_T69_SANDBOX)";

test("native MCP namespace tools are allowed by the generated policy while controls stay enforced", { skip: available ? false : skipReason }, (t) => {
  const sandbox = createSandbox(t, "native-mcp-generated");
  writeGeneratedPolicy(sandbox);
  try {
    const output = runNativeFixture(sandbox);

    assert.ok(
      output.toolNames.includes("mcp__fixture__ordinary"),
      "the fixture must register the native MCP tool the real gate keys on",
    );

    // Primary behavior: an ordinary native MCP call resolves to `allow` under
    // the generated policy, instead of the universal `ask` fallback.
    assert.equal(
      output.calls.nativeOrdinary?.block,
      undefined,
      "the generated policy must allow an ordinary native MCP tool under the MCP namespace",
    );
    assert.equal(
      output.decisions.find((event) => event.surface === "mcp__fixture__ordinary")?.resolution,
      "policy_allow",
      "the native MCP call must be allowed by the MCP surface rule, not by the ask fallback",
    );

    // Control 1: the transversal path gate still protects native tools.
    assert.equal(
      output.calls.nativeProtected?.block,
      true,
      "a native MCP call carrying a protected path must stay denied",
    );
    const pathDecision = output.decisions.find((event) => event.surface === "path" && event.value === ".env");
    assert.equal(pathDecision?.resolution, "policy_deny", "the protected path must be a hard policy denial");
    assert.equal(pathDecision?.matchedPattern, "*.env", "the protected path must match the seeded secret rule");

    // Control 2: a tool without the MCP namespace keeps the conservative ask.
    assert.equal(
      output.calls.nonMcpFallback?.block,
      true,
      "a non-MCP tool must keep the ask fallback",
    );
    assert.equal(
      output.decisions.find((event) => event.surface === "unclassified_tool")?.resolution,
      "confirmation_unavailable",
      "the non-MCP fallback must be an approval boundary, not a denial",
    );

    // Control 3: the legacy `mcp: allow` proxy grant must remain effective.
    assert.equal(
      output.calls.legacyMcpProxy?.block,
      undefined,
      "the legacy MCP proxy tool must remain allowed by the generated policy",
    );

    // Isolation guard: the run used the generated asset, never the real HOME.
    assert.equal(output.isolated.home, sandbox.env.HOME, "the fixture must run under the sandbox HOME");
    assert.equal(output.isolated.agentDir, sandbox.agentDir, "the fixture must resolve the sandbox agent dir");
    assert.doesNotMatch(output.isolated.configBytes, /"mcp__fixture__override_deny"/, "the generated policy must be the unmodified asset");
  } finally {
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});

test("a later native override still wins over the broad MCP grant", { skip: available ? false : skipReason }, (t) => {
  const sandbox = createSandbox(t, "native-mcp-override");
  writeGeneratedPolicy(sandbox, {
    "mcp__*": "allow",
    "mcp__fixture__override_deny": "deny",
    "mcp__fixture__override_ask": "ask",
  });
  try {
    const output = runNativeFixture(sandbox);

    assert.equal(
      output.calls.nativeOrdinary?.block,
      undefined,
      "the broad MCP namespace grant must allow an ordinary native tool",
    );
    assert.equal(
      output.calls.nativeOverrideDeny?.block,
      true,
      "a native deny override placed after the namespace grant must still block",
    );
    assert.equal(
      output.decisions.find((event) => event.surface === "mcp__fixture__override_deny")?.resolution,
      "policy_deny",
      "the native deny override must be the hard rule that decided (last match wins)",
    );
    assert.equal(
      output.calls.nativeOverrideAsk?.block,
      true,
      "a native ask override placed after the namespace grant must still prompt",
    );
    assert.equal(
      output.decisions.find((event) => event.surface === "mcp__fixture__override_ask")?.resolution,
      "confirmation_unavailable",
      "the native ask override must resolve to the approval boundary",
    );
  } finally {
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});

function resolveRealPackages() {
  if (existsSync(repoProvider)) return { providerEntry: repoProvider, sdkRoot: repoSdkRoot, available: existsSync(join(repoSdkRoot, "dist", "index.js")) };
  return { providerEntry: sandboxProvider, sdkRoot: sandboxSdkRoot, available: existsSync(sandboxProvider) && existsSync(join(sandboxSdkRoot, "dist", "index.js")) };
}

function createSandbox(t, label) {
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

function writeGeneratedPolicy(sandbox, additions) {
  const policy = JSON.parse(permissionDefaultsBytes.toString("utf8"));
  Object.assign(policy.permission, additions ?? {});
  const dir = join(sandbox.agentDir, "extensions", "pi-permission-system");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), `${JSON.stringify(policy, null, 2)}\n`);
}

function runNativeFixture(sandbox) {
  const result = spawnSync(
    process.execPath,
    [join(testDir, "fixtures", "load-native-mcp-permissions.mjs"), root],
    {
      cwd: sandbox.cwd,
      env: {
        ...sandbox.env,
        JORGEX_PERMISSION_FIXTURE_PROVIDER: providerEntry,
        JORGEX_PI_SDK_ROOT: sdkRoot,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    },
  );
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout);
}

function allowedHostEnv() {
  const result = {};
  for (const key of ["PATH", "PATHEXT", "SYSTEMROOT", "SystemRoot", "COMSPEC", "ComSpec", "WINDIR", "windir"]) {
    if (process.env[key] !== undefined) result[key] = process.env[key];
  }
  return result;
}
