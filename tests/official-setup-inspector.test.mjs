import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(testDir, "..");

// Canonical Context7 endpoint and DevTools pin must never drift (controls).
const CANONICAL_CONTEXT7_URL = "https://mcp.context7.com/mcp";
const DEVTOOLS_ARGS = [
  "dlx",
  "chrome-devtools-mcp@1.6.0",
  "--isolated",
  "--redact-network-headers",
  "--no-performance-crux",
  "--no-usage-statistics",
];

test("official setup requires exactly one global gentle-engram@semver and one pi-mcp-adapter, no project duplicate", async () => {
  const { inspectContext7Config } = await import("../extensions/context7-config.mjs");
  const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-official-packages-"));
  const home = join(sandbox, "home");
  const agentDir = join(sandbox, "agent");
  const globalSettingsPath = join(agentDir, "settings.json");
  const projectDir = join(sandbox, "project");
  const projectSettingsPath = join(projectDir, ".pi", "settings.json");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(dirname(projectSettingsPath), { recursive: true });
  const env = {
    HOME: home,
    USERPROFILE: home,
    PI_CODING_AGENT_DIR: agentDir,
    XDG_CONFIG_HOME: join(sandbox, "xdg-config"),
  };
  const writeSettings = (globalPackages, projectPackages) => {
    writeFileSync(globalSettingsPath, `${JSON.stringify({ packages: globalPackages }, null, 2)}\n`);
    writeFileSync(projectSettingsPath, `${JSON.stringify({ packages: projectPackages }, null, 2)}\n`);
  };

  try {
    // Valid official setup: exactly one gentle + one adapter globally, none in project.
    // Desired: managed/available (single external owner). Current bundled inspector
    // treats any external adapter as conflict to remove, so this RED must fail now.
    writeSettings(["npm:gentle-engram@0.1.13", "npm:pi-mcp-adapter@2.36.0"], []);
    const valid = inspectContext7Config({ env, cwd: projectDir, platform: "linux" });
    assert.equal(
      valid.state,
      "available",
      "exactly one global gentle-engram@semver + one global pi-mcp-adapter must be the single official owner (no bundled fallback)",
    );
    // Project duplicates must block even when global is valid.
    writeSettings(["npm:gentle-engram@0.1.13", "npm:pi-mcp-adapter@2.36.0"], ["npm:gentle-engram@0.1.13"]);
    const projectGentle = inspectContext7Config({ env, cwd: projectDir, platform: "linux" });
    assert.equal(projectGentle.state, "conflict", "a project gentle-engram duplicate must fail closed");
    assert.match(projectGentle.code ?? projectGentle.source ?? "", /gentle|conflict|duplicate|external/i);

    writeSettings(["npm:gentle-engram@0.1.13", "npm:pi-mcp-adapter@2.36.0"], ["npm:pi-mcp-adapter@2.36.0"]);
    const projectAdapter = inspectContext7Config({ env, cwd: projectDir, platform: "linux" });
    assert.equal(projectAdapter.state, "conflict", "a project pi-mcp-adapter duplicate must fail closed");

    // Missing either package must fail closed without bundled fallback.
    writeSettings([], []);
    const missing = inspectContext7Config({ env, cwd: projectDir, platform: "linux" });
    assert.notEqual(missing.state, "available", "missing official packages must not look available");

    // Duplicate global gentle must be distinguishable from valid single.
    writeSettings(["npm:gentle-engram@0.1.13", "npm:gentle-engram@0.1.14", "npm:pi-mcp-adapter@2.36.0"], []);
    const duplicateGlobal = inspectContext7Config({ env, cwd: projectDir, platform: "linux" });
    assert.equal(duplicateGlobal.state, "conflict", "duplicate global gentle-engram must fail closed");

    // Invalid semver must not count as the single valid entry.
    writeSettings(["npm:gentle-engram@not-a-version", "npm:pi-mcp-adapter@2.36.0"], []);
    const invalidSemver = inspectContext7Config({ env, cwd: projectDir, platform: "linux" });
    assert.notEqual(invalidSemver.state, "available", "gentle-engram@invalid semver must not satisfy the single-owner contract");
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("official setup distinguishes missing/duplicate/malformed/unreadable/conflict settings", async () => {
  const { inspectContext7Config } = await import("../extensions/context7-config.mjs");
  const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-official-settings-states-"));
  const home = join(sandbox, "home");
  const agentDir = join(sandbox, "agent");
  const globalSettingsPath = join(agentDir, "settings.json");
  const cwd = join(sandbox, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const env = { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir };

  try {
    rmSync(globalSettingsPath, { force: true });
    const missing = inspectContext7Config({ env, cwd, platform: "linux" });
    assert.equal(missing.state, "available", "absent settings remain permissive for isolated inspection");

    writeFileSync(globalSettingsPath, "{ invalid json\n");
    const malformed = inspectContext7Config({ env, cwd, platform: "linux" });
    assert.equal(malformed.state, "invalid", "malformed settings JSON must be invalid, not available");
    assert.equal(malformed.source, "pi-global-settings");

    mkdirSync(join(sandbox, "dir-as-settings"), { recursive: true });
    rmSync(globalSettingsPath, { force: true });
    // Unreadable: a directory at the settings path fails closed (EISDIR, not ENOENT).
    // Use a symlink-free directory rename to provoke a non-ENOENT read error.
    writeFileSync(globalSettingsPath, '{"packages":[]}\n');
    chmodSync(globalSettingsPath, 0o000);
    let unreadable;
    try {
      unreadable = inspectContext7Config({ env, cwd, platform: "linux" });
    } finally {
      chmodSync(globalSettingsPath, 0o644);
    }
    // Root may still read 000 files; accept either invalid or available but require no throw and no write.
    assert.ok(["invalid", "available"].includes(unreadable.state), "unreadable settings must not throw");
    assert.equal(readFileSync(globalSettingsPath, "utf8"), '{"packages":[]}\n', "inspection must be read-only");

    writeFileSync(globalSettingsPath, `${JSON.stringify({ packages: ["npm:gentle-engram@0.1.13", "npm:pi-mcp-adapter@2.36.0"] }, null, 2)}\n`);
    const conflictProbe = inspectContext7Config({ env, cwd, platform: "linux" });
    // Current bundled logic reports external adapter as conflict; official logic
    // must instead treat the single global pair as the required owner.
    // This assertion documents the migration: it fails now and passes after T22.
    assert.equal(conflictProbe.state, "available", "single global official pair must not be reported as unmanaged conflict");
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("valid mcp.json Engram server requires exact fields and command precedence", async () => {
  const { resolveMcpEngramConfig } = await import("../extensions/mcp-engram.ts");
  const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-official-mcp-engram-"));
  const agentDir = join(sandbox, "agent");
  const mcpPath = join(agentDir, "mcp.json");
  const fakeBin = join(sandbox, "engram");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(fakeBin, "fake binary; never execute\n");
  chmodSync(fakeBin, 0o755);

  try {
    const validServer = {
      command: fakeBin,
      args: ["mcp", "--tools=agent"],
      lifecycle: "lazy",
      directTools: false,
    };
    writeFileSync(mcpPath, `${JSON.stringify({ mcpServers: { engram: validServer } }, null, 2)}\n`);
    const valid = await resolveMcpEngramConfig({
      resolveEngramBinary: () => fakeBin,
      env: { HOME: join(sandbox, "home"), PI_CODING_AGENT_DIR: agentDir },
      platform: "linux",
      cwd: sandbox,
    });
    assert.equal(valid.state, "managed", "a valid official mcp.json engram server must resolve to managed");
    assert.deepEqual(
      valid.config.mcpServers.engram,
      { command: fakeBin, args: ["mcp", "--tools=agent"], lifecycle: "lazy", directTools: false, toolPrefix: "none", excludeTools: ["mem_capture_passive"] },
      "official engram server must carry exact command/args/lifecycle/directTools:false",
    );

    // directTools:true must never satisfy the official contract.
    writeFileSync(mcpPath, `${JSON.stringify({ mcpServers: { engram: { ...validServer, directTools: true } } }, null, 2)}\n`);
    const directTrue = await resolveMcpEngramConfig({
      resolveEngramBinary: () => fakeBin,
      env: { HOME: join(sandbox, "home"), PI_CODING_AGENT_DIR: agentDir },
      platform: "linux",
      cwd: sandbox,
    });
    assert.notDeepEqual(directTrue.config.mcpServers.engram?.directTools, true, "directTools:true must fail closed or be forced to false");

    // ENGRAM_BIN mismatch must fail closed instead of silently using mcp.json.
    const otherBin = join(sandbox, "other-engram");
    writeFileSync(otherBin, "other fake; never execute\n");
    chmodSync(otherBin, 0o755);
    writeFileSync(mcpPath, `${JSON.stringify({ mcpServers: { engram: validServer } }, null, 2)}\n`);
    const mismatched = await resolveMcpEngramConfig({
      resolveEngramBinary: () => otherBin,
      env: { HOME: join(sandbox, "home"), PI_CODING_AGENT_DIR: agentDir, ENGRAM_BIN: otherBin },
      platform: "linux",
      cwd: sandbox,
    });
    assert.ok(
      mismatched.state !== "managed" || mismatched.config.mcpServers.engram?.command === otherBin || mismatched.config.mcpServers.engram?.args?.includes(otherBin),
      "an explicit ENGRAM_BIN must take precedence over mcp.json command",
    );

    // Malformed mcp.json must fail closed, not fall back to a bundled factory.
    writeFileSync(mcpPath, "{ invalid json\n");
    const malformed = await resolveMcpEngramConfig({
      resolveEngramBinary: () => fakeBin,
      env: { HOME: join(sandbox, "home"), PI_CODING_AGENT_DIR: agentDir },
      platform: "linux",
      cwd: sandbox,
    });
    assert.ok(malformed.state === "failed" || malformed.context7?.state === "invalid", "malformed mcp.json must fail closed without fallback");
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("DevTools handoff keeps exact 1.6.0 flags (control)", async () => {
  const { resolveMcpEngramConfig } = await import("../extensions/mcp-engram.ts");
  const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-official-devtools-control-"));
  const agentDir = join(sandbox, "agent");
  const handoffPath = join(agentDir, "jorgex-pi", "devtools.v1.json");
  const fakeBin = join(sandbox, "engram");
  const pnpmPath = join(sandbox, "pnpm");
  mkdirSync(dirname(handoffPath), { recursive: true });
  writeFileSync(fakeBin, "fake binary; never execute\n");
  writeFileSync(pnpmPath, "fake pnpm; never execute\n");
  chmodSync(fakeBin, 0o755);
  chmodSync(pnpmPath, 0o755);
  writeFileSync(handoffPath, `${JSON.stringify({ schemaVersion: 1, enabled: true, command: pnpmPath, args: DEVTOOLS_ARGS })}\n`);
  try {
    const result = await resolveMcpEngramConfig({
      resolveEngramBinary: () => fakeBin,
      env: { PI_CODING_AGENT_DIR: agentDir },
    });
    assert.equal(result.state, "managed");
    assert.deepEqual(result.config.mcpServers["chrome-devtools"], {
      command: pnpmPath,
      args: DEVTOOLS_ARGS,
      lifecycle: "lazy",
      directTools: false,
    });
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("Context7 keeps canonical endpoint and never persists the secret (control)", async () => {
  const { resolveMcpEngramConfig } = await import("../extensions/mcp-engram.ts");
  const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-official-context7-control-"));
  const fakeBin = join(sandbox, "engram");
  writeFileSync(fakeBin, "fake binary; never execute\n");
  chmodSync(fakeBin, 0o755);
  try {
    const keyed = await resolveMcpEngramConfig({
      resolveEngramBinary: () => fakeBin,
      env: { HOME: join(sandbox, "home"), CONTEXT7_API_KEY: "fixture-context7-token" },
    });
    assert.equal(keyed.state, "managed");
    assert.equal(keyed.config.mcpServers.context7?.url, CANONICAL_CONTEXT7_URL);
    assert.deepEqual(keyed.config.mcpServers.context7?.headers, { CONTEXT7_API_KEY: "${CONTEXT7_API_KEY}" });
    assert.equal(JSON.stringify(keyed.config).includes("fixture-context7-token"), false, "the runtime key must never be persisted");
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});
