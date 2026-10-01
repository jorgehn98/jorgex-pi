// Bootstrap native-guide harness (Spec 71 L35).
//
// Spec: the readonly ownership checker integrates into the native bootstrap
// hooks with an OWN injection seam used only by tests (same pattern as
// `resolveMcpEngram`, never an upstream API nor a packageRoot parameter). A
// Context7 guide exists only when the server is managed/configured, the builtin
// provider/discovery is demonstrated and the public namespace catalog of that
// server has been observed (never a connection claim). Pending catalog, unowned,
// conflict, disabled, hidden or unsupported-execution keep the guide absent and
// never activate tools or re-impose preferences.
//
// Harness only: real public Pi APIs (getCommands/getAllTools/getActiveTools and
// the context inputs cwd/isProjectTrusted), no credentials, no browser, no model
// and no real HOME. The persistent Context7 definition stays identical in every
// case so a suppressed guide can never be explained by configuration shape.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { resolveMcpEngramConfig } from "../../extensions/mcp-engram.mjs";
import { CONTEXT7_URL } from "../../extensions/mcp-engram.mjs";

export const PI_SESSION = { hasUI: true, sessionId: "native-guide-session" };

export const BUILTIN_MCP_COMMAND = {
  name: "mcp",
  description: "Show MCP server status",
  source: "extension",
  sourceInfo: { path: "builtin:mcp", source: "builtin", scope: "temporary", origin: "top-level" },
};

export const BUILTIN_TOOL_SEARCH = {
  name: "tool_search",
  description: "Load deferred tools",
  parameters: { type: "object", properties: {} },
  promptGuidelines: [],
  exposure: "model-only",
  sourceInfo: { path: "builtin:tool-search", source: "builtin", scope: "temporary", origin: "top-level" },
};

// Deferred tool of the observed Context7 namespace: the host names deferred MCP
// tools `mcp__<server>__<tool>` while they stay inactive until their catalog is
// materialized. Its `sourceInfo` is the ACTUAL one the published Pi 0.99 loader
// stores: `registerTool` keeps `extension.sourceInfo`, and MCP tools come from
// the `builtin:mcp` factory, so the source is `builtin` with path `builtin:mcp`
// (the MCP extension does not override it anywhere). The `mcp__context7__` name
// is the logical namespace, not an authority signal.
export const DEFERRED_CONTEXT7_TOOL = {
  name: "mcp__context7__query_docs",
  description: "Query Context7 documentation",
  parameters: { type: "object", properties: {} },
  promptGuidelines: [],
  exposure: "deferred",
  sourceInfo: { path: "builtin:mcp", source: "builtin", scope: "temporary", origin: "top-level" },
};

// Same logical namespace name, but provided by a foreign (local) extension: the
// policy must never be satisfied by the `mcp__context7__` prefix alone.
export const FOREIGN_CONTEXT7_TOOL = {
  ...DEFERRED_CONTEXT7_TOOL,
  sourceInfo: { path: "/opt/foreign/mcp-adapter.ts", source: "local", scope: "temporary", origin: "top-level" },
};

// Deferred tool of the observed Chrome DevTools namespace, with the same actual
// `builtin:mcp` provenance as every other tool of that factory.
export const DEFERRED_DEVTOOLS_TOOL = {
  name: "mcp__chrome-devtools__navigate_page",
  description: "Navigate the managed browser",
  parameters: { type: "object", properties: {} },
  promptGuidelines: [],
  exposure: "deferred",
  sourceInfo: { path: "builtin:mcp", source: "builtin", scope: "temporary", origin: "top-level" },
};

