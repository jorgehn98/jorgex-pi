// Native config surface: `mcp.json` reader authority, the canonical definition
// digest and the trusted v3 DevTools definition.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createT28Fixture, createT28Handoff, writeT28Handoff } from "./fixtures/t28-devtools-handoff.mjs";

// Historical `.ts` compatibility shim: the source tests load the TypeScript
// module directly; the managed-release fixture copies the `.mjs` producer
// closure instead.
const MODULE = "../extensions/mcp-engram.ts";
const nativeModule = await import(MODULE);
const { digestNativeMcpDefinition, resolveMcpEngramConfig, resolveNativeDevtoolsDefinition } = nativeModule;

const OFFICIAL_ARGS = ["mcp", "--tools=agent"];

test("the native config module exposes the reader, digest and DevTools definition API", () => {
  for (const name of ["resolveMcpEngramConfig", "digestNativeMcpDefinition", "resolveNativeDevtoolsDefinition"]) {
    assert.equal(typeof nativeModule[name], "function", `extensions/mcp-engram.ts must export ${name}`);
  }
});

// --- Reader: `mcp.json` is the authority; the adapter must not be required. --
function nativeSandbox(t, { packages, mcpJson }) {
  const root = mkdtempSync(join(tmpdir(), "jorgex-pi-native-reader-"));
  // Owned temporary tree: register the runner-hook teardown immediately after
  // the owned mkdtemp and before any other IO, so it runs on success, failure
  // and cancellation.
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify({ packages }, null, 2)}\n`);
  writeFileSync(join(agentDir, "mcp.json"), mcpJson);
  const env = { HOME: root, PI_CODING_AGENT_DIR: agentDir, XDG_CONFIG_HOME: join(root, "xdg") };
  return {
    root,
    resolve: (resolveEngramBinary = () => process.execPath) =>
      resolveMcpEngramConfig({ resolveEngramBinary, env, platform: "linux", cwd: root }),
  };
}

function nativeConfig() {
  return `${JSON.stringify(
    { mcpServers: { engram: { command: process.execPath, args: OFFICIAL_ARGS, exposure: "deferred" } } },
    null,
    2,
  )}\n`;
}

test("native mcp.json is the Engram authority and an installed adapter is not required", async (t) => {
  const sandbox = nativeSandbox(t, { packages: ["npm:gentle-engram@0.1.16"], mcpJson: nativeConfig() });
  const result = await sandbox.resolve();
  assert.notEqual(
    result.state,
    "missing",
    `a native install (mcp.json + one gentle-engram, no adapter) must not be reported as missing: ${result.reason ?? ""}`,
  );
  assert.notEqual(result.state, "failed", `a valid native mcp.json must not fail closed: ${result.reason ?? ""}`);
  assert.ok(result.config.mcpServers.engram, "the Engram server must be resolved from mcp.json");
  assert.equal(result.config.mcpServers.engram.command, process.execPath, "mcp.json is the authority for the Engram command");
  assert.deepEqual(
    result.config.mcpServers.engram.args,
    OFFICIAL_ARGS,
    "the official Engram arguments from mcp.json reach the resolved server",
  );
});

test("native reader still fails closed on duplicate gentle entries and non-strict mcp.json", async (t) => {
  const strict = JSON.stringify({
    mcpServers: { engram: { command: process.execPath, args: OFFICIAL_ARGS, exposure: "deferred" } },
  });
  const duplicate = nativeSandbox(t, {
    packages: ["npm:gentle-engram@0.1.16", "npm:gentle-engram@0.1.15"],
    mcpJson: nativeConfig(),
  });
  // Pi's native parser is strict JSON: a trailing comma is not a valid authority.
  const jsonc = nativeSandbox(t, {
    packages: ["npm:gentle-engram@0.1.16"],
    mcpJson: `${strict.slice(0, -1)},\n}\n`,
  });

  const duplicated = await duplicate.resolve();
  assert.notEqual(duplicated.state, "managed", "duplicate gentle-engram entries must not resolve healthy");
  assert.equal(
    duplicated.config.mcpServers.engram,
    undefined,
    "a duplicate gentle-engram singleton must not expose the Engram server",
  );

  const nonStrict = await jsonc.resolve();
  assert.notEqual(nonStrict.state, "managed", "a non-strict mcp.json must not resolve healthy");
  assert.equal(
    nonStrict.config.mcpServers.engram,
    undefined,
    "JSONC is not the native authority; a trailing comma must not expose the Engram server",
  );
});

// Explicit Engram binary precedence: a persisted `mcp.json` command that
// disagrees with the injected resolver fails closed for the same security
// reason, and the resolver must actually be consulted instead of being silently
// ignored.
const PRECEDENCE_REASON = /does not match the configured Engram binary|explicit configuration takes precedence/i;

test("native reader preserves explicit Engram binary precedence over the persisted command", async (t) => {
  const sandbox = nativeSandbox(t, { packages: ["npm:gentle-engram@0.1.16"], mcpJson: nativeConfig() });
  // A real executable fixture, so the expected failure cannot be a shape error.
  const explicitBinary = join(sandbox.root, "explicit-engram");
  writeFileSync(explicitBinary, "fake binary; never execute\n");
  chmodSync(explicitBinary, 0o755);
  let resolverCalls = 0;
  const result = await sandbox.resolve(() => {
    resolverCalls += 1;
    return explicitBinary;
  });
  assert.equal(
    result.state,
    "failed",
    `a persisted Engram command that disagrees with the explicit binary must fail closed, got ${result.state}: ${result.reason ?? ""}`,
  );
  assert.equal(
    result.config.mcpServers.engram,
    undefined,
    "the persisted Engram server must not be accepted when the explicit binary takes precedence",
  );
  assert.match(
    result.reason ?? "",
    PRECEDENCE_REASON,
    "the failure must be the security command-mismatch contract, not an unrelated reader/shape error",
  );
  assert.equal(resolverCalls, 1, "the native path must consult the explicit resolver (no unused injection)");
});

// --- Digest: SHA-256 over UTF-8 JSON without whitespace, keys sorted
// recursively, array order preserved. ---------------------------------------
const CANONICAL_ENGRAM = '{"args":["mcp","${TZ}"],"command":"/opt/jorgex-demo/bin/engram","cwd":"/opt/jorgex-demo","env":{"TZ":"UTC","X-Note":"demo"}}';
const DIGEST_ENGRAM = "729eac9b9809fce04a64b339eb2c9133e107819181c8173325efa56d0b53ebdc";
const CANONICAL_CONTEXT7 = '{"url":"https://mcp.context7.com/mcp"}';
const DIGEST_CONTEXT7 = "34fe1b5d45d7e4d15701b203d146dff79f83c9bf9ad8d294eceb33e0fc2f4595";
const CANONICAL_DEVTOOLS = '{"args":["--input-type=module","--eval","guard","--isolated"],"command":"/opt/jorgex-demo/bin/node"}';
const DIGEST_DEVTOOLS = "414ed1f632ce305786099f03c82e183f859ee972fe747e24612eff3bfbbd3756";

function sha256Literal(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function engram(overrides = {}) {
  return {
    command: "/opt/jorgex-demo/bin/engram",
    args: ["mcp", "${TZ}"],
    cwd: "/opt/jorgex-demo",
    env: { "X-Note": "demo", TZ: "UTC" },
    ...overrides,
  };
}

test("digestNativeMcpDefinition hashes only the canonical protected fields", async (t) => {
  const digest = digestNativeMcpDefinition;

  // Literal pairs: the canonical text is written by hand and its digest is an
  // independent known vector, never recomputed the way the implementation does.
  assert.equal(sha256Literal(CANONICAL_ENGRAM), DIGEST_ENGRAM, "the engram literal pair must be consistent");
  assert.equal(sha256Literal(CANONICAL_CONTEXT7), DIGEST_CONTEXT7, "the context7 literal pair must be consistent");
  assert.equal(sha256Literal(CANONICAL_DEVTOOLS), DIGEST_DEVTOOLS, "the chrome-devtools literal pair must be consistent");

  assert.equal(digest("engram", engram()), DIGEST_ENGRAM, "engram protects command, args, cwd and env");
  assert.equal(
    digest("chrome-devtools", { command: "/opt/jorgex-demo/bin/node", args: ["--input-type=module", "--eval", "guard", "--isolated"] }),
    DIGEST_DEVTOOLS,
    "chrome-devtools protects command and args",
  );
  assert.equal(
    digest("context7", { url: "https://mcp.context7.com/mcp", headers: { "X-Note": "demo" }, exposure: "direct" }),
    DIGEST_CONTEXT7,
    "context7 protects only the canonical url",
  );

  // Declaration order, nested key order, preferences and Context7 headers stay
  // outside the digest.
  const reordered = {
    toolExposure: { "*": "direct" },
    enabled: true,
    exposure: "deferred",
    env: { TZ: "UTC", "X-Note": "demo" },
    cwd: "/opt/jorgex-demo",
    args: ["mcp", "${TZ}"],
    command: "/opt/jorgex-demo/bin/engram",
  };
  assert.equal(
    digest("engram", reordered),
    DIGEST_ENGRAM,
    "declaration order, exposure, toolExposure and enabled must not change the digest",
  );
  assert.equal(
    digest("context7", { headers: { "X-Note": "changed" }, url: "https://mcp.context7.com/mcp" }),
    DIGEST_CONTEXT7,
    "Context7 headers must stay outside the digest",
  );

  // Protected-field mutations are visible; arrays keep their order.
  assert.notEqual(digest("engram", engram({ command: "/opt/jorgex-demo/bin/engram-other" })), DIGEST_ENGRAM, "command is protected");
  assert.notEqual(digest("engram", engram({ args: ["mcp", "--tools=agent"] })), DIGEST_ENGRAM, "args are protected and ${TZ} must stay raw");
  assert.notEqual(digest("engram", engram({ args: ["${TZ}", "mcp"] })), DIGEST_ENGRAM, "array order is preserved");
  assert.notEqual(digest("engram", engram({ cwd: "/opt/jorgex-demo/other" })), DIGEST_ENGRAM, "cwd is protected");
  assert.notEqual(
    digest("engram", engram({ env: { "X-Note": "demo", TZ: "UTC", EXTRA: "1" } })),
    DIGEST_ENGRAM,
    "env is protected",
  );
  assert.notEqual(digest("context7", { url: "https://mcp.context7.com/other" }), DIGEST_CONTEXT7, "the canonical url is protected");

  // A present field differs from an absent one.
  const withoutEnv = engram();
  delete withoutEnv.env;
  assert.notEqual(digest("engram", withoutEnv), DIGEST_ENGRAM, "an absent env must differ from a present env");
  assert.notEqual(
    digest("engram", withoutEnv),
    digest("engram", { ...withoutEnv, env: {} }),
    "an absent env must differ from a present empty env object",
  );
  assert.notEqual(
    digest("engram", withoutEnv),
    digest("engram", { ...withoutEnv, args: [] }),
    "an absent args must differ from a present empty args array",
  );

  // Raw customization values stay raw: the digest hashes them and must never
  // resolve or execute them, so the owned canary file stays absent.
  const canaryRoot = mkdtempSync(join(tmpdir(), "jorgex-pi-native-digest-canary-"));
  t.after(() => rmSync(canaryRoot, { recursive: true, force: true }));
  const markerPath = join(canaryRoot, "canary");
  const raw = { command: "/opt/jorgex-demo/bin/engram", args: ["mcp", "${TZ}"], env: { "X-Note": `!touch ${markerPath}` } };
  const rawDigest = digest("engram", raw);
  assert.match(rawDigest, /^[0-9a-f]{64}$/, "raw customization values must still hash as plain data");
  assert.equal(existsSync(markerPath), false, "the digest must never execute a raw ! command");
  if (process.platform !== "win32") {
    assert.equal(
      rawDigest,
      sha256Literal(`{"args":["mcp","\${TZ}"],"command":"/opt/jorgex-demo/bin/engram","env":{"X-Note":"!touch ${markerPath}"}}`),
      "the raw ! command and the ${TZ} reference must be hashed verbatim",
    );
  }
});

test("an execution/transport mix is rejected instead of silently digested", () => {
  assert.throws(
    () => digestNativeMcpDefinition("engram", {
      command: "/opt/jorgex-demo/bin/engram",
      args: ["mcp", "--tools=agent"],
      url: "https://demo.invalid/mcp",
    }),
    /transport|url/i,
    "a definition mixing a stdio command with an http url must block instead of being silently digested",
  );
});

// Closed-choice and privacy guard (Spec 71: "nombre no permitido y definición
// inválida/unsupported lanzan error sin contenido sensible"; `type`, `timeout`
// and `oauth` do not belong to the v1 managed definition and are rejected).
// The transport mix keeps its identifiable diagnostic above; every other
// unsupported option must produce the same fixed, generic sentence, so the
// assertion uses arbitrary non-sensitive field names and never a credential:
// what it protects is that user-authored field content cannot reach a
// diagnostic, not the specific fixture string.
test("unsupported names, unknown options and invalid forms fail closed without echoing user content", () => {
  const digest = digestNativeMcpDefinition;
  const messageOf = (run) => {
    try {
      run();
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };

  // Name outside the closed set of three: rejected generically.
  const rejectedName = "user-provided-server";
  const nameMessage = messageOf(() => digest(rejectedName, { url: "https://demo.invalid/mcp" }));
  assert.equal(typeof nameMessage, "string", "a name outside the three managed names must be rejected");
  assert.doesNotMatch(nameMessage, new RegExp(rejectedName), "the rejected name must not be echoed");

  // Unknown options: user-authored field content never reaches the diagnostic,
  // and any unknown option produces the same generic fixed sentence.
  const firstKey = "user_note_not_for_diagnostics";
  const secondKey = "another_user_field";
  const firstMessage = messageOf(() => digest("engram", { command: "/opt/jorgex-demo/bin/engram", [firstKey]: "demo-value" }));
  const secondMessage = messageOf(() => digest("engram", { command: "/opt/jorgex-demo/bin/engram", [secondKey]: "demo-value" }));
  assert.equal(typeof firstMessage, "string", `an unknown option must be rejected: ${firstMessage}`);
  assert.doesNotMatch(firstMessage, new RegExp(firstKey), "the diagnostic must not echo the user field key");
  assert.doesNotMatch(firstMessage, /demo-value/, "the diagnostic must not echo the user field value");
  assert.equal(secondMessage, firstMessage, "every unknown option must produce the same generic sentence");
  assert.doesNotMatch(secondMessage, new RegExp(secondKey), "the generic sentence must not depend on the field key");

  // Execution fields the v1 managed definition does not own are rejected, not
  // resolved or ignored.
  for (const key of ["type", "timeout", "oauth"]) {
    assert.equal(
      typeof messageOf(() => digest("engram", { command: "/opt/jorgex-demo/bin/engram", [key]: "value" })),
      "string",
      `${key} does not belong to the v1 managed definition and must be rejected`,
    );
  }

  // Invalid forms fail closed.
  for (const [label, definition] of [
    ["non-object definition", "not-an-object"],
    ["relative command", { command: "engram" }],
    ["relative cwd", { command: "/opt/jorgex-demo/bin/engram", cwd: "relative/dir" }],
    ["non-string env value", { command: "/opt/jorgex-demo/bin/engram", env: { TZ: 1 } }],
    ["non-string args entry", { command: "/opt/jorgex-demo/bin/engram", args: [1] }],
    ["context7 without a url", { headers: { "X-Note": "demo" } }],
  ]) {
    const name = label === "context7 without a url" ? "context7" : "engram";
    assert.equal(
      typeof messageOf(() => digest(name, definition)),
      "string",
      `${label} must be rejected`,
    );
  }
});

// --- DevTools definition: trusted v3 launcher/tree guard only, no v1/v2
// fallback for new native registrations. -------------------------------------
const GUARD_SOURCE = /^await eval\(Buffer\.from\("([A-Za-z0-9+/=]+)", "base64"\)\.toString\("utf8"\)\)$/;
const ADAPTER_FIELDS = ["lifecycle", "directTools", "toolPrefix", "excludeTools"];

function guardedDefinition(value) {
  return Boolean(value)
    && typeof value.command === "string"
    && Array.isArray(value.args)
    && value.args.some((arg) => typeof arg === "string" && GUARD_SOURCE.test(arg));
}

function attempt(run) {
  try {
    return { value: run() };
  } catch (error) {
    return { value: undefined, error };
  }
}

test("resolveNativeDevtoolsDefinition exports the trusted v3 handoff as a guarded native definition", async (t) => {
  if (process.platform === "win32") {
    t.skip("the shared internal symlink fixture requires a platform that permits test symlinks");
    return;
  }
  const fixture = createT28Fixture(undefined, t);
  writeT28Handoff(fixture, createT28Handoff(fixture));

  const definition = resolveNativeDevtoolsDefinition({ env: fixture.env, platform: process.platform });

  // Exact command/args of the guarded definition, never the plain launcher.
  assert.equal(definition?.command, process.execPath, "the native definition must run this Pi runtime's Node");
  assert.ok(Array.isArray(definition?.args), "the native definition must carry args");
  assert.deepEqual(definition.args.slice(0, 2), ["--input-type=module", "--eval"],
    "the native definition must keep Node's inline guard invocation");
  const [guard] = definition.args.slice(2).filter((arg) => typeof arg === "string" && GUARD_SOURCE.test(arg));
  assert.ok(guard, `the guard must be the full base64 self-decoding guard, not a plain launcher: ${JSON.stringify(definition.args)}`);
  const guardBody = Buffer.from(GUARD_SOURCE.exec(guard)[1], "base64").toString("utf8");
  assert.match(guardBody, /trusted DevTools guard/, "the definition must carry the trusted guard body");
  assert.notEqual(definition.command, fixture.launcherPath, "the mutable launcher must never be the command");
  assert.equal(definition.args[3], fixture.launcherPath, "the launcher stays argv[1] for the guard's argv check");
  assert.deepEqual(definition.args.slice(4), fixture.fixedFlags, "the exact four privacy flags must be preserved");
  for (const field of ADAPTER_FIELDS) {
    assert.equal(field in definition, false, `the native definition must not carry the adapter field ${field}`);
  }

  // The definition is executable: the real guard authenticates handoff
  // evidence and only then runs the (harmless) launcher.
  const run = () => spawnSync(definition.command, definition.args, {
    cwd: fixture.sandbox,
    env: { ...process.env, T28_MARKER: fixture.markerPath },
    encoding: "utf8",
  });

  const valid = run();
  assert.equal(valid.status, 0, `the guarded native definition must verify and run: ${valid.stderr}`);
  assert.equal(existsSync(fixture.markerPath), true, "a verified launcher must reach the marker");
  unlinkSync(fixture.markerPath);

  writeFileSync(fixture.launcherPath, `${fixture.launcherBytes}\n// tampered launcher\n`);
  const launcherTampered = run();
  assert.notEqual(launcherTampered.status, 0, "launcher tamper must fail before the launcher can act");
  assert.equal(existsSync(fixture.markerPath), false, "launcher tamper must not reach the marker");

  writeFileSync(fixture.launcherPath, fixture.launcherBytes);
  writeFileSync(fixture.entryPath, `${fixture.entryBytes}\n// tampered tree entry\n`);
  const treeTampered = run();
  assert.notEqual(treeTampered.status, 0, "tree tamper must fail before the launcher can act");
  assert.equal(existsSync(fixture.markerPath), false, "tree tamper must not reach the marker");
});

