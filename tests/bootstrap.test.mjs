import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(testDir, "..");
const expected = JSON.parse(readFileSync(join(testDir, "fixtures", "bootstrap.expected.json"), "utf8"));

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

test("the three companions and their audited closure are exactly pinned and bundled", () => {
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
    assert.deepEqual(pi.activeTools(), [], `${failedId} load failure must leave every partial companion tool hidden`);
    assertEarlyGuard(await pi.emitToolCall({ toolName: "bash", input: { command: "echo must-not-run" } }, { sessionId: "failed" }));
  }

  const pi = createPiHarness();
  const initOrder = [];
  const injected = new Error("injected subagents factory failure");
  const bootstrap = createBootstrap({
    async loadCompanion(id) {
      if (id === "subagents") return () => { initOrder.push(id); throw injected; };
      return companionFactory(id, initOrder);
    },
    getPermissionsService: () => ({ ready: true }),
  });
  await bootstrap(pi.api);
  assert.deepEqual(initOrder, ["permission", "ask", "subagents"], "factory initialization must preserve permission → ask → subagents order");
  assert.ok(pi.toolNames().includes("ask_user_question"), "the fixture must reach a partial companion registration before the injected throw");
  assert.deepEqual(pi.activeTools(), [], "a factory failure must hide partially registered companion tools");
  assertEarlyGuard(await pi.emitToolCall({ toolName: "bash", input: { command: "echo must-not-run" } }, { sessionId: "failed" }));
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
  assert.deepEqual(initOrder, ["permission", "ask", "subagents"], "all companions must register session handlers during bootstrap");
  assert.deepEqual(pi.activeTools(), [], "registered companion tools must remain hidden before session health");
  assertEarlyGuard(await pi.emitToolCall({ toolName: "bash", input: { command: "echo must-not-run" } }, { sessionId: "session-a" }));

  await pi.emitEvent("permissions:ready", { sessionId: "session-a" });
  assert.deepEqual(pi.activeTools(), [], "a ready event without its keyed service must fail closed");
  services.set("session-a", { ready: true });
  await pi.emitEvent("permissions:ready", { sessionId: "session-a" });
  assert.deepEqual(pi.activeTools(), ["ask_user_question", "subagent"]);
  assert.deepEqual(
    await pi.emitToolCall({ toolName: "bash", input: { command: "echo permission-decides" } }, { sessionId: "session-a" }),
    { block: true, reason: "permission handler decision" },
    "after health the bootstrap guard must defer to the permission-system handler",
  );

  await pi.emitLifecycle("before_agent_start", {}, { hasUI: false, sessionId: "session-a" });
  assert.deepEqual(pi.activeTools(), ["subagent"], "headless sessions must not expose ask_user_question or synthesize an answer");

  pi.api.setActiveTools(["ask_user_question"]);
  await pi.emitEvent("permissions:ready", { sessionId: "session-a" });
  assert.deepEqual(pi.activeTools(), ["ask_user_question"], "repeated ready must not reactivate a companion tool disabled by the user");

  await pi.emitLifecycle("session_shutdown", {}, { sessionId: "session-a" });
  assert.deepEqual(pi.activeTools(), [], "session shutdown must hide companion tools again");
  assertEarlyGuard(await pi.emitToolCall({ toolName: "bash", input: { command: "echo must-not-run" } }, { sessionId: "session-a" }));
});

function companionFactory(id, initOrder = []) {
  return (pi) => {
    initOrder.push(id);
    if (id === "permission") pi.on("tool_call", () => ({ block: true, reason: "permission handler decision" }));
    if (id === "ask") pi.registerTool({ name: "ask_user_question" });
    if (id === "subagents") pi.registerTool({ name: "subagent" });
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
