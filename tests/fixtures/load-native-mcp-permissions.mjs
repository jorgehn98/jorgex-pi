// Native MCP permission fixture (T70 test artifact, not production).
//
// Drives the REAL Pi SDK resource loader + runner with the REAL permission
// extension against the generated Pi permission policy
// (`assets/permissions/defaults.json`, materialized by the test at
// `PI_CODING_AGENT_DIR/extensions/pi-permission-system/config.json`).
//
// The permission extension resolves its agent directory from
// `getAgentDir()` (`PI_CODING_AGENT_DIR`), NOT from the loader's `agentDir`
// argument, so the test MUST export `PI_CODING_AGENT_DIR` and `HOME` into this
// process or the extension would read the real user policy.
//
// Reuses the established no-LLM seam from `load-permissions-with-pi.mjs`. The
// provider entry is resolved from `JORGEX_PERMISSION_FIXTURE_PROVIDER`, else
// the repo's `node_modules`; the SDK from `JORGEX_PI_SDK_ROOT`, else the
// repo's `node_modules`. Both are the real, unmodified packages — no fake
// provider and no invented capability.
import { pathToFileURL } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2];
if (!root) throw new Error("package root argument is required");

// Fail closed BEFORE importing the SDK/provider. The permission extension
// resolves its agent directory from `getAgentDir()` (`PI_CODING_AGENT_DIR`) and
// reads the policy under that directory, so a manual run without an explicit,
// seeded sandbox would silently enforce the real `~/.pi/agent` policy.
const agentDir = process.env.PI_CODING_AGENT_DIR;
const home = process.env.HOME;
const userProfile = process.env.USERPROFILE;
for (const [name, value] of [["PI_CODING_AGENT_DIR", agentDir], ["HOME", home], ["USERPROFILE", userProfile]]) {
  if (!value) {
    throw new Error(`${name} is required; run tests/permissions-native-mcp-red.test.mjs so the fixture targets an isolated sandbox, never the real HOME`);
  }
}
const permissionConfigPath = join(agentDir, "extensions", "pi-permission-system", "config.json");
if (!existsSync(permissionConfigPath)) {
  throw new Error(`isolated permission config not found at ${permissionConfigPath}; refusing to load the permission extension without a seeded sandbox policy`);
}

const sdkRoot = process.env.JORGEX_PI_SDK_ROOT;
const sdkEntry = sdkRoot
  ? join(sdkRoot, "dist", "index.js")
  : join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js");
if (!existsSync(sdkEntry)) throw new Error(`Pi SDK entry not found: ${sdkEntry}`);
const sdk = await import(pathToFileURL(sdkEntry).href);
const { createEventBus, DefaultResourceLoader, ExtensionRunner } = sdk;

const cwd = process.cwd();

const providerEntry = process.env.JORGEX_PERMISSION_FIXTURE_PROVIDER
  ?? join(root, "node_modules", "@gotgenes", "pi-permission-system", "src", "index.ts");
if (!existsSync(providerEntry)) throw new Error(`permission provider entry not found: ${providerEntry}`);

// Native tools are registered under the real `mcp__<server>__<tool>` namespace
// Pi's built-in MCP extension uses, plus a non-MCP tool and the legacy `mcp`
// proxy. Registering by name is sufficient: the permission gate keys on the
// tool name the `tool_call` hook receives, exactly as it does for a real
// builtin:mcp tool.
const NATIVE_TOOLS = [
  "mcp__fixture__ordinary",
  "mcp__fixture__protected",
  "mcp__fixture__override_deny",
  "mcp__fixture__override_ask",
];
const plainToolsExtension = (pi) => {
  pi.registerTool({
    name: "mcp",
    label: "Legacy MCP proxy fixture",
    description: "Legacy MCP proxy permission fixture.",
    parameters: { type: "object", properties: {}, additionalProperties: true },
    async execute() { return { content: [{ type: "text", text: "fixture" }] }; },
  });
  pi.registerTool({
    name: "unclassified_tool",
    label: "Non-MCP fixture",
    description: "Non-MCP fallback permission fixture.",
    parameters: { type: "object", properties: {}, additionalProperties: true },
    async execute() { return { content: [{ type: "text", text: "fixture" }] }; },
  });
  for (const name of NATIVE_TOOLS) {
    pi.registerTool({
      name,
      label: `${name} fixture`,
      description: "Native MCP permission fixture.",
      parameters: { type: "object", properties: {}, additionalProperties: true },
      async execute() { return { content: [{ type: "text", text: "fixture" }] }; },
    });
  }
};

