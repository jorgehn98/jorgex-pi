import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(testDir, "..");
const expected = readJson(join(testDir, "fixtures", "web-access.expected.json"));

test("pi-web-access 0.24.1 is active, exactly pinned, bundled, and ownership-safe", () => {
  const manifest = readJson(join(root, "package.json"));
  assert.equal(manifest.dependencies?.[expected.companion.name], expected.companion.version);
  assert.equal(manifest.bundledDependencies?.includes(expected.companion.name), true);

  const inventory = readJson(join(root, "contract", "components.v1.json"));
  const component = inventory.components.find(({ name }) => name === expected.companion.name);
  assert.deepEqual(
    { status: component?.status, version: component?.version, integrity: component?.integrity },
    { status: "active", version: expected.companion.version, integrity: expected.companion.integrity },
  );

  const lock = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
  for (const dependency of expected.directClosure) assertLockIntegrity(lock, dependency);

  const assets = readJson(join(root, "contract", "assets.v1.json"));
  for (const state of expected.preservedExternalState) {
    assert.ok(
      assets.preservedExternalState.some(({ owner, root: stateRoot, relativePath }) => (
        owner === expected.companion.name && stateRoot === state.root && relativePath === state.relativePath
      )),
      `ownership manifest must preserve ${state.root}/${state.relativePath}`,
    );
  }
  assert.equal(assets.managedExternalWrites.some(({ owner }) => owner === expected.companion.name), false);
});

test("web tools stay dynamically health-gated and route through safe JorgeX wrappers", async () => {
  const { createBootstrap } = await import("../extensions/bootstrap.ts");
  const services = new Map();
  const upstreamCalls = [];
  const initOrder = [];
  const pi = createPiHarness();
  const bootstrap = createBootstrap({
    loadCompanion: async (id) => companionFactory(id, { initOrder, upstreamCalls }),
    getPermissionsService: (sessionId) => services.get(sessionId),
    readWebAccessConfig: () => ({}),
  });

  await bootstrap(pi.api);
  assert.deepEqual(initOrder, ["permission", "ask", "subagents", "web"]);
  assert.deepEqual(pi.toolNames(), ["ask_user_question", ...expected.tools, "subagent", "subagent_wait"].sort());

  const context = { hasUI: true, sessionId: "web-session", ui: { notify() {} } };
  await pi.emitLifecycle("session_start", {}, context);
  assert.deepEqual(pi.activeTools(), [], "session start must hide every dynamically captured companion tool");
  assertEarlyGuard(await pi.emitToolCall({ toolName: "web_search", input: { query: "safe defaults" } }, context));

  services.set(context.sessionId, { ready: true });
  await pi.emitEvent("permissions:ready", { sessionId: context.sessionId });
  await pi.emitLifecycle("before_agent_start", {}, context);
  assert.deepEqual(pi.activeTools(), ["ask_user_question", ...expected.tools, "subagent", "subagent_wait"].sort());

  await pi.executeTool("web_search", { query: "safe defaults" }, context);
  assert.equal(upstreamCalls.at(-1).params.workflow, "none", "missing config and params must disable the curator");
  await pi.executeTool("web_search", { query: "explicit", workflow: "summary-review" }, context);
  assert.equal(upstreamCalls.at(-1).params.workflow, "summary-review", "an explicit per-call workflow must win");

  await pi.executeTool("fetch_content", { url: "https://github.com/nicobailon/pi-web-access" }, context);
  assert.equal(upstreamCalls.at(-1).name, "fetch_content", "HTTP(S), including GitHub, must reach upstream");
  const acceptedCalls = upstreamCalls.length;
  for (const params of [
    { url: "/home/user/private.mp4" },
    { url: "file:///home/user/private.mp4" },
    { url: "data:text/plain,secret" },
    { urls: ["https://example.com", "../private.txt"] },
  ]) {
    await assert.rejects(pi.executeTool("fetch_content", params, context), /HTTP\(S\)|local|unsupported/i);
  }
  assert.equal(upstreamCalls.length, acceptedCalls, "rejected local and non-HTTP(S) inputs must never reach upstream");
});

test("web workflow respects valid read-only user config and fails safe on unreadable config", async () => {
  const { createBootstrap } = await import("../extensions/bootstrap.ts");
  for (const scenario of [
    { label: "valid config", read: () => ({ workflow: "auto-summary" }), expectedWorkflow: "auto-summary" },
    { label: "invalid workflow", read: () => ({ workflow: "surprise-browser" }), expectedWorkflow: "none" },
    { label: "unreadable config", read: () => { throw new Error("EACCES"); }, expectedWorkflow: "none" },
  ]) {
    const calls = [];
    const pi = createPiHarness();
    await createBootstrap({
      loadCompanion: async (id) => companionFactory(id, { initOrder: [], upstreamCalls: calls }),
      getPermissionsService: () => ({ ready: true }),
      readWebAccessConfig: scenario.read,
    })(pi.api);
    await pi.executeTool("web_search", { query: scenario.label }, { sessionId: scenario.label });
    assert.equal(calls.at(-1).params.workflow, scenario.expectedWorkflow, scenario.label);
  }
});

