// Nested MCP seam: real SDK dispatcher `ctx.executeTool` generates `<parentId>/<n>` through session hooks and the real permission provider.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createNativePermissionSandbox as createSandbox } from "./fixtures/native-permission-sandbox.mjs";

const testDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(testDir, "..");
const permissionDefaultsBytes = readFileSync(join(root, "assets", "permissions", "defaults.json"));

const repoSdkRoot = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
const requestedSdkRoot = process.env.JORGEX_PI_NATIVE_SDK_ROOT?.trim() || undefined;
const resolution = await resolveNativeSdk();

test("nested native MCP calls run through the real SDK dispatcher and stay permission-gated", { skip: resolution.skip }, (t) => {
  if (resolution.invalid) assert.fail(resolution.reason);

  const sandbox = createSandbox(t, "native-nested-mcp");
  writeGeneratedPolicy(sandbox);
  try {
    const output = runNativeNestedFixture(sandbox, resolution.root);

    // Capability is proven from the public API the run depends on, not a version.
    assert.equal(output.capability.nestedToolDispatch, true, "the host SDK must expose the nested-tool public API");
    assert.equal(output.capability.scriptedModel, true, "the sibling pi-ai must expose the public faux provider");
    assert.equal(output.capability.sessionApi, true, "the host SDK must expose the public session/model runtime API");
    assert.equal(output.provider.name, "@gotgenes/pi-permission-system", "the nested run must use the real permission provider");

    // Allowed nested call: the child runs once, and the SDK generated its id
    // and parent linkage. The caller id is read back from the SDK's own
    // `tool_execution_start` event, never supplied by the fixture.
    const ordinaryCaller = output.sessionEvents.find(
      (event) => event.toolName === "mcp__fixture__call_ordinary" && event.parentToolCallId === undefined,
    );
    assert.ok(ordinaryCaller, "the SDK must emit the model-issued caller call");
    const ordinaryChild = output.sessionEvents.find(
      (event) => event.toolName === "mcp__fixture__ordinary" && event.parentToolCallId === ordinaryCaller.toolCallId,
    );
    assert.ok(ordinaryChild, "the SDK dispatcher must emit the nested child call with the parent id");
    assert.equal(ordinaryChild.toolCallId, `${ordinaryCaller.toolCallId}/1`, "the SDK must generate the child id as <parentId>/<n>");
    assert.equal(output.effects.ordinary, 1, "an ordinary native nested call under the generated policy must reach the child exactly once");
    assert.equal(output.executeOutcomes["mcp__fixture__call_ordinary"].isError, false, "the allowed nested child must not report an error");

    // The session's `tool_call` hook must observe the nested call with the same
    // SDK-generated parent id, i.e. nested calls really go through the hooks.
    const ordinaryHook = output.hookObservations.find(
      (observation) => observation.toolName === "mcp__fixture__ordinary" && observation.parentToolCallId === ordinaryCaller.toolCallId,
    );
    assert.ok(ordinaryHook, "the tool_call hook must observe the nested child carrying the SDK parent id");
    assert.equal(ordinaryHook.toolCallId, `${ordinaryCaller.toolCallId}/1`, "the hook must observe the SDK-generated child id");

    // Denied nested call via the protected path: the child is dispatched and
    // then blocked by the real permission provider, so its effect never runs.
    const protectedCaller = output.sessionEvents.find(
      (event) => event.toolName === "mcp__fixture__call_protected" && event.parentToolCallId === undefined,
    );
    assert.ok(protectedCaller, "the SDK must emit the protected caller call");
    const protectedChild = output.sessionEvents.find(
      (event) => event.toolName === "mcp__fixture__ordinary" && event.parentToolCallId === protectedCaller.toolCallId,
    );
    assert.ok(protectedChild, "the SDK dispatcher must still emit the nested call before the gate blocks it");
    assert.equal(protectedChild.toolCallId, `${protectedCaller.toolCallId}/1`, "the blocked nested call must keep the SDK-generated id");
    assert.equal(output.effects.ordinary, 1, "a path-protected nested call must not reach the child's effect");
    const protectedOutcome = output.executeOutcomes["mcp__fixture__call_protected"];
    assert.equal(protectedOutcome.isError, true, "a path-protected nested call must report a blocked outcome");
    assert.match(protectedOutcome.text, /pi-permission-system|Denied by policy/i, "the block must come from the real permission provider");
    assert.doesNotMatch(protectedOutcome.text, /ordinary-effect/, "the blocked child must not have produced its effect");

    // Denied nested call via an explicit deny override: still no effect.
    assert.equal(output.effects.denied, 0, "a deny-overridden native tool must never execute as a nested call");
    assert.equal(output.executeOutcomes["mcp__fixture__call_denied"].isError, true, "the deny override must surface as a failed nested call");

    // Isolation guard: the run used the generated asset under an isolated HOME.
    assert.equal(output.isolated.home, sandbox.env.HOME, "the fixture must run under the sandbox HOME");
    assert.equal(output.isolated.agentDir, sandbox.agentDir, "the fixture must resolve the sandbox agent dir");
    assert.doesNotMatch(output.isolated.configBytes, /"mcp__fixture__override_deny"/, "the generated policy must be the unmodified asset");
  } finally {
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});

// Resolve the host SDK from the explicit env var or the repo install, and
// decide availability from the SDK's PUBLIC nested-tool API surface.
async function resolveNativeSdk() {
  if (requestedSdkRoot) {
    const probe = await probeNativeSdk(requestedSdkRoot);
    if (!probe.ok) {
      return {
        invalid: true,
        skip: false,
        reason: `JORGEX_PI_NATIVE_SDK_ROOT=${requestedSdkRoot} is not a nested-capable Pi SDK: ${probe.reason}`,
      };
    }
    return { root: requestedSdkRoot, skip: false };
  }
  const probe = await probeNativeSdk(repoSdkRoot);
  if (probe.ok) return { root: repoSdkRoot, skip: false };
  return {
    root: repoSdkRoot,
    skip: `no nested-capable Pi SDK available (${probe.reason}); set JORGEX_PI_NATIVE_SDK_ROOT to a build exposing the public nested-tool API`,
  };
}

async function probeNativeSdk(sdkRoot) {
  const sdkEntry = join(sdkRoot, "dist", "index.js");
  if (!existsSync(sdkEntry)) return { ok: false, reason: `entry missing at ${sdkEntry}` };
  const piAiEntry = join(dirname(sdkRoot), "pi-ai", "dist", "index.js");
  if (!existsSync(piAiEntry)) return { ok: false, reason: `sibling pi-ai missing at ${piAiEntry}` };
  try {
    const sdk = await import(pathToFileURL(sdkEntry).href);
    const ai = await import(pathToFileURL(piAiEntry).href);
    if (typeof sdk.createAgentSession !== "function") return { ok: false, reason: "createAgentSession is not exported" };
    if (typeof sdk.ModelRuntime?.create !== "function") return { ok: false, reason: "ModelRuntime.create is not exported" };
    if (typeof sdk.AgentSession?.prototype?.getCallableToolNames !== "function") {
      return { ok: false, reason: "AgentSession exposes no public nested-tool API (getCallableToolNames)" };
    }
    if (typeof ai.fauxProvider !== "function") return { ok: false, reason: "pi-ai does not export the public faux provider" };
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `import failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function writeGeneratedPolicy(sandbox) {
  const policy = JSON.parse(permissionDefaultsBytes.toString("utf8"));
  // Fixture-only override: an ordinary native tool that this run denies by
  // policy. The generated `mcp__*` grant itself stays untouched.
  policy.permission["mcp__fixture__denied"] = "deny";
  const dir = join(sandbox.agentDir, "extensions", "pi-permission-system");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), `${JSON.stringify(policy, null, 2)}\n`);
}

function runNativeNestedFixture(sandbox, sdkRoot) {
  const result = spawnSync(
    process.execPath,
    [join(testDir, "fixtures", "load-native-nested-mcp-permissions.mjs")],
    {
      cwd: sandbox.cwd,
      env: {
        ...sandbox.env,
        JORGEX_PI_NATIVE_SDK_ROOT: sdkRoot,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    },
  );
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout);
}
