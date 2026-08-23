import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(testDir, "..");
const expected = JSON.parse(readFileSync(join(testDir, "fixtures", "bootstrap.expected.json"), "utf8"));
const companionToolNames = ["ask_user_question", "fetch_content", "get_search_content", "source_check", "subagent", "subagent_wait", "web_search"];

test("the root manifest activates only the JorgeX bootstrap and sixteen reviewed skills", () => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.deepEqual(manifest.pi, {
    extensions: [expected.extension],
    skills: expected.skills,
    prompts: [],
    themes: [],
  });
  assert.equal(manifest.pi.skills.some((path) => path.includes("playwright")), false);
  assert.equal(manifest.pi.skills.some((path) => path.includes("node_modules")), false, "upstream companion skills must stay inactive");
  assert.equal(manifest.pi.prompts.length, 0, "upstream companion prompts must stay inactive");
  assert.ok(manifest.files.includes("extensions"), "the published file allowlist must include the bootstrap extension");
});

test("the active companions and their audited closure are exactly pinned and bundled", () => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const dependencies = Object.fromEntries(expected.companions.map(({ name, version }) => [name, version]));
  assert.deepEqual(manifest.dependencies, dependencies);
  assert.deepEqual(manifest.bundledDependencies, expected.companions.map(({ name }) => name));
  const lock = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
  for (const dependency of expected.bundledClosure) assertLockIntegrity(lock, dependency);
});

test("bootstrap keeps its guard alive and companion tools hidden after load or factory failure", async () => {
  const { createBootstrap } = await import("../extensions/bootstrap.ts");
  assert.equal(typeof createBootstrap, "function", "bootstrap must expose its deterministic loader seam");

  const companionIds = expected.companions.map(({ id }) => id);
  for (const failedId of companionIds) {
    const pi = createPiHarness();
    const loadOrder = [];
    const injected = new Error(`injected ${failedId} load failure`);
    const bootstrap = createBootstrap({
      async loadCompanion(id) {
        loadOrder.push(id);
        if (id === failedId) throw injected;
        return companionFactory(id);
      },
      getPermissionsService: () => ({ ready: true }),
    });
    await bootstrap(pi.api);
    assert.deepEqual(loadOrder.slice(0, companionIds.indexOf(failedId) + 1), companionIds.slice(0, companionIds.indexOf(failedId) + 1));
    const notifications = [];
    const failedContext = {
      sessionId: "failed",
      ui: { notify: (message, type) => notifications.push({ message, type }) },
    };
    await pi.emitLifecycle("session_start", {}, failedContext);
    assert.deepEqual(pi.activeTools(), [], `${failedId} load failure must hide every partial companion tool at session start`);
    assert.equal(notifications.length, 1, `${failedId} load failure must be diagnosed at session start`);
    assert.equal(notifications[0].type, "error");
    assert.match(notifications[0].message, /load/i);
    assert.match(notifications[0].message, new RegExp(failedId));
    assert.match(notifications[0].message, new RegExp(`injected ${failedId} load failure`));
    await pi.emitLifecycle("session_start", {}, failedContext);
    assert.equal(notifications.length, 1, `${failedId} load failure must be diagnosed exactly once`);
    assertEarlyGuard(await pi.emitToolCall({ toolName: "bash", input: { command: "echo must-not-run" } }, { sessionId: "failed" }));
  }

  const pi = createPiHarness();
  const initOrder = [];
  const injected = new Error("injected web factory failure");
  const bootstrap = createBootstrap({
    async loadCompanion(id) {
      if (id === "web") return () => { initOrder.push(id); throw injected; };
      return companionFactory(id, initOrder);
    },
    getPermissionsService: () => ({ ready: true }),
  });
  await bootstrap(pi.api);
  assert.deepEqual(initOrder, companionIds, "factory initialization must preserve the reviewed companion order");
  assert.ok(pi.toolNames().includes("ask_user_question"), "the fixture must reach a partial companion registration before the injected throw");
  const notifications = [];
  const failedContext = {
    sessionId: "failed",
    ui: { notify: (message, type) => notifications.push({ message, type }) },
  };
  await pi.emitLifecycle("session_start", {}, failedContext);
  assert.deepEqual(pi.activeTools(), [], "a factory failure must hide partially registered companion tools at session start");
  assert.equal(notifications.length, 1, "the session must expose the retained bootstrap failure exactly once");
  assert.equal(notifications[0].type, "error", "a companion bootstrap failure must be surfaced as an error");
  assert.match(notifications[0].message, /factory/i, "the diagnostic must identify the factory phase");
  assert.match(notifications[0].message, /web/i, "the diagnostic must identify the failing companion");
  assert.match(notifications[0].message, /injected web factory failure/, "the diagnostic must retain the original cause");
  await pi.emitLifecycle("session_start", {}, failedContext);
  assert.equal(notifications.length, 1, "later session starts must not duplicate the retained bootstrap failure");
  assertEarlyGuard(await pi.emitToolCall({ toolName: "bash", input: { command: "echo still-must-not-run" } }, { sessionId: "failed" }));
});

