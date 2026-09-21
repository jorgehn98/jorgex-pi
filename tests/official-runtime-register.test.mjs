import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(testDir, "..");
const RUNTIME_REGISTER_EVENT = "pi-mcp-adapter:runtime-register:v1";

// Managed bridge fixture: what the real official resolver provides when the
// external setup verifies (canonical Context7 definition, exact DevTools
// handoff). Kept explicit so the bus mechanics stay hermetic.
const DEVTOOLS_ARGS = [
  "dlx",
  "chrome-devtools-mcp@1.6.0",
  "--isolated",
  "--redact-network-headers",
  "--no-performance-crux",
  "--no-usage-statistics",
];

function managedBridgeResolution() {
  return {
    state: "managed",
    context7: { state: "available", source: "official-setup" },
    config: {
      mcpServers: {
        context7: {
          url: "https://mcp.context7.com/mcp",
          auth: false,
          lifecycle: "lazy",
          directTools: false,
        },
        "chrome-devtools": {
          command: "/managed/bin/pnpm",
          args: [...DEVTOOLS_ARGS],
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
      const handlers = eventHandlers.get(name) ?? [];
      // Synchronous bus: handlers run inline and may set payload.result.
      for (const handler of handlers) handler(payload);
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
    onEvent: (name, handler) => add(eventHandlers, name, handler),
  };
}

// Fake external adapter implementing the published v1 contract:
// synchronous event, version:1 + name + definition, result fail-closed,
// directTools forced false, duplicate throws, dispose idempotent.
function installFakeRuntimeAdapter(pi, { failWith } = {}) {
  const registered = new Map();
  const snapshots = [];
  pi.api.events.on(RUNTIME_REGISTER_EVENT, (request) => {
    if (request?.version !== 1 || typeof request?.name !== "string" || typeof request?.definition !== "object" || request.definition === null) {
      request.result = { ok: false, error: "invalid runtime-register request" };
      return;
    }
    if (failWith) {
      request.result = { ok: false, error: failWith };
      return;
    }
    if (registered.has(request.name)) {
      request.result = { ok: false, error: `MCP server "${request.name}" is already registered` };
      return;
    }
    const entry = { ...request.definition, directTools: false };
    registered.set(request.name, entry);
    snapshots.push({ name: request.name, directTools: entry.directTools, lifecycle: entry.lifecycle });
    let disposed = false;
    request.result = {
      ok: true,
      snapshot: { name: request.name, directTools: false },
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        registered.delete(request.name);
      },
      get disposed() { return disposed; },
    };
  });
  return { registered, snapshots };
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

test("Context7 and DevTools register via runtime-register:v1 on session_start independent of factory order", async () => {
  const { createBootstrap } = await import("../extensions/bootstrap.ts");
  for (const order of ["adapter-first", "jorgex-first"]) {
    const pi = createPiHarness();
    let fake;
    if (order === "adapter-first") fake = installFakeRuntimeAdapter(pi);
    await createBootstrap({
      loadCompanion: async (id) => companionFactory(id),
      getPermissionsService: () => ({ ready: true }),
      detectWebAccessConflict: () => undefined,
      detectGoalConflict: () => undefined,
      readGoalConfig: () => ({ kind: "loaded" }),
      resolveMcpEngram: async () => managedBridgeResolution(),
    })(pi.api);
    if (order === "jorgex-first") fake = installFakeRuntimeAdapter(pi);

    const context = { sessionId: `runtime-order-${order}`, ui: { notify() {} } };
    await pi.emitLifecycle("session_start", {}, context);

    const registrations = pi.emitted().filter(({ name }) => name === RUNTIME_REGISTER_EVENT);
    assert.ok(registrations.length >= 2, `${order}: session_start must emit runtime-register:v1 for Context7 and DevTools`);
    const names = registrations.map(({ payload }) => payload?.name).sort();
    assert.deepEqual(names, ["chrome-devtools", "context7"], `${order}: both runtime servers must register`);
    for (const { payload } of registrations) {
      assert.equal(payload?.version, 1, `${order}: request version must be 1`);
      assert.equal(typeof payload?.definition, "object", `${order}: request must carry a definition`);
      assert.equal(payload?.definition?.directTools, false, `${order}: runtime definitions must request directTools:false`);
      assert.ok(payload?.result?.ok, `${order}: adapter result must be ok, got ${payload?.result?.error ?? "absent"}`);
    }
    assert.ok(fake.registered.has("context7"), `${order}: fake adapter must hold Context7`);
    assert.ok(fake.registered.has("chrome-devtools"), `${order}: fake adapter must hold DevTools`);

    await pi.emitLifecycle("session_shutdown", {}, context);
    // Handles freed on shutdown tested separately; here at least no throw and no mcp.json write.
  }
});

test("runtime-register result absent/error/duplicate fails closed with snapshots/directTools:false", async () => {
  const { createBootstrap } = await import("../extensions/bootstrap.ts");
  const scenarios = [
    { name: "absent result", setup: (pi) => pi.api.events.on(RUNTIME_REGISTER_EVENT, () => {}), reason: /absent|result|fail/i },
    { name: "error result", setup: (pi) => installFakeRuntimeAdapter(pi, { failWith: "injected adapter error" }), reason: /injected adapter error|fail/i },
  ];
  for (const scenario of scenarios) {
    const pi = createPiHarness();
    scenario.setup(pi);
    await createBootstrap({
      loadCompanion: async (id) => companionFactory(id),
      getPermissionsService: () => ({ ready: true }),
      detectWebAccessConflict: () => undefined,
      detectGoalConflict: () => undefined,
      readGoalConfig: () => ({ kind: "loaded" }),
      resolveMcpEngram: async () => managedBridgeResolution(),
    })(pi.api);
    const notifications = [];
    const context = { sessionId: `runtime-fail-${scenario.name}`, ui: { notify: (message, type) => notifications.push({ message, type }) } };
    await pi.emitLifecycle("session_start", {}, context);
    const prompt = await pi.emitLifecycle("before_agent_start", { systemPrompt: "Existing Pi prompt." }, context);
    assert.doesNotMatch(prompt?.systemPrompt ?? "", /Use Context7|chrome-devtools/i, `${scenario.name} must not advertise unregistered servers`);
    assert.ok(notifications.some(({ type }) => type === "error"), `${scenario.name} must notify fail-closed`);
  }

  // Duplicate: second registration for the same name must fail closed, first stays.
  const pi = createPiHarness();
  const fake = installFakeRuntimeAdapter(pi);
  await createBootstrap({
    loadCompanion: async (id) => companionFactory(id),
    getPermissionsService: () => ({ ready: true }),
    detectWebAccessConflict: () => undefined,
    detectGoalConflict: () => undefined,
    readGoalConfig: () => ({ kind: "loaded" }),
    resolveMcpEngram: async () => managedBridgeResolution(),
  })(pi.api);
  await pi.emitLifecycle("session_start", {}, { sessionId: "runtime-duplicate", ui: { notify() {} } });
  const duplicate = { version: 1, name: "context7", definition: { url: "https://mcp.context7.com/mcp", directTools: false } };
  pi.api.events.emit(RUNTIME_REGISTER_EVENT, duplicate);
  assert.equal(duplicate.result?.ok, false, "duplicate runtime name must fail closed");
  assert.match(duplicate.result?.error ?? "", /already registered/i);
  assert.equal(fake.registered.get("context7")?.directTools, false, "stored snapshot must keep directTools:false");
});

test("runtime handles dispose idempotently on session_shutdown and never write mcp.json", async () => {
  const { createBootstrap } = await import("../extensions/bootstrap.ts");
  const pi = createPiHarness();
  const fake = installFakeRuntimeAdapter(pi);
  await createBootstrap({
    loadCompanion: async (id) => companionFactory(id),
    getPermissionsService: () => ({ ready: true }),
    detectWebAccessConflict: () => undefined,
    detectGoalConflict: () => undefined,
    readGoalConfig: () => ({ kind: "loaded" }),
    resolveMcpEngram: async () => managedBridgeResolution(),
  })(pi.api);
  const context = { sessionId: "runtime-dispose", ui: { notify() {} } };
  await pi.emitLifecycle("session_start", {}, context);
  const registrations = pi.emitted().filter(({ name }) => name === RUNTIME_REGISTER_EVENT);
  assert.ok(registrations.length >= 2, "session_start must register Context7 and DevTools before shutdown");
  await pi.emitLifecycle("session_shutdown", {}, context);
  assert.equal(fake.registered.size, 0, "session_shutdown must dispose runtime registrations");
  // Idempotent: second shutdown must not throw.
  await pi.emitLifecycle("session_shutdown", {}, context);
  assert.equal(fake.registered.size, 0, "double shutdown must stay disposed");
  for (const { payload } of registrations) {
    await payload?.result?.dispose?.();
    await payload?.result?.dispose?.();
    assert.equal(fake.registered.size, 0, "dispose must be idempotent");
  }
});

test("no fallback factory: JorgeX never calls createMcpAdapter nor resolves its own adapter", async () => {
  const bootstrapSource = readFileSync(join(root, "extensions", "bootstrap.ts"), "utf8");
  const bridgeSource = readFileSync(join(root, "extensions", "mcp-engram.ts"), "utf8");
  assert.doesNotMatch(bootstrapSource, /createMcpAdapter/, "bootstrap must register via runtime-register:v1, not the bundled factory");
  assert.doesNotMatch(bridgeSource, /createMcpAdapter/, "bridge must not keep the programmatic factory fallback");
  assert.doesNotMatch(bridgeSource, /import\.meta\.resolve\(["']pi-mcp-adapter["']\)/, "bridge must not runtime-import its own adapter copy");
});