test("custom-named web tools are captured and wrapped by their upstream labels", async () => {
  const { createBootstrap } = await import("../extensions/bootstrap.ts");
  const calls = [];
  const pi = createPiHarness();
  await createBootstrap({
    loadCompanion: async (id) => {
      if (id !== "web") return companionFactory(id, { initOrder: [], upstreamCalls: calls });
      return (api) => {
        api.registerTool({
          name: "team_web_search",
          label: "Web Search",
          async execute(_callId, params) { calls.push({ name: "team_web_search", params }); },
        });
        api.registerTool({
          name: "team_fetch_content",
          label: "Fetch Content",
          async execute(_callId, params) { calls.push({ name: "team_fetch_content", params }); },
        });
      };
    },
    getPermissionsService: () => ({ ready: true }),
    readWebAccessConfig: () => ({}),
  })(pi.api);

  assert.ok(pi.toolNames().includes("team_web_search") && pi.toolNames().includes("team_fetch_content"));
  await pi.emitLifecycle("session_start", {}, { sessionId: "custom" });
  assert.equal(pi.activeTools().includes("team_web_search"), false, "dynamically named tools must remain health-gated");
  await pi.executeTool("team_web_search", { query: "custom" }, { sessionId: "custom" });
  assert.equal(calls.at(-1).params.workflow, "none");
  await assert.rejects(
    pi.executeTool("team_fetch_content", { url: "../private.txt" }, { sessionId: "custom" }),
    /HTTP\(S\)|local|unsupported/i,
  );
});

test("routing always explains Web Access and reveals Playwright only from an injected ready capability", async () => {
  const { createBootstrap } = await import("../extensions/bootstrap.ts");
  const hiddenPi = createPiHarness();
  await createBootstrap({
    loadCompanion: async (id) => companionFactory(id, { initOrder: [], upstreamCalls: [] }),
    getPermissionsService: () => ({ ready: true }),
  })(hiddenPi.api);
  const hiddenPrompt = await hiddenPi.beforeAgentPrompt({ sessionId: "hidden" }, "Existing JorgeX system policy");
  assert.match(hiddenPrompt, /^Existing JorgeX system policy\n\nUse Web Access/, "routing must append to, not replace, the existing system prompt chain");
  for (const phrase of expected.routing.webAccess) assert.match(hiddenPrompt, new RegExp(escapeRegExp(phrase), "i"));
  assert.doesNotMatch(hiddenPrompt, /playwright/i, "PATH discovery must not advertise an unowned Playwright capability");

  const readyPi = createPiHarness();
  await createBootstrap({
    loadCompanion: async (id) => companionFactory(id, { initOrder: [], upstreamCalls: [] }),
    getPermissionsService: () => ({ ready: true }),
    resolvePlaywrightCapability: () => ({ status: "ready", commandPath: "/managed/bin/playwright-cli" }),
  })(readyPi.api);
  const readyPrompt = await readyPi.beforeAgentPrompt({ sessionId: "ready" });
  for (const phrase of expected.routing.webAccess) assert.match(readyPrompt, new RegExp(escapeRegExp(phrase), "i"));
  for (const phrase of expected.routing.playwright) assert.match(readyPrompt, new RegExp(escapeRegExp(phrase), "i"));
  assert.match(readyPrompt, /\/managed\/bin\/playwright-cli/);
});

function companionFactory(id, { initOrder, upstreamCalls }) {
  return (pi) => {
    initOrder.push(id);
    if (id === "permission") pi.on("tool_call", () => ({ block: true, reason: "permission handler decision" }));
    if (id === "ask") pi.registerTool({ name: "ask_user_question" });
    if (id === "subagents") {
      pi.registerTool({ name: "subagent" });
      pi.registerTool({ name: "subagent_wait" });
    }
    if (id === "web") {
      for (const name of expected.tools) {
        pi.registerTool({
          name,
          async execute(_callId, params) {
            upstreamCalls.push({ name, params });
            return { content: [{ type: "text", text: name }] };
          },
        });
      }
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
    async executeTool(name, params, ctx) {
      const tool = tools.get(name);
      assert.ok(tool?.execute, `${name} must be registered with an executable upstream wrapper`);
      return tool.execute(`call-${name}`, params, undefined, undefined, ctx);
    },
    async emitEvent(name, payload) { for (const handler of eventHandlers.get(name) ?? []) await handler(payload); },
    async emitLifecycle(name, event, ctx) {
      const results = [];
      for (const handler of lifecycleHandlers.get(name) ?? []) results.push(await handler(event, ctx));
      return results;
    },
    async beforeAgentPrompt(ctx, systemPrompt) {
      const results = await this.emitLifecycle("before_agent_start", { systemPrompt }, ctx);
      return results.map((result) => result?.systemPrompt).filter(Boolean).join("\n");
    },
    async emitToolCall(event, ctx) {
      for (const handler of lifecycleHandlers.get("tool_call") ?? []) {
        const result = await handler(event, ctx);
        if (result?.block) return result;
      }
      return undefined;
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
  assert.ok(block.includes(`integrity: ${dependency.integrity}`), `${dependency.name}@${dependency.version} integrity must match the audited artifact`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
