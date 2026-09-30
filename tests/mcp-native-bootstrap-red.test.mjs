import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { RUNTIME_REGISTER_EVENT, resolveMcpEngramConfig } from "../extensions/mcp-engram.ts";

// T70 bootstrap tracer — native Engram-only bootstrap, provider/catalog/connection
// kept separate (Spec 71, "Bootstrap nativo: proveedor, catálogo y conexión separados").
//
// The reader (a80dc19) resolves a native install as
// `{ state: "managed", transport: "native", config: { mcpServers: { engram } }, context7: { state: "available" } }`:
// the Context7 *channel* is available while no Context7 definition exists,
// because native Context7/DevTools persistence is a later step and the native
// branch must not register ephemeral MCP servers. The bootstrap must keep that
// channel state separate from a legacy registration failure, from adapter
// registration events and from the c7/devtools guides.
//
// The harness only exposes real public Pi APIs (verified against the published
// 0.99.1 type declarations): getCommands() -> SlashCommandInfo[] with
// sourceInfo.path/sourceInfo.source, getAllTools() -> ToolInfo[] with
// sourceInfo, getActiveTools() to observe discovery without re-imposing it, and
// the context input `cwd` plus `isProjectTrusted()`.
//
// The last tracer covers project scope: Pi reads `<cwd>/.pi/mcp.json` only for
// trusted projects and a project entry replaces the global one by name, so a
// trusted override of the protected `engram` server must be diagnosed while an
// untrusted one is never applied nor reported.
const PI_SESSION = { hasUI: true, sessionId: "native-bootstrap-session" };

function createPiHarness({ commands = [], tools = [], activeTools = [] } = {}) {
  const eventHandlers = new Map();
  const lifecycleHandlers = new Map();
  const notifications = [];
  const emittedEvents = [];
  let active = [...activeTools];
  const add = (map, name, handler) => map.set(name, [...(map.get(name) ?? []), handler]);
  return {
    api: {
      events: {
        on: (name, handler) => add(eventHandlers, name, handler),
        emit: (name, payload) => emittedEvents.push({ name, payload }),
      },
      on: (name, handler) => add(lifecycleHandlers, name, handler),
      registerTool(tool) {
        active = [...new Set([...active, tool.name])];
      },
      getActiveTools: () => [...active],
      setActiveTools: (names) => {
        active = [...names];
      },
      getCommands: () => commands,
      getAllTools: () => tools,
    },
    notifications: () => [...notifications],
    emittedEvents: () => [...emittedEvents],
    async emitEvent(name, payload) {
      for (const handler of eventHandlers.get(name) ?? []) await handler(payload);
    },
    async emitLifecycle(name, event, ctx) {
      let result;
      for (const handler of lifecycleHandlers.get(name) ?? []) {
        const current = await handler(event, ctx);
        if (current !== undefined) result = current;
      }
      return result;
    },
    context(overrides = {}) {
      const ui = { notify: (message, type) => notifications.push({ message, type }) };
      return { ...PI_SESSION, ui, ...overrides };
    },
  };
}

// Pi's own loader reads `<agentDir>/mcp.json` always and `<cwd>/.pi/mcp.json`
// only when the project is trusted, and a project entry replaces the global
// entry with the same name. The project fixture below therefore really replaces
// the protected `engram` server, with a different real executable so a
// diagnosis can never be about a broken command.
const PROJECT_OVERRIDE_COMMAND = "/bin/sh";

