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
  assert.deepEqual(initOrder, ["permission", "ask", "subagents", "web", "goal"]);
  assert.deepEqual(pi.toolNames(), ["ask_user_question", ...expected.tools, "subagent", "subagent_wait"].sort());

  const context = { hasUI: true, sessionId: "web-session", ui: { notify() {} } };
  await pi.emitLifecycle("session_start", {}, context);
  assertEarlyGuard(await pi.emitToolCall({ toolName: "web_search", input: { query: "safe defaults" } }, context));
  await pi.emitLifecycle("before_agent_start", {}, context);
  assert.deepEqual(pi.activeTools(), [], "the first prompt without health must hide every dynamically captured companion tool");

  services.set(context.sessionId, { ready: true });
  await pi.emitEvent("permissions:ready", { sessionId: context.sessionId });
  await pi.emitLifecycle("before_agent_start", {}, context);
  assert.deepEqual(pi.activeTools(), [], "readiness after a pre-health prompt must not auto-restore Web Access tools");
  pi.api.setActiveTools(["ask_user_question", ...expected.tools, "subagent", "subagent_wait"]);

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
    { label: "explicit workflow wins", params: { workflow: "none" }, read: () => ({ workflow: "auto-summary" }), expectedWorkflow: "none" },
    { label: "valid config", params: {}, read: () => ({ workflow: "auto-summary" }), expectedWorkflow: "auto-summary" },
    { label: "invalid workflow", params: {}, read: () => ({ workflow: "surprise-browser" }), expectedWorkflow: "none" },
    { label: "unreadable config", params: {}, read: () => { throw new Error("EACCES"); }, expectedWorkflow: "none" },
  ]) {
    const calls = [];
    const pi = createPiHarness();
    await createBootstrap({
      loadCompanion: async (id) => companionFactory(id, { initOrder: [], upstreamCalls: calls }),
      getPermissionsService: () => ({ ready: true }),
      readWebAccessConfig: scenario.read,
    })(pi.api);
    await pi.executeTool("web_search", { query: scenario.label, ...scenario.params }, { sessionId: scenario.label });
    assert.equal(calls.at(-1).params.workflow, scenario.expectedWorkflow, scenario.label);
  }
});

test("custom-named web tools are captured and wrapped by their upstream labels", async () => {
  const { createBootstrap } = await import("../extensions/bootstrap.ts");
  const calls = [];
  const services = new Map();
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
    getPermissionsService: (sessionId) => services.get(sessionId),
    readWebAccessConfig: () => ({}),
  })(pi.api);

  assert.ok(pi.toolNames().includes("team_web_search") && pi.toolNames().includes("team_fetch_content"));
  const context = { sessionId: "custom" };
  await pi.emitLifecycle("session_start", {}, context);
  assertEarlyGuard(await pi.emitToolCall({ toolName: "team_web_search", input: { query: "must not run" } }, context));
  await pi.emitLifecycle("before_agent_start", {}, context);
  assert.equal(pi.activeTools().includes("team_web_search"), false, "custom search must remain hidden before health");
  assert.equal(pi.activeTools().includes("team_fetch_content"), false, "custom fetch must remain hidden before health");
  services.set(context.sessionId, { ready: true });
  await pi.emitEvent("permissions:ready", { sessionId: context.sessionId });
  await pi.emitLifecycle("before_agent_start", {}, context);
  assert.equal(pi.activeTools().includes("team_web_search"), false, "custom search must not auto-restore after a pre-health hide");
  assert.equal(pi.activeTools().includes("team_fetch_content"), false, "custom fetch must not auto-restore after a pre-health hide");
  pi.api.setActiveTools(["team_web_search", "team_fetch_content"]);
  await pi.executeTool("team_web_search", { query: "custom" }, context);
  assert.equal(calls.at(-1).params.workflow, "none");
  await assert.rejects(
    pi.executeTool("team_fetch_content", { url: "../private.txt" }, context),
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
  const basePrompt = "Existing JorgeX system policy";
  const hiddenPrompt = await hiddenPi.beforeAgentPrompt({ sessionId: "hidden" }, basePrompt);
  assert.ok(hiddenPrompt.startsWith(`${basePrompt}\n\n`), "routing must preserve and append to the existing system prompt chain");
  extractManagedBlock(hiddenPrompt, "jorgex:system-prompt");
  const hiddenBrowserBlock = extractManagedBlock(hiddenPrompt, "jorgex:browser");
  for (const phrase of expected.routing.webAccess) assert.match(hiddenBrowserBlock, new RegExp(escapeRegExp(phrase), "i"));
  assert.doesNotMatch(hiddenBrowserBlock, /playwright/i, "PATH discovery must not advertise an unowned Playwright capability");

  const readyPi = createPiHarness();
  await createBootstrap({
    loadCompanion: async (id) => companionFactory(id, { initOrder: [], upstreamCalls: [] }),
    getPermissionsService: () => ({ ready: true }),
    resolvePlaywrightCapability: () => ({ status: "ready", commandPath: "/managed/bin/playwright-cli" }),
  })(readyPi.api);
  const readyPrompt = await readyPi.beforeAgentPrompt({ sessionId: "ready" });
  extractManagedBlock(readyPrompt, "jorgex:system-prompt");
  const readyBrowserBlock = extractManagedBlock(readyPrompt, "jorgex:browser");
  for (const phrase of expected.routing.webAccess) assert.match(readyBrowserBlock, new RegExp(escapeRegExp(phrase), "i"));
  for (const phrase of expected.routing.playwright) assert.match(readyBrowserBlock, new RegExp(escapeRegExp(phrase), "i"));
  assert.match(readyBrowserBlock, /\/managed\/bin\/playwright-cli/);
  assert.match(readyBrowserBlock, /only when (?:the )?task requires browser interaction/i, "Playwright routing must establish necessity before use");
  assert.match(
    readyBrowserBlock,
    /explicit (?:user )?approval[^.]*browser profiles[^.]*authenticated sessions[^.]*cookies[^.]*stored (?:browser )?(?:state|storage)/i,
    "Playwright routing must require explicit approval before accessing browser identity or stored state",
  );
  assert.match(
    readyBrowserBlock,
    /(?:page )?DOM[^.]*downloads[^.]*dialogs[^.]*untrusted/i,
    "Playwright routing must classify browser-controlled DOM, downloads, and dialogs as untrusted",
  );
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

function extractManagedBlock(prompt, marker) {
  const opening = `<!-- ${marker} -->`;
  const closing = `<!-- /${marker} -->`;
  assert.equal(countOccurrences(prompt, opening), 1, `${marker} must have exactly one opening marker`);
  assert.equal(countOccurrences(prompt, closing), 1, `${marker} must have exactly one closing marker`);
  const contentStart = prompt.indexOf(opening) + opening.length;
  const contentEnd = prompt.indexOf(closing, contentStart);
  assert.ok(contentEnd >= contentStart, `${marker} must close after its opening marker`);
  return prompt.slice(contentStart, contentEnd);
}

function countOccurrences(value, needle) {
  return value.split(needle).length - 1;
}
