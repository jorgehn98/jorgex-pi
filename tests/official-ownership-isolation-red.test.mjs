import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(testDir, "..");

const VALID_GENTLE = "npm:gentle-engram@0.1.13";
const VALID_ADAPTER = "npm:pi-mcp-adapter@2.36.0";
const RUNTIME_REGISTER_EVENT = "pi-mcp-adapter:runtime-register:v1";

function makeBridgeSandbox({ globalPackages, withMcp = true, withContext7Conflict = false }) {
  const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-t33-"));
  const home = join(sandbox, "home");
  const agentDir = join(sandbox, "agent");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(home, { recursive: true });
  const fakeBin = join(sandbox, "engram");
  writeFileSync(fakeBin, "fake binary; never execute\n");
  chmodSync(fakeBin, 0o755);
  writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify({ packages: globalPackages }, null, 2)}\n`);
  if (withMcp) {
    writeFileSync(
      join(agentDir, "mcp.json"),
      `${JSON.stringify({ mcpServers: { engram: { command: fakeBin, args: ["mcp", "--tools=agent"], lifecycle: "lazy", directTools: false } } }, null, 2)}\n`,
    );
  }
  if (withContext7Conflict) {
    const conflictDir = join(home, ".config", "mcp");
    mkdirSync(conflictDir, { recursive: true });
    writeFileSync(
      join(conflictDir, "mcp.json"),
      `${JSON.stringify({ mcpServers: { context7: { url: "https://mcp.context7.com/mcp" } } }, null, 2)}\n`,
    );
  }
  return { sandbox, home, agentDir, fakeBin };
}

function createPiHarness() {
  const eventHandlers = new Map();
  const lifecycleHandlers = new Map();
  const add = (map, name, handler) => map.set(name, [...(map.get(name) ?? []), handler]);
  return {
    api: {
      events: {
        on: (name, handler) => add(eventHandlers, name, handler),
        emit: (name, payload) => {
          for (const handler of eventHandlers.get(name) ?? []) handler(payload);
          return payload?.result;
        },
      },
      on: (name, handler) => add(lifecycleHandlers, name, handler),
      registerTool() {},
      getActiveTools: () => [],
      setActiveTools() {},
      getAllTools: () => [],
      registerFlag() {},
      registerCommand() {},
      sendMessage() {},
    },
    async emitLifecycle(name, event, ctx) {
      let result;
      for (const handler of lifecycleHandlers.get(name) ?? []) {
        const current = await handler(event, ctx);
        if (current !== undefined) result = current;
      }
      return result;
    },
  };
}

function companionFactory() {
  return () => {};
}

// Missing official pair must block managed even with a valid official mcp.json;
// a valid mcp.json never compensates absent packages. Also covers the masked
// case where an independent Context7 conflict would otherwise hide the missing
// gate (package state is evaluated aparte).
test("T33: missing official packages blocks managed even with valid mcp.json and independent Context7 conflict", async () => {
  const { resolveMcpEngramConfig } = await import("../extensions/mcp-engram.ts");
  const { inspectContext7Config } = await import("../extensions/context7-config.mjs");

  // Plain missing + valid mcp.json.
  {
    const { sandbox, home, agentDir, fakeBin } = makeBridgeSandbox({ globalPackages: [] });
    try {
      const bridge = await resolveMcpEngramConfig({
        resolveEngramBinary: () => fakeBin,
        env: { HOME: home, PI_CODING_AGENT_DIR: agentDir },
        platform: "linux",
        cwd: sandbox,
      });
      assert.notEqual(bridge.state, "managed", "missing official pair + valid mcp.json must not resolve managed");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  }

  // Missing masked by an independent Context7 conflict must still block.
  {
    const { sandbox, home, agentDir, fakeBin } = makeBridgeSandbox({ globalPackages: [], withContext7Conflict: true });
    try {
      const inspection = inspectContext7Config({ env: { HOME: home, PI_CODING_AGENT_DIR: agentDir }, cwd: sandbox, platform: "linux" });
      assert.equal(inspection.state, "conflict", "fixture must carry the independent Context7 conflict");
      const bridge = await resolveMcpEngramConfig({
        resolveEngramBinary: () => fakeBin,
        env: { HOME: home, PI_CODING_AGENT_DIR: agentDir },
        platform: "linux",
        cwd: sandbox,
      });
      assert.notEqual(bridge.state, "managed", "missing pair masked by Context7 conflict must still not resolve managed");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  }
});

// Duplicate official pair must block managed even with a valid official
// mcp.json and even when Context7 carries an independent conflict.
test("T33: duplicate official packages blocks managed even with valid mcp.json and independent Context7 conflict", async () => {
  const { resolveMcpEngramConfig } = await import("../extensions/mcp-engram.ts");
  const { sandbox, home, agentDir, fakeBin } = makeBridgeSandbox({
    globalPackages: [VALID_GENTLE, "npm:gentle-engram@0.1.14", VALID_ADAPTER],
    withContext7Conflict: true,
  });
  try {
    const bridge = await resolveMcpEngramConfig({
      resolveEngramBinary: () => fakeBin,
      env: { HOME: home, PI_CODING_AGENT_DIR: agentDir },
      platform: "linux",
      cwd: sandbox,
    });
    assert.notEqual(bridge.state, "managed", "duplicate official pair + valid mcp.json + Context7 conflict must not resolve managed");
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

// Missing setup must name the official MCP/setup remedy, never a missing binary.
test("T33: missing bridge reason names official MCP/setup remedy, not missing binary", async () => {
  const { resolveMcpEngramConfig } = await import("../extensions/mcp-engram.ts");
  const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-t33-missing-"));
  const agentDir = join(sandbox, "agent");
  mkdirSync(agentDir, { recursive: true });
  const fakeBin = join(sandbox, "engram");
  writeFileSync(fakeBin, "fake binary; never execute\n");
  chmodSync(fakeBin, 0o755);
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [VALID_GENTLE, VALID_ADAPTER] }));
  try {
    const bridge = await resolveMcpEngramConfig({
      resolveEngramBinary: () => fakeBin,
      env: { HOME: join(sandbox, "home"), PI_CODING_AGENT_DIR: agentDir },
      platform: "linux",
      cwd: sandbox,
    });
    assert.equal(bridge.state, "missing", "absent official server must stay missing");
    assert.match(bridge.reason ?? "", /engram setup pi|official.*mcp|mcp\.json/i, "missing bridge reason must name the official MCP/setup remedy");
    assert.doesNotMatch(bridge.reason ?? "", /binary was not found/i, "missing reason must not claim a missing binary");
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("T33: missing bootstrap notification names official setup remedy, not missing binary", async () => {
  const { createBootstrap } = await import("../extensions/bootstrap.ts");
  const pi = createPiHarness();
  await createBootstrap({
    loadCompanion: async () => companionFactory(),
    getPermissionsService: () => ({ ready: true }),
    detectWebAccessConflict: () => undefined,
    detectGoalConflict: () => undefined,
    readGoalConfig: () => ({ kind: "loaded" }),
    resolveMcpEngram: async () => ({
      state: "missing",
      config: { mcpServers: {} },
      context7: { state: "missing", source: "pi-global-settings", code: "missing-official-packages" },
      reason: "official Engram MCP setup is missing; run `engram setup pi` and reload Pi",
    }),
  })(pi.api);
  const notifications = [];
  const ctx = { sessionId: "t33-missing", ui: { notify: (message, type) => notifications.push({ message, type }) } };
  await pi.emitLifecycle("session_start", {}, ctx);
  const error = notifications.find(({ type }) => type === "error");
  assert.ok(error, "missing setup must notify fail-closed");
  assert.match(error.message ?? "", /engram setup pi|official.*(MCP|setup)|reload Pi/i, "missing notification must name the official setup remedy");
  assert.doesNotMatch(error.message ?? "", /binary was not found/i, "missing notification must not claim a missing binary");
});

// Failed dispose on session_shutdown must use the existing UI error channel
// with a bounded reason while keeping the handle retryable.
test("T33: failed dispose on shutdown notifies bounded error while retaining retry", async () => {
  const { createBootstrap } = await import("../extensions/bootstrap.ts");
  const pi = createPiHarness();
  const longTail = "x".repeat(300);
  const injected = `injected dispose failure: boom-${longTail}`;
  let disposeCalls = 0;
  pi.api.events.on(RUNTIME_REGISTER_EVENT, (request) => {
    request.result = {
      ok: true,
      registration: {
        dispose: async () => {
          disposeCalls += 1;
          throw new Error(injected);
        },
      },
    };
  });
  await createBootstrap({
    loadCompanion: async () => companionFactory(),
    getPermissionsService: () => ({ ready: true }),
    detectWebAccessConflict: () => undefined,
    detectGoalConflict: () => undefined,
    readGoalConfig: () => ({ kind: "loaded" }),
    resolveMcpEngram: async () => ({
      state: "managed",
      context7: { state: "available", source: "official-setup" },
      config: {
        mcpServers: {
          context7: { url: "https://mcp.context7.com/mcp", lifecycle: "lazy", directTools: false },
          "chrome-devtools": {
            command: "/managed/bin/pnpm",
            args: ["dlx", "chrome-devtools-mcp@1.6.0", "--isolated", "--redact-network-headers", "--no-performance-crux", "--no-usage-statistics"],
            lifecycle: "lazy",
            directTools: false,
          },
        },
      },
    }),
  })(pi.api);

  await pi.emitLifecycle("session_start", {}, { sessionId: "t33-dispose", ui: { notify() {} } });
  assert.equal(disposeCalls, 0, "start must register without disposing");

  const shutdownNotes = [];
  await pi.emitLifecycle("session_shutdown", {}, { sessionId: "t33-dispose", ui: { notify: (message, type) => shutdownNotes.push({ message, type }) } });
  assert.equal(disposeCalls, 2, "first shutdown must attempt both runtime disposes");
  const error = shutdownNotes.find(({ type }) => type === "error");
  assert.ok(error, "failed dispose must produce the existing UI error notification on shutdown");
  assert.match(error.message ?? "", /injected dispose failure|dispose failed/i, "shutdown notification must carry the bounded dispose reason");
  assert.ok((error.message ?? "").length < injected.length + 200, "shutdown reason must stay bounded instead of echoing the full failure");
  assert.equal((error.message ?? "").includes(longTail), false, "bounded reason must not echo the full overlong failure");

  const callsAfterFirst = disposeCalls;
  await pi.emitLifecycle("session_shutdown", {}, { sessionId: "t33-dispose", ui: { notify() {} } });
  assert.equal(disposeCalls, callsAfterFirst + 2, "failed dispose must retain its retryable handle for the next shutdown");
});

// setupRealSandbox --version preflight must not inherit the personal
// environment: it runs with isolated env/cwd. Source regression only, never
// touches real HOME.
test("T33: setupRealSandbox version preflight runs with isolated env/cwd", async () => {
  const smokeSource = readFileSync(join(root, "tests", "official-engram-smoke.test.mjs"), "utf8");
  const marker = '["--version"]';
  const at = smokeSource.indexOf(marker);
  assert.notEqual(at, -1, "smoke harness must keep the engram --version preflight");
  const window = smokeSource.slice(at, at + 800);
  assert.match(window, /env\s*:/, "preflight must pass an isolated env (no inherited HOME)");
  assert.match(window, /cwd\s*:/, "preflight must pass an isolated cwd (no inherited workdir)");
  assert.match(window, /HOME/, "isolated env must scope HOME to the sandbox");
  assert.match(window, /PI_CODING_AGENT_DIR|agentDir/, "isolated env must scope the agent dir to the sandbox");
});