test("a v1 or v2 handoff cannot yield a guarded native definition", async (t) => {
  if (process.platform === "win32") {
    t.skip("the shared internal symlink fixture requires a platform that permits test symlinks");
    return;
  }
  const packageArg = "chrome-devtools-mcp@1.10.1";
  const cases = [
    {
      label: "v1 registry handoff",
      handoff: (fixture) => ({
        schemaVersion: 1,
        enabled: true,
        command: process.execPath,
        args: ["dlx", packageArg, ...fixture.fixedFlags],
      }),
    },
    {
      label: "v2 local launcher handoff",
      handoff: (fixture) => ({
        schemaVersion: 2,
        enabled: true,
        command: process.execPath,
        args: [fixture.launcherPath, ...fixture.fixedFlags],
      }),
    },
  ];

  for (const { label, handoff } of cases) {
    const fixture = createT28Fixture(resolveMcpEngramConfig, t);
    const value = handoff(fixture);
    writeT28Handoff(fixture, value);

    // Fixture premise: the existing hand-off parser still accepts this shape as
    // the plain mutable launcher, so the boundary below is about the new native
    // export, not about a malformed fixture.
    const resolved = await fixture.resolve();
    assert.equal(resolved.state, "managed", `${label} must be accepted by the existing parser (${resolved.reason ?? "no diagnostic"})`);
    assert.deepEqual(resolved.config.mcpServers["chrome-devtools"]?.args, value.args,
      `${label} must stay the plain launcher in the legacy path`);

    const outcome = attempt(() => resolveNativeDevtoolsDefinition({ env: fixture.env, platform: process.platform }));
    assert.equal(
      guardedDefinition(outcome.value),
      false,
      `${label} must not produce a new native guarded definition; a legacy handoff has no trusted v3 evidence${outcome.error ? ` (threw: ${outcome.error.message})` : ""}`,
    );
  }
});

test("control: the extracted fixture still authenticates through the legacy v3 guard", async (t) => {
  if (process.platform === "win32") {
    t.skip("the shared internal symlink fixture requires a platform that permits test symlinks");
    return;
  }
  const fixture = createT28Fixture(resolveMcpEngramConfig, t);
  const handoff = createT28Handoff(fixture);
  writeT28Handoff(fixture, handoff);

  const resolved = await fixture.resolve();
  assert.equal(resolved.state, "managed", `a valid v3 handoff must still register (${resolved.reason ?? "no diagnostic"})`);
  const server = resolved.config.mcpServers["chrome-devtools"];
  assert.equal(server?.command, process.execPath, "the legacy registration must still use this runtime's Node");
  assert.notDeepEqual(server?.args, handoff.args, "the legacy registration must still replace the mutable launcher with the guard");

  const run = spawnSync(server.command, server.args, {
    cwd: fixture.sandbox,
    env: { ...process.env, T28_MARKER: fixture.markerPath },
    encoding: "utf8",
  });
  assert.equal(run.status, 0, `the legacy v3 guard must still verify the handoff: ${run.stderr}`);
  assert.equal(existsSync(fixture.markerPath), true, "the shared fixture must reach the marker through the real guard");
});