export function createGuideSandbox(t) {
  const root = mkdtempSync(join(tmpdir(), "jorgex-pi-native-guide-"));
  // Owned temporary tree: teardown is registered immediately after the owned
  // mkdtemp and before any other IO, so it runs on success, failure and a setup
  // failure alike. No process is started here and no real HOME is touched.
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify({ packages: ["npm:gentle-engram@0.1.16"] })}\n`);
  writeFileSync(
    join(agentDir, "mcp.json"),
    `${JSON.stringify(
      {
        mcpServers: {
          engram: { command: process.execPath, args: ["mcp", "--tools=agent"], exposure: "deferred" },
          context7: { url: CONTEXT7_URL },
        },
      },
      null,
      2,
    )}\n`,
  );
  const env = { HOME: root, PI_CODING_AGENT_DIR: agentDir, XDG_CONFIG_HOME: join(root, "xdg") };
  return {
    root,
    agentDir,
    env,
    resolve: (cwd = root) => resolveMcpEngramConfig({ env, platform: "linux", cwd }),
  };
}

export function createPiHarness({ commands = [], tools = [], activeTools = [] } = {}) {
  const eventHandlers = new Map();
  const lifecycleHandlers = new Map();
  const notifications = [];
  const emittedEvents = [];
  const activeToolSelections = [];
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
        activeToolSelections.push([...names]);
        active = [...names];
      },
      getCommands: () => commands,
      getAllTools: () => tools,
    },
    notifications: () => [...notifications],
    emittedEvents: () => [...emittedEvents],
    activeToolSelections: () => [...activeToolSelections],
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

// Drives a native session through the real bootstrap with the injected
// ownership checker. `inspector` is the test-only seam; the lifecycle context is
// always the real public shape (cwd plus isProjectTrusted()).
export async function runNativeGuideBootstrap({
  sandbox,
  inspector,
  commands = [],
  tools = [],
  activeTools = [],
  projectTrusted = false,
  agentStarts = 1,
  beforeAgentStart,
}) {
  const { createBootstrap } = await import("../../extensions/bootstrap.ts");
  const cwd = sandbox.root;
  const pi = createPiHarness({ commands, tools, activeTools });
  const inspectorCalls = [];
  const resolvedSink = {};
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
      resolvedSink.resolution = resolution;
      return resolution;
    },
    // Own injection seam: not an upstream API and never a packageRoot override.
    ...(inspector === undefined ? {} : {
      inspectNativeMcpOwnership: async (input) => {
        // Record only the public context inputs; never retain the real env.
        inspectorCalls.push({
          cwd: input?.cwd,
          platform: input?.platform,
          projectTrusted: input?.projectTrusted,
          hasEnv: input?.env !== undefined,
        });
        return typeof inspector === "function" ? inspector(input) : inspector;
      },
    }),
  })(pi.api);
  const ctx = pi.context({ cwd, isProjectTrusted: () => projectTrusted });
  await pi.emitLifecycle("session_start", {}, ctx);
  await pi.emitEvent("permissions:ready", { sessionId: PI_SESSION.sessionId });
  const prompts = [];
  for (let start = 0; start < agentStarts; start += 1) {
    // Lets a case change the inspected world between agent starts, exactly as a
    // user or an external install would, so freshness is exercised rather than
    // an internal call count.
    beforeAgentStart?.(start);
    const agentStart = await pi.emitLifecycle("before_agent_start", { systemPrompt: "Existing Pi prompt." }, ctx);
    prompts.push(agentStart?.systemPrompt ?? "");
  }
  return {
    pi,
    prompt: prompts[prompts.length - 1] ?? "",
    prompts,
    resolved: resolvedSink.resolution,
    inspectorCalls,
  };
}

// Public readonly DTO of the ownership checker (metadata only). The DevTools
// guard chain itself is proven by tests/mcp-native-authority; this
// fixture only abstracts the metadata the guide policy consumes.
export function ownershipDto({
  context7State = "managed",
  devtoolsState = "absent",
  packageState = "verified",
  packageReason,
} = {}) {
  const serverState = (state, { cleanup = true } = {}) => ({
    state,
    cleanupEligible: state === "managed" && cleanup,
    availability: state === "disabled" ? "disabled" : "configured",
    ...(state === "managed" ? {} : { reason: "fixture diagnostic" }),
  });
  return {
    servers: {
      engram: { state: "unowned", cleanupEligible: false, availability: "configured" },
      context7: serverState(context7State),
      "chrome-devtools": devtoolsState === "absent"
        ? { state: "absent", cleanupEligible: false, availability: "unavailable" }
        : serverState(devtoolsState),
    },
    // The package state defaults to the coherent verified proof; a negative case
    // can inject a conflict with an optional fixed reason (never a real error).
    package: packageReason === undefined ? { state: packageState } : { state: packageState, reason: packageReason },
    connection: "not-verified",
  };
}

export function snapshotSandbox(sandbox) {
  const files = {};
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = join(directory, entry.name);
      if (entry.isDirectory()) walk(target);
      else files[relative(sandbox.root, target)] = readFileSync(target, "utf8");
    }
  };
  walk(sandbox.root);
  return files;
}