test("companion tools stay session-gated until permissions are ready and headless ask stays unavailable", async () => {
  const { createBootstrap } = await import("../extensions/bootstrap.ts");
  const pi = createPiHarness();
  const initOrder = [];
  const services = new Map();
  const bootstrap = createBootstrap({
    async loadCompanion(id) {
      return companionFactory(id, initOrder);
    },
    getPermissionsService: (sessionId) => services.get(sessionId),
  });

  await bootstrap(pi.api);
  assert.deepEqual(initOrder, expected.companions.map(({ id }) => id), "all companions must register session handlers during bootstrap");
  assert.deepEqual(pi.toolNames(), companionToolNames, "the fixture must register the complete upstream companion tool set");
  await pi.emitLifecycle("session_start", {}, { hasUI: true, sessionId: "session-a", ui: { notify() {} } });
  assertEarlyGuard(await pi.emitToolCall({ toolName: "bash", input: { command: "echo must-not-run" } }, { sessionId: "session-a" }));

  await pi.emitLifecycle("before_agent_start", {}, { hasUI: true, sessionId: "session-a" });
  assert.deepEqual(pi.activeTools(), [], "the first prompt without permission health must hide every companion tool");
  await pi.emitEvent("permissions:ready", { sessionId: "session-a" });
  await pi.emitLifecycle("before_agent_start", {}, { hasUI: true, sessionId: "session-a" });
  assert.deepEqual(pi.activeTools(), [], "a ready event without its keyed service must fail closed");
  services.set("session-a", { ready: true });
  await pi.emitEvent("permissions:ready", { sessionId: "session-a" });
  await pi.emitLifecycle("before_agent_start", {}, { hasUI: true, sessionId: "session-a" });
  assert.deepEqual(pi.activeTools(), [], "readiness after a pre-health prompt must not auto-restore hidden companion tools");
  assert.deepEqual(
    await pi.emitToolCall({ toolName: "bash", input: { command: "echo permission-decides" } }, { sessionId: "session-a" }),
    { block: true, reason: "permission handler decision" },
    "after health the bootstrap guard must defer to the permission-system handler",
  );

  pi.api.setActiveTools(companionToolNames);
  await pi.emitLifecycle("before_agent_start", {}, { hasUI: false, sessionId: "session-a" });
  assert.deepEqual(pi.activeTools(), ["fetch_content", "get_search_content", "source_check", "subagent", "subagent_wait", "web_search"], "headless sessions must not expose ask_user_question or synthesize an answer");

  pi.api.setActiveTools(["ask_user_question"]);
  await pi.emitEvent("permissions:ready", { sessionId: "session-a" });
  await pi.emitLifecycle("before_agent_start", {}, { hasUI: true, sessionId: "session-a" });
  assert.deepEqual(pi.activeTools(), ["ask_user_question"], "repeated ready must not reactivate a companion tool disabled by the user");

  await pi.emitLifecycle("session_shutdown", {}, { sessionId: "session-a" });
  assert.deepEqual(pi.activeTools(), [], "session shutdown must hide companion tools again");
  assertEarlyGuard(await pi.emitToolCall({ toolName: "bash", input: { command: "echo must-not-run" } }, { sessionId: "session-a" }));
});

