import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(testDir, "..");
const expected = readJson(join(testDir, "fixtures", "goal.expected.json"));
const foundationTools = ["ask_user_question", "fetch_content", "get_search_content", "source_check", "subagent", "subagent_wait", "web_search"];

test("pi-goal 0.53.0 is the exact active bundled companion with its audited four-package closure", () => {
  const manifest = readJson(join(root, "package.json"));
  assert.equal(manifest.dependencies?.[expected.companion.name], expected.companion.version);
  assert.equal(manifest.bundledDependencies?.includes(expected.companion.name), true);

  const component = readJson(join(root, "contract", "components.v1.json")).components
    .find(({ name }) => name === expected.companion.name);
  assert.deepEqual(
    { status: component?.status, version: component?.version, integrity: component?.integrity },
    { status: "active", version: expected.companion.version, integrity: expected.companion.integrity },
  );

  const lock = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
  for (const dependency of expected.directClosure) assertLockIntegrity(lock, dependency);
});

test("goal is fifth, its command and three tools are health-gated, and Goal precedes JorgeX routing", async () => {
  const { createBootstrap } = await import("../extensions/bootstrap.ts");
  const pi = createPiHarness();
  const services = new Map();
  const initOrder = [];
  let goalStarts = 0;
  await createBootstrap({
    loadCompanion: async (id) => companionFactory(id, { initOrder, goalStarts: () => { goalStarts += 1; } }),
    getPermissionsService: (sessionId) => services.get(sessionId),
  })(pi.api);

  assert.deepEqual(initOrder, ["permission", "ask", "subagents", "web", "goal"]);
  assert.deepEqual(expected.tools.filter((name) => pi.toolNames().includes(name)).sort(), expected.tools);
  assert.deepEqual(pi.commandNames(), ["goal"]);
  const context = { hasUI: true, sessionId: "goal-session", ui: { notify() {} } };
  await pi.emitLifecycle("session_start", {}, context);
  await assert.rejects(pi.executeCommand("goal", "ship PR05", context), /health|permission|unavailable|ready/i);
  assert.equal(goalStarts, 0, "/goal must not start before permission health");
  assertEarlyGuard(await pi.emitToolCall({ toolName: "goal_complete", input: { goal_id: "stale" } }, context));
  await pi.emitLifecycle("before_agent_start", {}, context);
  assert.equal(expected.tools.some((name) => pi.activeTools().includes(name)), false);

  services.set(context.sessionId, { ready: true });
  await pi.emitEvent("permissions:ready", { sessionId: context.sessionId });
  pi.api.setActiveTools(expected.tools);
  await pi.executeCommand("goal", "ship PR05", context);
  assert.equal(goalStarts, 1);
  const prompt = await pi.beforeAgentPrompt(context, "Base policy");
  assert.ok(prompt.indexOf(expected.routing.goal) < prompt.indexOf(expected.routing.jorgex), "Goal policy must precede JorgeX routing");
});