function createNativeSandbox(t, { projectOverride = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "jorgex-pi-native-bootstrap-"));
  // Owned temporary tree: register the runner-hook teardown immediately after
  // the owned mkdtemp and before any other IO, so a failure while the fixture is
  // being built still cleans up on success, failure and cancellation.
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify({ packages: ["npm:gentle-engram@0.1.16"] })}\n`);
  writeFileSync(
    join(agentDir, "mcp.json"),
    `${JSON.stringify(
      { mcpServers: { engram: { command: process.execPath, args: ["mcp", "--tools=agent"], exposure: "deferred" } } },
      null,
      2,
    )}\n`,
  );
  let projectDir;
  if (projectOverride) {
    projectDir = join(root, "project");
    mkdirSync(join(projectDir, ".pi"), { recursive: true });
    writeFileSync(
      join(projectDir, ".pi", "mcp.json"),
      `${JSON.stringify(
        { mcpServers: { engram: { command: PROJECT_OVERRIDE_COMMAND, args: ["mcp", "--tools=agent"], exposure: "deferred" } } },
        null,
        2,
      )}\n`,
    );
  }
  const env = { HOME: root, PI_CODING_AGENT_DIR: agentDir, XDG_CONFIG_HOME: join(root, "xdg") };
  return {
    root,
    agentDir,
    projectDir,
    resolve: (cwd = root) => resolveMcpEngramConfig({ env, platform: "linux", cwd }),
  };
}

function readProjectEngram(sandbox) {
  const file = join(sandbox.projectDir, ".pi", "mcp.json");
  return { file, entry: JSON.parse(readFileSync(file, "utf8")).mcpServers.engram };
}

// Files and contents of the whole fixture tree, so a diagnosis that rewrites,
// normalizes or backs up configuration (or writes trust state) is observable.
function snapshotSandbox(sandbox) {
  const files = {};
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const target = join(dir, entry.name);
      if (entry.isDirectory()) walk(target);
      else files[relative(sandbox.root, target)] = readFileSync(target, "utf8");
    }
  };
  walk(sandbox.root);
  return files;
}

const BUILTIN_MCP_COMMAND = {
  name: "mcp",
  description: "Show MCP server status",
  source: "extension",
  sourceInfo: { path: "builtin:mcp", source: "builtin", scope: "temporary", origin: "top-level" },
};
const BUILTIN_TOOL_SEARCH = {
  name: "tool_search",
  description: "Load deferred tools",
  parameters: { type: "object", properties: {} },
  promptGuidelines: [],
  exposure: "model-only",
  sourceInfo: { path: "builtin:tool-search", source: "builtin", scope: "temporary", origin: "top-level" },
};

async function runNativeBootstrap({ commands, tools, activeTools, sandbox, resolutionSink, projectDir, projectTrusted = false }) {
  const { createBootstrap } = await import("../extensions/bootstrap.ts");
  const cwd = projectDir ?? sandbox.root;
  const pi = createPiHarness({ commands, tools, activeTools });
  await createBootstrap({
    loadCompanion: async () => () => {},
    getPermissionsService: () => ({ ready: true }),
    readWebAccessConfig: () => ({}),
    resolvePlaywrightCapability: () => undefined,
    detectWebAccessConflict: () => undefined,
    detectGoalConflict: () => undefined,
    readGoalConfig: () => ({ kind: "loaded" }),
    resolveMcpEngram: async () => {
      const resolution = await sandbox.resolve(cwd);
      if (resolutionSink) resolutionSink.resolution = resolution;
      return resolution;
    },
  })(pi.api);
  // Real public context input: `cwd` plus `isProjectTrusted()` (SDK types).
  const ctx = pi.context({ cwd, isProjectTrusted: () => projectTrusted });
  await pi.emitLifecycle("session_start", {}, ctx);
  await pi.emitEvent("permissions:ready", { sessionId: PI_SESSION.sessionId });
  const agentStart = await pi.emitLifecycle("before_agent_start", { systemPrompt: "Existing Pi prompt." }, ctx);
  return { pi, prompt: agentStart?.systemPrompt ?? "" };
}

test("native Engram-only bootstrap keeps provider, pending catalog and no legacy Context7/DevTools error", async (t) => {
  const sandbox = createNativeSandbox(t);
  const sink = {};
  try {
    // Premise: the real reader output for a native install. Capture it so the
    // assertions below protect the actual reader contract, not a stub shape.
    const { pi, prompt } = await runNativeBootstrap({
      // `/mcp` and `tool_search` come from the built-in provider; the initial
      // catalog is still pending (tool_search is registered, not active).
      commands: [BUILTIN_MCP_COMMAND],
      tools: [BUILTIN_TOOL_SEARCH],
      activeTools: [],
      sandbox,
      resolutionSink: sink,
    });

    assert.equal(sink.resolution?.state, "managed", "the native reader must resolve managed for this fixture");
    assert.equal(sink.resolution?.transport, "native", "the fixture must exercise the native transport");
    assert.equal(sink.resolution?.context7?.state, "available", "the Context7 channel is available in native");
    assert.equal(
      "context7" in (sink.resolution?.config?.mcpServers ?? {}),
      false,
      "native adds no ephemeral Context7 definition",
    );

    const messages = pi.notifications().map(({ message }) => message);
    // The native branch must not run the legacy Context7/DevTools registration
    // path: a native install never had a Context7 registration to fail.
    assert.deepEqual(
      matching(messages, /Context7|chrome-devtools|DevTools/i),
      [],
      `a healthy native Engram-only install must not report a legacy Context7/DevTools runtime error: ${messages.join(" | ")}`,
    );
    assert.deepEqual(
      matching(messages, /Engram bridge is unavailable/i),
      [],
      "a valid native Engram configuration is not a bridge failure",
    );
    assert.equal(
      pi.emittedEvents().some(({ name }) => name === RUNTIME_REGISTER_EVENT),
      false,
      "the native branch must not emit adapter runtime-register events",
    );
    assert.doesNotMatch(prompt, /jorgex:context7/, "no Context7 guide before the managed ownership contract is closed");
    assert.doesNotMatch(
      prompt,
      /jorgex:chrome-devtools/,
      "no DevTools guide before the managed ownership contract is closed",
    );
    assert.match(prompt, /jorgex:system-prompt/, "the native install still composes the canonical JorgeX policy");
  } finally {
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});

test("native bootstrap diagnoses a substituted /mcp provider instead of reporting a healthy native install", async (t) => {
  const sandbox = createNativeSandbox(t);
  try {
    // A third-party extension owns `/mcp` (not `builtin:mcp`) and a foreign
    // `tool_search` is registered: the builtin provider is substituted.
    const { pi } = await runNativeBootstrap({
      commands: [
        {
          name: "mcp",
          description: "Show MCP server status",
          source: "extension",
          sourceInfo: { path: "/opt/foreign/mcp-adapter.ts", source: "local", scope: "temporary", origin: "top-level" },
        },
      ],
      tools: [
        {
          ...BUILTIN_TOOL_SEARCH,
          sourceInfo: { path: "/opt/foreign/tool-search.ts", source: "local", scope: "temporary", origin: "top-level" },
        },
      ],
      activeTools: [],
      sandbox,
    });

    const diagnostics = pi.notifications().filter(({ message }) => /mcp|builtin/i.test(message));
    // A replaced builtin must be reported, never presented as a healthy native
    // provider.
    assert.ok(
      diagnostics.length >= 1,
      "a substituted /mcp provider must be diagnosed explicitly instead of being reported as a healthy native install",
    );
    assert.ok(
      diagnostics.some(({ message }) => /builtin/i.test(message)),
      `the diagnostic must name the missing or replaced builtin provider: ${diagnostics.map(({ message }) => message).join(" | ")}`,
    );
  } finally {
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});

test("native bootstrap diagnoses an absent builtin:tool-search discovery instead of reading an empty catalog as pending", async (t) => {
  const sandbox = createNativeSandbox(t);
  try {
    // The effective /mcp command is the Pi builtin, but the runtime exposes no
    // `tool_search` tool at all: deferred MCP tools can never be loaded, so the
    // bootstrap must diagnose the absent discovery. This is distinct from the
    // normal case above (`tool_search` registered, merely inactive) and from an
    // empty/pending deferred catalog: absence is observed on getAllTools(), the
    // discovery factory, never inferred from the getActiveTools() selection.
    const { pi } = await runNativeBootstrap({
      commands: [BUILTIN_MCP_COMMAND],
      tools: [],
      activeTools: [],
      sandbox,
    });

    const notifications = pi.notifications();
    const diagnostics = notifications.filter(({ message }) => /tool_search|tool-search/i.test(message));
    assert.ok(
      diagnostics.length >= 1,
      `an absent builtin:tool-search discovery must be diagnosed explicitly: ${notifications.map(({ message }) => message).join(" | ") || "no notification at all"}`,
    );
    assert.ok(
      diagnostics.some(({ message }) => /builtin/i.test(message)),
      `the diagnostic must name the missing builtin discovery: ${diagnostics.map(({ message }) => message).join(" | ")}`,
    );
  } finally {
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});

test("native bootstrap diagnoses a trusted project override of the protected Engram server", async (t) => {
  const sandbox = createNativeSandbox(t, { projectOverride: true });
  try {
    const { entry } = readProjectEngram(sandbox);
    assert.equal(entry.command, PROJECT_OVERRIDE_COMMAND, "the project fixture must define the override");
    assert.ok(existsSync(entry.command), "the override must be a real executable, never a broken command");
    assert.notEqual(entry.command, process.execPath, "the project fixture must really replace the protected Engram server");
    const before = snapshotSandbox(sandbox);

    const { pi, prompt } = await runNativeBootstrap({
      commands: [BUILTIN_MCP_COMMAND],
      tools: [BUILTIN_TOOL_SEARCH],
      activeTools: [],
      sandbox,
      projectDir: sandbox.projectDir,
      projectTrusted: true,
    });

    // Pi reads `<cwd>/.pi/mcp.json` for trusted projects and a project entry
    // replaces the global one with the same name, so `engram` is no longer the
    // server the native reader validated. The bootstrap cannot validate the
    // project entry, so it must diagnose it instead of presenting a valid
    // managed native configuration.
    const notifications = pi.notifications();
    const diagnostics = notifications.filter(({ message }) => /engram/i.test(message) && /project|override/i.test(message));
    assert.ok(
      diagnostics.length >= 1,
      `a trusted project override of the protected Engram server must be diagnosed explicitly: ${notifications.map(({ message }) => message).join(" | ") || "no notification at all"}`,
    );
    // The managed ownership contract is still open: no guide is advertised.
    assert.doesNotMatch(prompt, /jorgex:context7/, "no Context7 guide from project configuration");
    assert.doesNotMatch(prompt, /jorgex:chrome-devtools/, "no DevTools guide from project configuration");
    // Diagnosis only: no configuration, backup or trust state is written.
    assert.deepEqual(snapshotSandbox(sandbox), before, "the native branch must not write configuration or trust state");
  } finally {
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});

test("an untrusted project Engram override is ignored and the global native install stays healthy", async (t) => {
  const sandbox = createNativeSandbox(t, { projectOverride: true });
  const sink = {};
  try {
    const { entry } = readProjectEngram(sandbox);
    assert.equal(entry.command, PROJECT_OVERRIDE_COMMAND, "the project fixture must define the override");
    assert.notEqual(entry.command, process.execPath, "the project fixture must really replace the protected Engram server");
    const before = snapshotSandbox(sandbox);

    const { pi } = await runNativeBootstrap({
      commands: [BUILTIN_MCP_COMMAND],
      tools: [BUILTIN_TOOL_SEARCH],
      activeTools: [],
      sandbox,
      resolutionSink: sink,
      projectDir: sandbox.projectDir,
      projectTrusted: false,
    });

    // Pi never reads `<cwd>/.pi/mcp.json` for untrusted projects, so the global
    // validated entry stays effective and the untrusted file is never claimed
    // as an effective override: no diagnostic and no legacy error either.
    assert.deepEqual(pi.notifications(), [], "an untrusted project override must neither be applied nor reported");
    assert.equal(sink.resolution?.state, "managed", "the global native configuration stays effective");
    assert.deepEqual(snapshotSandbox(sandbox), before, "the untrusted override must not be rewritten, normalized or backed up");
  } finally {
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});

function matching(messages, pattern) {
  return messages.filter((message) => pattern.test(message));
}
