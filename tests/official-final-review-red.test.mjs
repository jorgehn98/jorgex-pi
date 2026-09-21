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

function makeEnv(agentDir, home, cwdExtra = {}) {
  return { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, ...cwdExtra };
}

function writeGlobalSettings(agentDir, raw) {
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), typeof raw === "string" ? raw : JSON.stringify(raw));
}

// 1) Total package gate: absent / {} / undeclared / empty / foreign-only => missing;
// valid pair => available; project duplicate => conflict.
test("final-review: official package gate is total (absent/{}-undeclared/empty/foreign-only missing)", async () => {
  const { inspectContext7Config } = await import("../extensions/context7-config.mjs");

  // Valid controls first (must stay green after fix).
  {
    const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-final-gate-valid-"));
    try {
      const agentDir = join(sandbox, "agent");
      const projectDir = join(sandbox, "project");
      mkdirSync(agentDir, { recursive: true });
      mkdirSync(projectDir, { recursive: true });
      const env = makeEnv(agentDir, join(sandbox, "home"));
      writeGlobalSettings(agentDir, { packages: [VALID_GENTLE, VALID_ADAPTER] });
      const valid = inspectContext7Config({ env, cwd: projectDir, platform: "linux" });
      assert.equal(valid.state, "available", "exactly one valid global gentle semver + adapter must pass");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  }
  {
    const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-final-gate-dup-"));
    try {
      const agentDir = join(sandbox, "agent");
      const projectDir = join(sandbox, "project");
      mkdirSync(agentDir, { recursive: true });
      mkdirSync(join(projectDir, ".pi"), { recursive: true });
      const env = makeEnv(agentDir, join(sandbox, "home"));
      writeGlobalSettings(agentDir, { packages: [VALID_GENTLE, VALID_ADAPTER] });
      writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ packages: [VALID_GENTLE] }));
      const dup = inspectContext7Config({ env, cwd: projectDir, platform: "linux" });
      assert.equal(dup.state, "conflict", "project duplicate must block");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  }
  {
    const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-final-gate-empty-"));
    try {
      const agentDir = join(sandbox, "agent");
      const projectDir = join(sandbox, "project");
      mkdirSync(agentDir, { recursive: true });
      mkdirSync(projectDir, { recursive: true });
      const env = makeEnv(agentDir, join(sandbox, "home"));
      writeGlobalSettings(agentDir, { packages: [] });
      const empty = inspectContext7Config({ env, cwd: projectDir, platform: "linux" });
      assert.equal(empty.state, "missing", "empty packages must return missing, not available");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  }

  // RED: absent settings must be missing, not available.
  {
    const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-final-gate-absent-"));
    try {
      const agentDir = join(sandbox, "agent");
      const projectDir = join(sandbox, "project");
      mkdirSync(agentDir, { recursive: true });
      mkdirSync(projectDir, { recursive: true });
      const env = makeEnv(agentDir, join(sandbox, "home"));
      const absent = inspectContext7Config({ env, cwd: projectDir, platform: "linux" });
      assert.equal(absent.state, "missing", "absent settings must return missing (total gate), not available");
      assert.equal(absent.source, "pi-global-settings");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  }

  // RED: present {} must be missing.
  {
    const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-final-gate-emptyobj-"));
    try {
      const agentDir = join(sandbox, "agent");
      const projectDir = join(sandbox, "project");
      mkdirSync(agentDir, { recursive: true });
      mkdirSync(projectDir, { recursive: true });
      const env = makeEnv(agentDir, join(sandbox, "home"));
      writeGlobalSettings(agentDir, {});
      const emptyObj = inspectContext7Config({ env, cwd: projectDir, platform: "linux" });
      assert.equal(emptyObj.state, "missing", "present {} must return missing, not available");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  }

  // RED: packages undeclared must be missing.
  {
    const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-final-gate-undeclared-"));
    try {
      const agentDir = join(sandbox, "agent");
      const projectDir = join(sandbox, "project");
      mkdirSync(agentDir, { recursive: true });
      mkdirSync(projectDir, { recursive: true });
      const env = makeEnv(agentDir, join(sandbox, "home"));
      writeGlobalSettings(agentDir, { other: true });
      const undeclared = inspectContext7Config({ env, cwd: projectDir, platform: "linux" });
      assert.equal(undeclared.state, "missing", "packages undeclared must return missing, not available");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  }

  // RED: foreign-only must be missing.
  {
    const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-final-gate-foreign-"));
    try {
      const agentDir = join(sandbox, "agent");
      const projectDir = join(sandbox, "project");
      mkdirSync(agentDir, { recursive: true });
      mkdirSync(projectDir, { recursive: true });
      const env = makeEnv(agentDir, join(sandbox, "home"));
      writeGlobalSettings(agentDir, { packages: ["npm:foreign@1.0.0"] });
      const foreign = inspectContext7Config({ env, cwd: projectDir, platform: "linux" });
      assert.equal(foreign.state, "missing", "foreign-only packages must return missing, not available");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  }
});

// 2) Any duplicate official package name blocks, including bare gentle + valid versioned gentle;
// malformed gentle stays missing when sole.
test("final-review: any duplicate official package name blocks (bare gentle + valid)", async () => {
  const { inspectContext7Config } = await import("../extensions/context7-config.mjs");
  const probe = (globalPackages) => {
    const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-final-dup-"));
    try {
      const agentDir = join(sandbox, "agent");
      const projectDir = join(sandbox, "project");
      mkdirSync(agentDir, { recursive: true });
      mkdirSync(projectDir, { recursive: true });
      const env = makeEnv(agentDir, join(sandbox, "home"));
      writeGlobalSettings(agentDir, { packages: globalPackages });
      return inspectContext7Config({ env, cwd: projectDir, platform: "linux" });
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  };

  // Valid controls (must stay green).
  const valid = probe([VALID_GENTLE, VALID_ADAPTER]);
  assert.equal(valid.state, "available", "single valid pair must stay available");
  const dupValid = probe([VALID_GENTLE, "npm:gentle-engram@0.1.14", VALID_ADAPTER]);
  assert.equal(dupValid.state, "conflict", "duplicate valid gentle must stay conflict");
  const malformedSole = probe(["npm:gentle-engram@not-a-version", VALID_ADAPTER]);
  assert.equal(malformedSole.state, "missing", "malformed gentle sole must stay missing");

  // RED: bare gentle + valid versioned gentle must block.
  const barePlusValid = probe(["npm:gentle-engram", VALID_GENTLE, VALID_ADAPTER]);
  assert.equal(barePlusValid.state, "conflict", "bare gentle + valid versioned gentle must block as duplicate official name");
});

// 3) Explicit ENGRAM_BIN non-executable throws/fails bridge, never degrades to managed.
test("final-review: explicit ENGRAM_BIN non-executable throws and fails bridge", async () => {
  const { resolveConfiguredEngramBinary, resolveMcpEngramConfig } = await import("../extensions/mcp-engram.ts");
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

  // Control: unset may use receipt per contract (must stay managed).
  {
    const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-final-bin-control-"));
    try {
      const home = join(sandbox, "home");
      const agentDir = join(home, "agent");
      mkdirSync(join(home, ".jorgex-stack"), { recursive: true });
      mkdirSync(agentDir, { recursive: true });
      const validBin = join(sandbox, "engram-valid");
      writeFileSync(validBin, "fake binary; never execute\n");
      chmodSync(validBin, 0o755);
      const receipt = {
        schemaVersion: 1,
        state: "installed",
        candidate: {
          package: { name: "jorgex-pi", source: `npm:jorgex-pi@${manifest.version}`, version: manifest.version },
          tarball: { bytes: 1, sha256: "a", sha512: "b" },
          provenance: { commit: "reviewed" },
        },
        scope: { kind: "real", codingAgentDir: agentDir },
        engram: { binary: validBin },
      };
      mkdirSync(join(home, ".jorgex-stack"), { recursive: true });
      writeFileSync(join(home, ".jorgex-stack", "pi-receipt.json"), `${JSON.stringify(receipt)}\n`);
      const env = { HOME: home, PI_CODING_AGENT_DIR: agentDir };
      const bridge = await resolveMcpEngramConfig({ env, platform: "linux", cwd: sandbox });
      assert.equal(bridge.state, "managed", "unset ENGRAM_BIN may use valid receipt per contract");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  }

  // RED: explicit non-executable must throw, not return undefined.
  {
    const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-final-bin-throw-"));
    try {
      const nonExec = join(sandbox, "engram-nonexec");
      writeFileSync(nonExec, "fake binary; never execute\n");
      chmodSync(nonExec, 0o644);
      assert.throws(
        () => resolveConfiguredEngramBinary({ env: { ENGRAM_BIN: nonExec }, platform: "linux" }),
        /executable|permission|ENGRAM_BIN/i,
        "explicit ENGRAM_BIN set but non-executable must throw",
      );
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  }

  // RED: non-executable explicit + valid receipt must fail bridge, never managed/mask receipt.
  {
    const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-final-bin-receipt-"));
    try {
      const home = join(sandbox, "home");
      const agentDir = join(home, "agent");
      mkdirSync(join(home, ".jorgex-stack"), { recursive: true });
      mkdirSync(agentDir, { recursive: true });
      const validBin = join(sandbox, "engram-valid");
      writeFileSync(validBin, "fake binary; never execute\n");
      chmodSync(validBin, 0o755);
      const nonExec = join(sandbox, "engram-nonexec");
      writeFileSync(nonExec, "fake binary; never execute\n");
      chmodSync(nonExec, 0o644);
      const receipt = {
        schemaVersion: 1,
        state: "installed",
        candidate: {
          package: { name: "jorgex-pi", source: `npm:jorgex-pi@${manifest.version}`, version: manifest.version },
          tarball: { bytes: 1, sha256: "a", sha512: "b" },
          provenance: { commit: "reviewed" },
        },
        scope: { kind: "real", codingAgentDir: agentDir },
        engram: { binary: validBin },
      };
      writeFileSync(join(home, ".jorgex-stack", "pi-receipt.json"), `${JSON.stringify(receipt)}\n`);
      const env = { HOME: home, PI_CODING_AGENT_DIR: agentDir, ENGRAM_BIN: nonExec };
      const bridge = await resolveMcpEngramConfig({ env, platform: "linux", cwd: sandbox });
      assert.equal(bridge.state, "failed", "non-executable explicit must fail bridge, never degrade to managed");
      assert.notEqual(bridge.config?.mcpServers?.engram?.command, validBin, "must never mask valid receipt when explicit is invalid");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  }

  // RED: non-executable explicit + valid official mcp.json must fail, never managed.
  {
    const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-final-bin-official-"));
    try {
      const agentDir = join(sandbox, "agent");
      mkdirSync(agentDir, { recursive: true });
      const validBin = join(sandbox, "engram-valid");
      writeFileSync(validBin, "fake binary; never execute\n");
      chmodSync(validBin, 0o755);
      const nonExec = join(sandbox, "engram-nonexec");
      writeFileSync(nonExec, "fake binary; never execute\n");
      chmodSync(nonExec, 0o644);
      writeFileSync(
        join(agentDir, "mcp.json"),
        `${JSON.stringify({ mcpServers: { engram: { command: validBin, args: ["mcp", "--tools=agent"], lifecycle: "lazy", directTools: false } } })}\n`,
      );
      const env = { HOME: join(sandbox, "home"), PI_CODING_AGENT_DIR: agentDir, ENGRAM_BIN: nonExec };
      const bridge = await resolveMcpEngramConfig({ env, platform: "linux", cwd: sandbox });
      assert.equal(bridge.state, "failed", "non-executable explicit must fail even with valid official command");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  }
});

// 4) Invalid/unreadable package-scope settings => failed bridge, never managed/advertised.
test("final-review: invalid package-scope settings fails bridge, unrelated MCP-scan stays scoped", async () => {
  const { resolveMcpEngramConfig } = await import("../extensions/mcp-engram.ts");

  const makeBin = (sandbox) => {
    const fakeBin = join(sandbox, "engram");
    writeFileSync(fakeBin, "fake binary; never execute\n");
    chmodSync(fakeBin, 0o755);
    return fakeBin;
  };

  // Control: unrelated MCP-scan invalid remains scoped (managed with diagnosis).
  {
    const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-final-scope-control-"));
    try {
      const agentDir = join(sandbox, "agent");
      const proj = join(sandbox, "proj");
      mkdirSync(agentDir, { recursive: true });
      mkdirSync(proj, { recursive: true });
      const fakeBin = makeBin(sandbox);
      writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ imports: ["codex"], mcpServers: {} }));
      const result = await resolveMcpEngramConfig({
        resolveEngramBinary: () => fakeBin,
        env: { HOME: join(sandbox, "home"), PI_CODING_AGENT_DIR: agentDir },
        platform: "linux",
        cwd: proj,
      });
      assert.equal(result.state, "managed", "unrelated MCP-scan invalid remains scoped managed behavior if approved");
      assert.equal(result.context7?.state, "invalid", "unrelated invalid stays diagnosable via context7");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  }

  // RED: malformed package-scope settings must fail bridge.
  {
    const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-final-scope-malformed-"));
    try {
      const agentDir = join(sandbox, "agent");
      const proj = join(sandbox, "proj");
      mkdirSync(agentDir, { recursive: true });
      mkdirSync(proj, { recursive: true });
      const fakeBin = makeBin(sandbox);
      writeFileSync(join(agentDir, "settings.json"), "{ invalid json\n");
      const result = await resolveMcpEngramConfig({
        resolveEngramBinary: () => fakeBin,
        env: { HOME: join(sandbox, "home"), PI_CODING_AGENT_DIR: agentDir },
        platform: "linux",
        cwd: proj,
      });
      assert.equal(result.state, "failed", "invalid package-scope settings must make bridge failed, never managed");
      assert.match(result.reason ?? result.context7?.code ?? "", /setting|invalid|unreadable|JSON/i);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  }

  // RED: invalid packages shape must fail bridge.
  {
    const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-final-scope-shape-"));
    try {
      const agentDir = join(sandbox, "agent");
      const proj = join(sandbox, "proj");
      mkdirSync(agentDir, { recursive: true });
      mkdirSync(proj, { recursive: true });
      const fakeBin = makeBin(sandbox);
      writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: "not-array" }));
      const result = await resolveMcpEngramConfig({
        resolveEngramBinary: () => fakeBin,
        env: { HOME: join(sandbox, "home"), PI_CODING_AGENT_DIR: agentDir },
        platform: "linux",
        cwd: proj,
      });
      assert.equal(result.state, "failed", "unreadable/invalid package-scope settings must never be managed/protocol-advertised");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  }
});

// Helpers for runtime tests: managed+available+definition only (never stale registered).
function managedAvailableBridge() {
  return {
    state: "managed",
    context7: { state: "available", source: "official-setup" },
    config: {
      mcpServers: {
        context7: { url: "https://mcp.context7.com/mcp", auth: false, lifecycle: "lazy", directTools: false },
        "chrome-devtools": {
          command: "/managed/bin/pnpm",
          args: ["dlx", "chrome-devtools-mcp@1.6.0", "--isolated", "--redact-network-headers", "--no-performance-crux", "--no-usage-statistics"],
          lifecycle: "lazy",
          directTools: false,
        },
      },
    },
  };
}

function createPiHarness() {
  const eventHandlers = new Map();
  const lifecycleHandlers = new Map();
  const tools = new Map();
  const emitted = [];
  let active = [];
  const add = (map, name, handler) => map.set(name, [...(map.get(name) ?? []), handler]);
  const events = {
    on: (name, handler) => add(eventHandlers, name, handler),
    emit: (name, payload) => {
      emitted.push({ name, payload });
      for (const handler of eventHandlers.get(name) ?? []) handler(payload);
      return payload?.result;
    },
  };
  return {
    api: {
      events,
      on: (name, handler) => add(lifecycleHandlers, name, handler),
      registerTool: (tool) => {
        tools.set(tool.name, tool);
        active = [...new Set([...active, tool.name])];
      },
      getActiveTools: () => [...active],
      setActiveTools: (names) => { active = [...names]; },
      getAllTools: () => [...tools.values()],
      registerFlag() {},
      registerCommand() {},
      sendMessage() {},
    },
    emitted: () => [...emitted],
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

function companionFactory(id) {
  return (pi) => {
    if (id === "permission") pi.on("tool_call", () => ({ block: true, reason: "permission handler decision" }));
    if (id === "ask") pi.registerTool({ name: "ask_user_question" });
    if (id === "subagents") {
      pi.registerTool({ name: "subagent" });
      pi.registerTool({ name: "subagent_wait" });
    }
    if (id === "web") {
      for (const name of ["web_search", "source_check", "fetch_content", "get_search_content"]) pi.registerTool({ name });
    }
  };
}

// 5) Runtime registration error notifications once PER session, sets clear on shutdown.
test("final-review: runtime error notifications occur once per session, sets clear on shutdown", async () => {
  const { createBootstrap } = await import("../extensions/bootstrap.ts");
  const pi = createPiHarness();
  pi.api.events.on(RUNTIME_REGISTER_EVENT, () => {});
  await createBootstrap({
    loadCompanion: async (id) => companionFactory(id),
    getPermissionsService: () => ({ ready: true }),
    detectWebAccessConflict: () => undefined,
    detectGoalConflict: () => undefined,
    readGoalConfig: () => ({ kind: "loaded" }),
    resolveMcpEngram: async () => managedAvailableBridge(),
  })(pi.api);

  const countErrors = (notes) => notes.filter(({ type }) => type === "error").length;

  // Session A first attempt notifies (managed+available+definition bootstrap, runtime absent => fail-closed).
  const notesA1 = [];
  const ctxA = { sessionId: "final-sess-A", ui: { notify: (message, type) => notesA1.push({ message, type }) } };
  await pi.emitLifecycle("session_start", {}, ctxA);
  await pi.emitLifecycle("before_agent_start", { systemPrompt: "Base." }, ctxA);
  assert.ok(countErrors(notesA1) >= 1, "session A must receive its failure notification");

  // Same session second attempt must not re-notify (once per session).
  const notesA2 = [];
  await pi.emitLifecycle("before_agent_start", { systemPrompt: "Base." }, { sessionId: "final-sess-A", ui: { notify: (m, t) => notesA2.push({ message: m, type: t }) } });
  assert.equal(countErrors(notesA2), 0, "same session must not re-notify");

  // RED: session B must receive its own failure notification after session A.
  const notesB = [];
  const ctxB = { sessionId: "final-sess-B", ui: { notify: (message, type) => notesB.push({ message, type }) } };
  await pi.emitLifecycle("session_start", {}, ctxB);
  await pi.emitLifecycle("before_agent_start", { systemPrompt: "Base." }, ctxB);
  assert.ok(countErrors(notesB) >= 1, "session B must receive its own failure notification (per-session, not closure-global)");

  // RED: sets clear on shutdown — same ID after shutdown must notify again.
  await pi.emitLifecycle("session_shutdown", {}, ctxA);
  const notesAAfter = [];
  const ctxAAfter = { sessionId: "final-sess-A", ui: { notify: (message, type) => notesAAfter.push({ message, type }) } };
  await pi.emitLifecycle("session_start", {}, ctxAAfter);
  await pi.emitLifecycle("before_agent_start", { systemPrompt: "Base." }, ctxAAfter);
  assert.ok(countErrors(notesAAfter) >= 1, "sets must clear on shutdown so restarted session notifies again");
});

// 6) Lock around stale context7.state==registered: only managed+available+definition before runtime attempt.
test("final-review: runtime bootstrap requires only managed+available+definition (no stale registered)", async () => {
  const { createBootstrap } = await import("../extensions/bootstrap.ts");

  // Control: managed+available+definition must attempt both runtime registrations.
  {
    const pi = createPiHarness();
    pi.api.events.on(RUNTIME_REGISTER_EVENT, (request) => {
      request.result = { ok: true, registration: { dispose: async () => {} } };
    });
    await createBootstrap({
      loadCompanion: async (id) => companionFactory(id),
      getPermissionsService: () => ({ ready: true }),
      detectWebAccessConflict: () => undefined,
      detectGoalConflict: () => undefined,
      readGoalConfig: () => ({ kind: "loaded" }),
      resolveMcpEngram: async () => managedAvailableBridge(),
    })(pi.api);
    const ctx = { sessionId: "final-lock-valid", ui: { notify() {} } };
    await pi.emitLifecycle("session_start", {}, ctx);
    const regs = pi.emitted().filter(({ name }) => name === RUNTIME_REGISTER_EVENT);
    assert.equal(regs.length, 2, "managed+available+definition must attempt both Context7 and DevTools");
    const prompt = await pi.emitLifecycle("before_agent_start", { systemPrompt: "Base." }, ctx);
    assert.match(prompt?.systemPrompt ?? "", /jorgex:context7/, "available+definition success must advertise Context7");
  }

  // RED: stale registered without definition must never count as bootstrap state.
  {
    const pi = createPiHarness();
    pi.api.events.on(RUNTIME_REGISTER_EVENT, (request) => {
      request.result = { ok: true, registration: { dispose: async () => {} } };
    });
    await createBootstrap({
      loadCompanion: async (id) => companionFactory(id),
      getPermissionsService: () => ({ ready: true }),
      detectWebAccessConflict: () => undefined,
      detectGoalConflict: () => undefined,
      readGoalConfig: () => ({ kind: "loaded" }),
      resolveMcpEngram: async () => ({ state: "managed", context7: { state: "registered", source: "stale" }, config: { mcpServers: {} } }),
    })(pi.api);
    const ctx = { sessionId: "final-lock-stale", ui: { notify() {} } };
    await pi.emitLifecycle("session_start", {}, ctx);
    const prompt = await pi.emitLifecycle("before_agent_start", { systemPrompt: "Base." }, ctx);
    assert.doesNotMatch(prompt?.systemPrompt ?? "", /jorgex:context7/, "stale registered without available+definition must not advertise Context7");
  }
});
