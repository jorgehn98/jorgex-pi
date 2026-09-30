import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// T70 tracer — pure digest of the protected fields of a persistent native MCP
// definition (Spec 71, "Autoridad readonly de MCP persistente: contrato para
// ambos consumidores").
//
// Spec: SHA-256 of UTF-8 JSON without whitespace of the protected fields that
// are present, object keys sorted recursively, array order preserved. Context7
// protects only the canonical `url`; engram and chrome-devtools protect
// `command`, `args` and, when present, `cwd`/`env`. Preferences (`exposure`,
// `toolExposure`, `enabled`) and Context7 `headers` stay outside the digest, and
// an absent field differs from a present empty field. Unknown execution options
// or a transport mix block instead of being silently digested. The function is
// pure over raw data: it never resolves `${NAME}` nor runs a `!command`; that
// availability boundary belongs to a separate ownership checker.
//
// The expected canonical texts are literals on purpose: this test never
// canonicalizes (no key sorting, no field selection), so it cannot agree with
// the implementation by construction. `sha256Literal` only proves each
// (text, digest) literal pair is internally consistent.
const MODULE = "../extensions/mcp-engram.ts";

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
  const module = await import(MODULE);
  assert.equal(
    typeof module.digestNativeMcpDefinition,
    "function",
    "extensions/mcp-engram.ts must export the pure digestNativeMcpDefinition(name, definition)",
  );
  const digest = module.digestNativeMcpDefinition;

  // Literal pairs: the canonical text is written by hand and its digest was
  // computed off the implementation.
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
  // Owned temporary tree: teardown registered immediately after mkdtemp and
  // before any other IO, so it runs on success, failure and cancellation.
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

test("an execution/transport mix is rejected instead of silently digested", async () => {
  const module = await import(MODULE);
  assert.equal(
    typeof module.digestNativeMcpDefinition,
    "function",
    "the pure digest export is required before the transport-mix boundary can be asserted",
  );
  assert.throws(
    () => module.digestNativeMcpDefinition("engram", {
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
test("unsupported names, unknown options and invalid forms fail closed without echoing user content", async () => {
  const module = await import(MODULE);
  assert.equal(
    typeof module.digestNativeMcpDefinition,
    "function",
    "the pure digest export is required before the rejection contract can be asserted",
  );
  const digest = module.digestNativeMcpDefinition;
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
