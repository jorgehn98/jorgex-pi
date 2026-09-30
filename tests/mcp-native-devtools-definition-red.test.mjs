import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  createT28Fixture,
  createT28Handoff,
  writeT28Handoff,
} from "./fixtures/t28-devtools-handoff.mjs";

// T70 first tracer — shared readonly authority for persistent native MCP
// (Spec 71, "Autoridad readonly de MCP persistente: contrato para ambos
// consumidores").
//
// DevTools requires more than a name/digest entry: it needs the existing
// launcher/tree/Node/flags v3 chain. Spec 71 requires exporting
// `resolveNativeDevtoolsDefinition({ env, platform })` from
// `extensions/mcp-engram.ts`, reusing the trusted v3 handoff transform to the
// full guard command/args, without adapter fields, and with no v1/v2 fallback
// for new native registrations. Stack consumes that export from the verified
// artifact instead of duplicating the guard.
//
// The fixture is the shared trusted v3 handoff (tests/fixtures/): the real
// guard authenticates the launcher/tree bytes and only then evaluates the
// launcher, which writes a marker and launches nothing.
const MODULE = "../extensions/mcp-engram.ts";
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
  const module = await import(MODULE);
  assert.equal(
    typeof module.resolveNativeDevtoolsDefinition,
    "function",
    "extensions/mcp-engram.ts must export resolveNativeDevtoolsDefinition({ env, platform }) as the shared readonly DevTools authority",
  );

  const fixture = createT28Fixture(undefined, t);
  try {
    writeT28Handoff(fixture, createT28Handoff(fixture));

    const definition = module.resolveNativeDevtoolsDefinition({ env: fixture.env, platform: process.platform });

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
  } finally {
    rmSync(fixture.sandbox, { recursive: true, force: true });
  }
});

test("a v1 or v2 handoff cannot yield a guarded native definition", async (t) => {
  if (process.platform === "win32") {
    t.skip("the shared internal symlink fixture requires a platform that permits test symlinks");
    return;
  }
  const { resolveMcpEngramConfig } = await import(MODULE);
  const module = await import(MODULE);
  assert.equal(
    typeof module.resolveNativeDevtoolsDefinition,
    "function",
    "the native definition export is required before the v1/v2 boundary can be asserted",
  );

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
    try {
      const value = handoff(fixture);
      writeT28Handoff(fixture, value);

      // Fixture premise: the existing hand-off parser still accepts this shape
      // as the plain mutable launcher, so the boundary below is about the new
      // native export, not about a malformed fixture.
      const resolved = await fixture.resolve();
      assert.equal(resolved.state, "managed", `${label} must be accepted by the existing parser (${resolved.reason ?? "no diagnostic"})`);
      assert.deepEqual(resolved.config.mcpServers["chrome-devtools"]?.args, value.args,
        `${label} must stay the plain launcher in the legacy path`);

      const outcome = attempt(() => module.resolveNativeDevtoolsDefinition({ env: fixture.env, platform: process.platform }));
      assert.equal(
        guardedDefinition(outcome.value),
        false,
        `${label} must not produce a new native guarded definition; a legacy handoff has no trusted v3 evidence${outcome.error ? ` (threw: ${outcome.error.message})` : ""}`,
      );
    } finally {
      rmSync(fixture.sandbox, { recursive: true, force: true });
    }
  }
});

test("control: the extracted fixture still authenticates through the legacy v3 guard", async (t) => {
  if (process.platform === "win32") {
    t.skip("the shared internal symlink fixture requires a platform that permits test symlinks");
    return;
  }
  const { resolveMcpEngramConfig } = await import(MODULE);
  const fixture = createT28Fixture(resolveMcpEngramConfig, t);
  try {
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
  } finally {
    rmSync(fixture.sandbox, { recursive: true, force: true });
  }
});