test("a direct pi-goal install conflict is latched and cannot release a second continuation engine", async () => {
  const { createBootstrap, detectGoalConflict } = await import("../extensions/bootstrap.ts");
  assert.equal(typeof detectGoalConflict, "function");
  const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-goal-conflict-"));
  const globalSettingsPath = join(sandbox, "agent", "settings.json");
  const projectSettingsPath = join(sandbox, "project", ".pi", "settings.json");
  mkdirSync(dirname(globalSettingsPath), { recursive: true });
  mkdirSync(dirname(projectSettingsPath), { recursive: true });
  const conflicting = '{"packages":["npm:@narumitw/pi-goal@0.53.0"],"foreign":true}\n';
  writeFileSync(globalSettingsPath, conflicting);
  writeFileSync(projectSettingsPath, '{"packages":[]}\n');
  try {
    const detector = () => detectGoalConflict({ globalSettingsPath, projectSettingsPath });
    assert.equal(detector()?.packageName, "@narumitw/pi-goal");
    const pi = createPiHarness();
    const initOrder = [];
    await createBootstrap({
      loadCompanion: async (id) => companionFactory(id, { initOrder, goalStarts() {} }),
      getPermissionsService: () => ({ ready: true }),
      detectGoalConflict: detector,
    })(pi.api);
    assert.deepEqual(initOrder, ["permission", "ask", "subagents", "web"], "a known direct Goal install must prevent the bundled Goal factory from running");
    assert.equal(pi.commandNames().includes("goal"), false, "the bundled /goal command must not coexist with an external engine");
    const notifications = [];
    const context = { sessionId: "conflict", ui: { notify: (message, type) => notifications.push({ message, type }) } };
    await pi.emitLifecycle("session_start", {}, context);
    writeFileSync(globalSettingsPath, '{"packages":[],"foreign":true}\n');
    await pi.emitEvent("permissions:ready", { sessionId: context.sessionId });
    await pi.emitLifecycle("before_agent_start", {}, context);
    assert.equal(expected.tools.some((name) => pi.activeTools().includes(name)), false);
    assert.deepEqual(pi.activeTools(), foundationTools, "a Goal ownership conflict must not disable healthy foundation companions");
    assert.deepEqual(
      await pi.emitToolCall({ toolName: "bash", input: { command: "git status" } }, context),
      { block: true, reason: "permission handler decision" },
      "the foundation permission handler must remain authoritative",
    );
    await assert.rejects(pi.executeCommand("goal", "must stay blocked", context), /conflict|duplicate|unavailable/i);
    assert.equal(notifications.length, 1, "the latched duplicate must be diagnosed once");
    assert.match(notifications[0].message, /external|unmanaged/i);
    assert.match(notifications[0].message, /reload/i);
    assert.equal(readFileSync(projectSettingsPath, "utf8"), '{"packages":[]}\n');
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

for (const scenario of [
  { label: "invalid", read: () => ({ kind: "invalid", reason: "invalid settings shape" }) },
  { label: "unreadable", read: () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); } },
]) {
  test(`${scenario.label} pi-goal config latches unhealthy without exposing a goal prompt`, async () => {
    const { createBootstrap } = await import("../extensions/bootstrap.ts");
    const pi = createPiHarness();
    const notifications = [];
    let goalStarts = 0;
    await createBootstrap({
      loadCompanion: async (id) => companionFactory(id, { initOrder: [], goalStarts: () => { goalStarts += 1; } }),
      getPermissionsService: () => ({ ready: true }),
      readGoalConfig: scenario.read,
    })(pi.api);
    const context = { hasUI: true, sessionId: `config-${scenario.label}`, ui: { notify: (message, type) => notifications.push({ message, type }) } };
    await pi.emitLifecycle("session_start", {}, context);
    await pi.emitEvent("permissions:ready", { sessionId: context.sessionId });
    const prompt = await pi.beforeAgentPrompt(context, "Base policy");
    assert.doesNotMatch(prompt, new RegExp(expected.routing.goal, "i"), "an unhealthy goal config must not inject Goal instructions");
    assert.equal(expected.tools.some((name) => pi.activeTools().includes(name)), false);
    assert.deepEqual(pi.activeTools(), foundationTools, "invalid Goal config must isolate Goal without disabling healthy companions");
    assert.deepEqual(
      await pi.emitToolCall({ toolName: "bash", input: { command: "git status" } }, context),
      { block: true, reason: "permission handler decision" },
    );
    await assert.rejects(pi.executeCommand("goal", "must not start", context), /config|invalid|unreadable|unavailable/i);
    await pi.emitEvent("pi-goal:start", { runId: "blocked", objective: "must not start" });
    assert.equal(goalStarts, 0);
    assert.equal(pi.sentMessages(), 0);
    assert.equal(notifications.length, 1, "config failure must be diagnosed exactly once");
    assert.match(notifications[0].message, /pi-goal|goal/i);
    assert.match(notifications[0].message, /config|settings/i);
    await pi.emitLifecycle("session_start", {}, context);
    assert.equal(notifications.length, 1, "the config failure must stay latched without duplicate diagnostics");
  });
}

test("missing pi-goal config keeps upstream safe defaults without a JorgeX override", async () => {
  const { createBootstrap } = await import("../extensions/bootstrap.ts");
  const pi = createPiHarness();
  const services = new Map();
  let goalStarts = 0;
  await createBootstrap({
    loadCompanion: async (id) => companionFactory(id, { initOrder: [], goalStarts: () => { goalStarts += 1; } }),
    getPermissionsService: (sessionId) => services.get(sessionId),
    readGoalConfig: () => ({ kind: "missing" }),
  })(pi.api);
  const context = { hasUI: true, sessionId: "missing-config", ui: { notify() {} } };
  await pi.emitLifecycle("session_start", {}, context);
  await assert.rejects(pi.executeCommand("goal", "pre-health", context), /health|permission|unavailable|ready/i);
  await pi.emitEvent("pi-goal:start", { runId: "pre-health", objective: "must not start" });
  assert.equal(goalStarts, 0);
  assert.equal(pi.sentMessages(), 0);

  services.set(context.sessionId, { ready: true });
  await pi.emitEvent("permissions:ready", { sessionId: context.sessionId });
  const prompt = await pi.beforeAgentPrompt(context, "Base policy");
  assert.match(prompt, new RegExp(expected.routing.goal, "i"));
  await pi.executeCommand("goal", "post-health", context);
  assert.equal(goalStarts, 1, "missing config must use the pinned upstream defaults after health");
});

test("an unhealthy managed-run start returns one terminal error instead of waiting silently", async () => {
  const { createBootstrap } = await import("../extensions/bootstrap.ts");
  const pi = createPiHarness();
  let goalStarts = 0;
  await createBootstrap({
    loadCompanion: async (id) => companionFactory(id, { initOrder: [], goalStarts: () => { goalStarts += 1; } }),
    getPermissionsService: () => undefined,
    readGoalConfig: () => ({ kind: "missing" }),
  })(pi.api);
  const runId = "blocked-run";
  const responses = [];
  pi.api.events.on(`pi-goal:event:${runId}`, (event) => responses.push(event));
  await pi.emitLifecycle("session_start", {}, { sessionId: "rpc-unhealthy" });
  await pi.emitEvent("pi-goal:start", { runId, objective: "must not start" });
  assert.equal(goalStarts, 0);
  assert.equal(pi.sentMessages(), 0);
  assert.equal(responses.length, 1, "every valid runId must receive exactly one terminal response");
  assert.equal(responses[0]?.type, "error");
  assert.equal(responses[0]?.runId, runId);
  assert.equal(responses[0]?.operation, "start");
  assert.equal(responses[0]?.error?.code, "ACTIVATION_FAILED", "the guard must stay inside pi-goal's stable public error enum");
  assert.match(responses[0]?.error?.message ?? "", /health|permission|ready|unavailable/i);
});

test("Goal lifecycle authorization uses the callback session instead of another ready session", async () => {
  const { createBootstrap } = await import("../extensions/bootstrap.ts");
  const pi = createPiHarness();
  const services = new Map();
  const settledSessions = [];
  await createBootstrap({
    loadCompanion: async (id) => companionFactory(id, { initOrder: [], goalStarts() {}, settledSessions }),
    getPermissionsService: (sessionId) => services.get(sessionId),
  })(pi.api);
  const sessionA = { hasUI: true, sessionId: "unready-a" };
  const sessionB = { hasUI: true, sessionId: "ready-b" };
  await pi.emitLifecycle("session_start", {}, sessionA);
  await pi.emitLifecycle("session_start", {}, sessionB);
  services.set(sessionB.sessionId, { ready: true });
  await pi.emitEvent("permissions:ready", { sessionId: sessionB.sessionId });

  await pi.emitLifecycle("agent_settled", {}, sessionA);
  assert.deepEqual(settledSessions, [], "ready B must not authorize an agent_settled callback from unready A");
  const promptA = await pi.beforeAgentPrompt(sessionA, "Base policy A");
  assert.doesNotMatch(promptA, new RegExp(expected.routing.goal, "i"));

  await pi.emitLifecycle("agent_settled", {}, sessionB);
  assert.deepEqual(settledSessions, [sessionB.sessionId]);
  const promptB = await pi.beforeAgentPrompt(sessionB, "Base policy B");
  assert.match(promptB, new RegExp(expected.routing.goal, "i"));
});

test("a headless session cannot consume the only Goal config diagnostic", async () => {
  const { createBootstrap } = await import("../extensions/bootstrap.ts");
  const pi = createPiHarness();
  await createBootstrap({
    loadCompanion: async (id) => companionFactory(id, { initOrder: [], goalStarts() {} }),
    getPermissionsService: () => ({ ready: true }),
    readGoalConfig: () => ({ kind: "invalid", reason: "invalid settings shape" }),
  })(pi.api);
  await pi.emitLifecycle("session_start", {}, { sessionId: "headless", hasUI: false });
  const notifications = [];
  const interactive = { sessionId: "interactive", hasUI: true, ui: { notify: (message, type) => notifications.push({ message, type }) } };
  await pi.emitLifecycle("session_start", {}, interactive);
  assert.equal(notifications.length, 1, "the first available UI must receive the retained diagnostic exactly once");
  assert.equal(notifications[0].type, "error");
  assert.match(notifications[0].message, /pi-goal|goal/i);
  await pi.emitLifecycle("session_start", {}, interactive);
  assert.equal(notifications.length, 1);
});

test("JorgeX preserves goal config and delegates continuation, queue, and RPC exclusively to pi-goal", async () => {
  const assets = readJson(join(root, "contract", "assets.v1.json"));
  for (const state of expected.preservedExternalState) {
    assert.ok(assets.preservedExternalState.some(({ owner, root: stateRoot, relativePath }) => (
      owner === expected.companion.name && stateRoot === state.root && relativePath === state.relativePath
    )));
  }
  assert.equal(assets.managedExternalWrites.some(({ owner }) => owner === expected.companion.name), false);

  const { createBootstrap } = await import("../extensions/bootstrap.ts");
  const pi = createPiHarness();
  await createBootstrap({
    loadCompanion: async (id) => companionFactory(id, { initOrder: [], goalStarts() {} }),
    getPermissionsService: () => ({ ready: true }),
  })(pi.api);
  assert.deepEqual(pi.lifecycleOwners("agent_settled"), ["goal"], "only pi-goal may own automatic continuation");
  assert.deepEqual(pi.commandNames(), ["goal"], "JorgeX must not add queue commands or a second goal surface");
  assert.deepEqual(pi.eventNames().filter((name) => name.startsWith("pi-goal:")), ["pi-goal:start"]);
  assert.equal(pi.eventHandlerCount("pi-goal:start"), 1, "JorgeX may guard but must not duplicate pi-goal RPC handling");
  assert.equal(pi.sentMessages(), 0, "bootstrap must not synthesize its own continuation message");
});

function companionFactory(id, { initOrder, goalStarts, settledSessions = [] }) {
  return (pi) => {
    initOrder.push(id);
    if (id === "permission") pi.on("tool_call", () => ({ block: true, reason: "permission handler decision" }));
    if (id === "ask") pi.registerTool({ name: "ask_user_question" });
    if (id === "subagents") for (const name of ["subagent", "subagent_wait"]) pi.registerTool({ name });
    if (id === "web") for (const name of ["web_search", "source_check", "fetch_content", "get_search_content"]) pi.registerTool({ name });
    if (id === "goal") {
      for (const name of expected.tools) pi.registerTool({ name });
      pi.registerCommand("goal", { handler() { goalStarts(); pi.sendUserMessage("goal-command"); } });
      const continuationHandler = (_event, ctx) => { settledSessions.push(ctx?.sessionId); };
      continuationHandler.owner = "goal";
      pi.on("agent_settled", continuationHandler);
      pi.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt ?? ""}\n\n${expected.routing.goal}` }));
      const rpcHandler = () => { goalStarts(); pi.sendUserMessage("goal-rpc"); };
      rpcHandler.owner = "goal";
      pi.events.on("pi-goal:start", rpcHandler);
    }
  };
}

function createPiHarness() {
  const eventHandlers = new Map();
  const eventOwners = new Map();
  const lifecycleHandlers = new Map();
  const lifecycleOwners = new Map();
  const tools = new Map();
  const commands = new Map();
  let active = [];
  let sent = 0;
  const add = (map, name, handler) => map.set(name, [...(map.get(name) ?? []), handler]);
  const api = {
    events: {
      on(name, handler) { add(eventHandlers, name, handler); add(eventOwners, name, handler.owner ?? "bootstrap"); },
      emit(name, payload) { for (const handler of eventHandlers.get(name) ?? []) handler(payload); },
    },
    on(name, handler) { add(lifecycleHandlers, name, handler); add(lifecycleOwners, name, handler.owner ?? "bootstrap"); },
    registerTool(tool) { tools.set(tool.name, tool); active = [...new Set([...active, tool.name])]; },
    registerCommand(name, command) { commands.set(name, command); },
    getActiveTools: () => [...active],
    setActiveTools: (names) => { active = [...names]; },
    sendUserMessage() { sent += 1; },
  };
  return {
    api: new Proxy(api, { get(target, key) { return Reflect.get(target, key); } }),
    toolNames: () => [...tools.keys()].sort(),
    commandNames: () => [...commands.keys()].sort(),
    activeTools: () => [...active].sort(),
    eventNames: () => [...eventHandlers.keys()].sort(),
    eventOwners: (name) => eventOwners.get(name) ?? [],
    eventHandlerCount: (name) => (eventHandlers.get(name) ?? []).length,
    lifecycleOwners: (name) => lifecycleOwners.get(name) ?? [],
    sentMessages: () => sent,
    async executeCommand(name, args, ctx) {
      const command = commands.get(name);
      if (!command) throw new Error(`${name} command unavailable`);
      return command.handler(args, ctx);
    },
    async emitEvent(name, payload) { for (const handler of eventHandlers.get(name) ?? []) await handler(payload); },
    async emitLifecycle(name, event, ctx) {
      let current = event;
      for (const handler of lifecycleHandlers.get(name) ?? []) {
        const result = await handler(current, ctx);
        if (result?.systemPrompt) current = { ...current, systemPrompt: result.systemPrompt };
      }
      return current;
    },
    async beforeAgentPrompt(ctx, systemPrompt) { return (await this.emitLifecycle("before_agent_start", { systemPrompt }, ctx)).systemPrompt; },
    async emitToolCall(event, ctx) {
      for (const handler of lifecycleHandlers.get("tool_call") ?? []) {
        const result = await handler(event, ctx);
        if (result?.block) return result;
      }
    },
  };
}

function assertEarlyGuard(result) {
  assert.equal(result?.block, true);
  assert.equal(result?.terminate, true);
}

function assertLockIntegrity(lock, dependency) {
  const escaped = `${dependency.name}@${dependency.version}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const block = new RegExp(`^  ['\"]?${escaped}['\"]?:\\n([\\s\\S]*?)(?=^  \\S|^snapshots:)`, "m").exec(lock)?.[1];
  assert.ok(block, `pnpm lock must contain ${dependency.name}@${dependency.version}`);
  assert.ok(block.includes(`integrity: ${dependency.integrity}`), `${dependency.name}@${dependency.version} integrity must match`);
}

function readJson(path) { return JSON.parse(readFileSync(path, "utf8")); }