test("first permission readiness preserves the current companion selection without union-reactivating tools", async () => {
  const { createBootstrap } = await import("../extensions/bootstrap.ts");

  const selectedPi = createPiHarness();
  const selectedServices = new Map();
  await createBootstrap({
    loadCompanion: async (id) => companionFactory(id),
    getPermissionsService: (sessionId) => selectedServices.get(sessionId),
  })(selectedPi.api);
  const selectedContext = { hasUI: true, sessionId: "selected" };
  await selectedPi.emitLifecycle("session_start", {}, selectedContext);
  const withoutWebSearch = companionToolNames.filter((name) => name !== "web_search");
  selectedPi.api.setActiveTools(withoutWebSearch);
  selectedServices.set(selectedContext.sessionId, { ready: true });
  await selectedPi.emitEvent("permissions:ready", { sessionId: selectedContext.sessionId });
  await selectedPi.emitLifecycle("before_agent_start", {}, selectedContext);
  assert.deepEqual(selectedPi.activeTools(), withoutWebSearch, "first readiness must not re-add a companion tool disabled by the user");

  const defaultPi = createPiHarness();
  const defaultServices = new Map();
  await createBootstrap({
    loadCompanion: async (id) => companionFactory(id),
    getPermissionsService: (sessionId) => defaultServices.get(sessionId),
  })(defaultPi.api);
  const defaultContext = { hasUI: true, sessionId: "default" };
  assert.deepEqual(defaultPi.activeTools(), companionToolNames, "companion factories must register the normal initial tool selection");
  await defaultPi.emitLifecycle("session_start", {}, defaultContext);
  defaultServices.set(defaultContext.sessionId, { ready: true });
  await defaultPi.emitEvent("permissions:ready", { sessionId: defaultContext.sessionId });
  await defaultPi.emitLifecycle("before_agent_start", {}, defaultContext);
  assert.deepEqual(defaultPi.activeTools(), companionToolNames, "normal readiness before the first prompt must preserve already-active tools");
});

test("a selection changed after a pre-health prompt remains authoritative at first readiness", async () => {
  const { createBootstrap } = await import("../extensions/bootstrap.ts");
  const pi = createPiHarness();
  const services = new Map();
  await createBootstrap({
    loadCompanion: async (id) => companionFactory(id),
    getPermissionsService: (sessionId) => services.get(sessionId),
  })(pi.api);
  const context = { hasUI: true, sessionId: "changed-after-hide" };
  await pi.emitLifecycle("session_start", {}, context);
  await pi.emitLifecycle("before_agent_start", {}, context);
  assert.deepEqual(pi.activeTools(), [], "the pre-health prompt must hide companion tools");

  const withoutWebSearch = companionToolNames.filter((name) => name !== "web_search");
  pi.api.setActiveTools(withoutWebSearch);
  services.set(context.sessionId, { ready: true });
  await pi.emitEvent("permissions:ready", { sessionId: context.sessionId });
  await pi.emitLifecycle("before_agent_start", {}, context);
  assert.deepEqual(pi.activeTools(), withoutWebSearch, "first readiness must not restore a tool disabled after the pre-health hide");
});