const eventBus = createEventBus();
const loader = new DefaultResourceLoader({
  cwd,
  agentDir,
  extensionFactories: [plainToolsExtension],
  additionalExtensionPaths: [providerEntry],
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
  eventBus,
});
await loader.reload();
const loaded = loader.getExtensions();
if (loaded.errors.length > 0) {
  throw new Error(`native permission fixture failed to load extensions: ${JSON.stringify(loaded.errors)}`);
}

const entries = [];
const sessionManager = {
  getSessionId: () => "native-permission-fixture-session",
  getSessionDir: () => cwd,
  getEntries: () => entries,
  getBranch: () => entries,
};
let activeTools = [];
const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, cwd, sessionManager, {});
runner.bindCore(
  {
    sendMessage() {},
    sendUserMessage() {},
    appendEntry() {},
    setSessionName() {},
    getSessionName: () => undefined,
    setLabel() {},
    getActiveTools: () => [...activeTools],
    getAllTools: () => runner.getAllRegisteredTools().map(({ definition }) => definition),
    setActiveTools: (names) => { activeTools = [...names]; },
    refreshTools() {},
    getCommands: () => runner.getRegisteredCommands(),
    setModel: async () => false,
    getThinkingLevel: () => undefined,
    setThinkingLevel() {},
  },
  {
    getModel: () => undefined,
    getScopedModels: () => [],
    isIdle: () => true,
    isProjectTrusted: () => true,
    getSignal: () => undefined,
    abort() {},
    hasPendingMessages: () => false,
    shutdown() {},
    getContextUsage: () => undefined,
    compact() {},
    getSystemPrompt: () => "",
  },
);

const decisions = [];
eventBus.on("permissions:decision", (event) => decisions.push(event));
await runner.emit({ type: "session_start", reason: "startup" });
await runner.emitBeforeAgentStart("native permission fixture", undefined, "Base policy", { cwd });

const call = (toolName, input, toolCallId) =>
  runner.emitToolCall({ type: "tool_call", toolName, toolCallId, input });

const calls = {
  nativeOrdinary: await call("mcp__fixture__ordinary", { project: "t70" }, "native-ordinary"),
  nativeProtected: await call("mcp__fixture__protected", { path: ".env" }, "native-protected"),
  nativeOverrideDeny: await call("mcp__fixture__override_deny", {}, "native-override-deny"),
  nativeOverrideAsk: await call("mcp__fixture__override_ask", {}, "native-override-ask"),
  legacyMcpProxy: await call("mcp", { server: "fixture", tool: "ordinary" }, "legacy-mcp-proxy"),
  nonMcpFallback: await call("unclassified_tool", {}, "non-mcp-fallback"),
};

await runner.emit({ type: "session_shutdown" });

process.stdout.write(`${JSON.stringify({
  toolNames: runner.getAllRegisteredTools().map(({ definition }) => definition.name).sort(),
  calls,
  decisions: decisions.map((event) => ({
    surface: event.surface,
    value: event.value,
    result: event.result,
    resolution: event.resolution,
    matchedPattern: event.matchedPattern,
  })),
  isolated: {
    home,
    userProfile,
    agentDir,
    cwd,
    configBytes: readFileSync(permissionConfigPath, "utf8"),
  },
})}\n`);