for (const directInstall of [
  { label: "global pinned string", scope: "global", entry: "npm:pi-web-access@0.24.1" },
  { label: "project unpinned string", scope: "project", entry: "npm:pi-web-access" },
  { label: "project object source", scope: "project", entry: { source: "npm:pi-web-access@0.24.1", extensions: ["index.ts"] } },
]) {
  test(`direct pi-web-access conflict fails closed for ${directInstall.label}`, async () => {
    const { createBootstrap, detectWebAccessConflict } = await import("../extensions/bootstrap.ts");
    assert.equal(typeof detectWebAccessConflict, "function", "bootstrap must export its production settings detector seam");
    const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-web-conflict-"));
    const globalSettingsPath = join(sandbox, "agent", "settings.json");
    const projectSettingsPath = join(sandbox, "project", ".pi", "settings.json");
    const globalBytes = JSON.stringify({ packages: [directInstall.scope === "global" ? directInstall.entry : "npm:foreign-global@1.0.0"], foreign: { keep: true } }, null, 2) + "\n";
    const projectBytes = JSON.stringify({ packages: [directInstall.scope === "project" ? directInstall.entry : "npm:foreign-project@1.0.0"], local: { keep: true } }, null, 2) + "\n";
    mkdirSync(dirname(globalSettingsPath), { recursive: true });
    mkdirSync(dirname(projectSettingsPath), { recursive: true });
    writeFileSync(globalSettingsPath, globalBytes);
    writeFileSync(projectSettingsPath, projectBytes);

    try {
      const detector = () => detectWebAccessConflict({ globalSettingsPath, projectSettingsPath });
      const conflict = detector();
      assert.equal(conflict?.packageName, "pi-web-access");
      assert.equal(conflict?.scope, directInstall.scope);

      const pi = createPiHarness();
      await createBootstrap({
        loadCompanion: async (id) => companionFactory(id),
        getPermissionsService: () => ({ ready: true }),
        detectWebAccessConflict: detector,
      })(pi.api);
      const notifications = [];
      const context = { sessionId: `conflict-${directInstall.scope}`, ui: { notify: (message, type) => notifications.push({ message, type }) } };
      await pi.emitLifecycle("session_start", {}, context);
      await pi.emitEvent("permissions:ready", { sessionId: context.sessionId });
      await pi.emitLifecycle("before_agent_start", {}, context);
      assert.deepEqual(pi.activeTools(), [], "a direct duplicate install must keep companion tools hidden even after permission readiness");
      assertEarlyGuard(await pi.emitToolCall({ toolName: "web_search", input: { query: "must not run" } }, context));
      assert.equal(notifications.length, 1, "the direct-install conflict must be diagnosed once");
      assert.equal(notifications[0].type, "error");
      assert.match(notifications[0].message, /direct|duplicate|settings/i);
      assert.match(notifications[0].message, /pi-web-access/);
      await pi.emitLifecycle("session_start", {}, context);
      assert.equal(notifications.length, 1, "later session starts must not duplicate the conflict diagnostic");
      assert.equal(readFileSync(globalSettingsPath, "utf8"), globalBytes, "conflict detection must not rewrite global settings");
      assert.equal(readFileSync(projectSettingsPath, "utf8"), projectBytes, "conflict detection must not rewrite project settings");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
}

test("a detected direct-install conflict stays latched until the bootstrap is reloaded", async () => {
  const { createBootstrap, detectWebAccessConflict } = await import("../extensions/bootstrap.ts");
  const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-web-conflict-latch-"));
  const globalSettingsPath = join(sandbox, "agent", "settings.json");
  const projectSettingsPath = join(sandbox, "project", ".pi", "settings.json");
  const conflictingBytes = JSON.stringify({ packages: ["npm:pi-web-access@0.24.1"] }, null, 2) + "\n";
  const cleanBytes = JSON.stringify({ packages: ["npm:foreign-global@1.0.0"] }, null, 2) + "\n";
  mkdirSync(dirname(globalSettingsPath), { recursive: true });
  mkdirSync(dirname(projectSettingsPath), { recursive: true });
  writeFileSync(globalSettingsPath, conflictingBytes);
  writeFileSync(projectSettingsPath, '{"packages":[]}\n');

  try {
    const detector = () => detectWebAccessConflict({ globalSettingsPath, projectSettingsPath });
    const pi = createPiHarness();
    await createBootstrap({
      loadCompanion: async (id) => companionFactory(id),
      getPermissionsService: () => ({ ready: true }),
      detectWebAccessConflict: detector,
    })(pi.api);
    const notifications = [];
    const firstContext = { sessionId: "conflict-a", ui: { notify: (message, type) => notifications.push({ message, type }) } };
    await pi.emitLifecycle("session_start", {}, firstContext);
    assertEarlyGuard(await pi.emitToolCall({ toolName: "web_search", input: { query: "blocked-a" } }, firstContext));
    assert.equal(notifications.length, 1, "the initial conflict must be diagnosed once");

    writeFileSync(globalSettingsPath, cleanBytes);
    pi.api.setActiveTools(companionToolNames);
    const secondContext = { sessionId: "conflict-b", ui: firstContext.ui };
    await pi.emitLifecycle("session_start", {}, secondContext);
    await pi.emitEvent("permissions:ready", { sessionId: secondContext.sessionId });
    await pi.emitLifecycle("before_agent_start", {}, secondContext);
    assertEarlyGuard(await pi.emitToolCall({ toolName: "web_search", input: { query: "blocked-b" } }, secondContext));
    assert.deepEqual(pi.activeTools(), [], "cleaning settings in-process must not release tools after a latched conflict");
    assert.equal(notifications.length, 1, "the latched conflict must retain the original single diagnostic");
    assert.equal(readFileSync(globalSettingsPath, "utf8"), cleanBytes, "latching must not rewrite the user's cleaned settings");
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

function companionFactory(id, initOrder = []) {
  return (pi) => {
    initOrder.push(id);
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

function createPiHarness() {
  const eventHandlers = new Map();
  const lifecycleHandlers = new Map();
  const tools = new Map();
  let active = [];
  const add = (map, name, handler) => map.set(name, [...(map.get(name) ?? []), handler]);
  return {
    api: {
      events: { on: (name, handler) => add(eventHandlers, name, handler) },
      on: (name, handler) => add(lifecycleHandlers, name, handler),
      registerTool(tool) { tools.set(tool.name, tool); active = [...new Set([...active, tool.name])]; },
      getActiveTools: () => [...active],
      setActiveTools: (names) => { active = [...names]; },
    },
    toolNames: () => [...tools.keys()].sort(),
    activeTools: () => [...active].sort(),
    async emitEvent(name, payload) { for (const handler of eventHandlers.get(name) ?? []) await handler(payload); },
    async emitLifecycle(name, event, ctx) { for (const handler of lifecycleHandlers.get(name) ?? []) await handler(event, ctx); },
    async emitToolCall(event, ctx) {
      let result;
      for (const handler of lifecycleHandlers.get("tool_call") ?? []) {
        const current = await handler(event, ctx);
        if (current !== undefined) result = current;
        if (current?.block) return current;
      }
      return result;
    },
  };
}

function assertEarlyGuard(result) {
  assert.equal(result?.block, true, "the bootstrap must block even foreign privileged tools before session health");
  assert.equal(result?.terminate, true, "the early health guard must terminate instead of allowing an unguarded retry");
}

function assertLockIntegrity(lock, dependency) {
  const escaped = `${dependency.name}@${dependency.version}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const block = new RegExp(`^  ['\"]?${escaped}['\"]?:\\n([\\s\\S]*?)(?=^  \\S|^snapshots:)`, "m").exec(lock)?.[1];
  assert.ok(block, `pnpm lock must contain ${dependency.name}@${dependency.version}`);
  assert.ok(block.includes(`integrity: ${dependency.integrity}`), `${dependency.name}@${dependency.version} integrity must match the audited artifact`);
}
