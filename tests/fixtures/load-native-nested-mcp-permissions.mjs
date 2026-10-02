// Nested permission fixture: real `ctx.executeTool` dispatcher generates `<parentId>/<n>`; model turn via public fauxProvider, zero credentials.
import { pathToFileURL } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Fail closed BEFORE importing the SDK/provider. The permission extension
// resolves its agent directory from `getAgentDir()` (`PI_CODING_AGENT_DIR`) and
// reads the policy under that directory, so a manual run without an explicit,
// seeded sandbox would silently enforce the real `~/.pi/agent` policy.
const agentDir = process.env.PI_CODING_AGENT_DIR;
const home = process.env.HOME;
const userProfile = process.env.USERPROFILE;
for (const [name, value] of [["PI_CODING_AGENT_DIR", agentDir], ["HOME", home], ["USERPROFILE", userProfile]]) {
  if (!value) {
    throw new Error(`${name} is required; run the nested native permission test so the fixture targets an isolated sandbox, never the real HOME`);
  }
}
const permissionConfigPath = join(agentDir, "extensions", "pi-permission-system", "config.json");
if (!existsSync(permissionConfigPath)) {
  throw new Error(`isolated permission config not found at ${permissionConfigPath}; refusing to load the permission extension without a seeded sandbox policy`);
}

const sdkRoot = process.env.JORGEX_PI_NATIVE_SDK_ROOT;
if (!sdkRoot) throw new Error("JORGEX_PI_NATIVE_SDK_ROOT is required (explicit native-capable host SDK root)");
const sdkEntry = join(sdkRoot, "dist", "index.js");
if (!existsSync(sdkEntry)) throw new Error(`Pi SDK entry not found: ${sdkEntry}`);
const sdkVersion = JSON.parse(readFileSync(join(sdkRoot, "package.json"), "utf8")).version;

// pi-ai is a sibling dependency of the coding-agent inside the same
// node_modules; importing it there keeps a single SDK/pi-ai instance.
const piAiEntry = join(dirname(sdkRoot), "pi-ai", "dist", "index.js");
if (!existsSync(piAiEntry)) throw new Error(`pi-ai entry not found: ${piAiEntry}`);

const sdk = await import(pathToFileURL(sdkEntry).href);
const ai = await import(pathToFileURL(piAiEntry).href);
const { AgentSession, createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, createEventBus } = sdk;
const { fauxProvider, fauxAssistantMessage, fauxToolCall } = ai;

// Capability is proven from the PUBLIC API actually used, not from a version.
// `AgentSession.getCallableToolNames` is the public marker that tools can reach
// other tools through `ctx.executeTool`, and `fauxProvider` is the public
// scripted-model boundary this fixture needs.
const hasNestedToolDispatch = typeof AgentSession?.prototype?.getCallableToolNames === "function";
const hasScriptedModel = typeof fauxProvider === "function" && typeof fauxAssistantMessage === "function" && typeof fauxToolCall === "function";
const hasSessionApi = typeof createAgentSession === "function" && typeof ModelRuntime?.create === "function" && typeof SessionManager?.inMemory === "function";
if (!hasNestedToolDispatch || !hasScriptedModel || !hasSessionApi) {
  throw new Error(
    `host SDK at ${sdkRoot} does not expose the public nested-tool API ` +
      `(getCallableToolNames=${hasNestedToolDispatch}, scriptedModel=${hasScriptedModel}, sessionApi=${hasSessionApi})`,
  );
}

const providerEntry = process.env.JORGEX_PERMISSION_FIXTURE_PROVIDER
  ?? join(dirname(sdkRoot), "..", "@gotgenes", "pi-permission-system", "src", "index.ts");
if (!existsSync(providerEntry)) throw new Error(`permission provider entry not found: ${providerEntry}`);
const providerManifest = JSON.parse(readFileSync(join(providerEntry, "..", "..", "package.json"), "utf8"));

const cwd = process.cwd();

// Child tools record a real side effect only when their `execute()` runs, so
// the counters prove whether the SDK dispatched the nested call or the
// permission gate suppressed it.
const effects = { ordinary: 0, denied: 0 };
const executeOutcomes = {};
const hookObservations = [];
const sessionEvents = [];

const fixtureExtension = (pi) => {
  pi.registerTool({
    name: "mcp__fixture__ordinary",
    label: "Nested ordinary fixture",
    description: "Native MCP ordinary child fixture.",
    parameters: { type: "object", properties: { project: { type: "string" }, path: { type: "string" } }, additionalProperties: true },
    async execute() {
      effects.ordinary += 1;
      return { content: [{ type: "text", text: "ordinary-effect" }] };
    },
  });
  pi.registerTool({
    name: "mcp__fixture__denied",
    label: "Nested denied fixture",
    description: "Native MCP denied child fixture.",
    parameters: { type: "object", properties: {}, additionalProperties: true },
    async execute() {
      effects.denied += 1;
      return { content: [{ type: "text", text: "denied-effect" }] };
    },
  });
  const caller = (name, child, args) => {
    pi.registerTool({
      name,
      label: `${name} fixture`,
      description: "Native MCP caller fixture that reaches another tool through ctx.executeTool.",
      parameters: { type: "object", properties: {}, additionalProperties: true },
      async execute(name_, _params, _signal, _onUpdate, ctx) {
        const outcome = await ctx.executeTool(child, args);
        executeOutcomes[name] = {
          isError: outcome.isError === true,
          text: (outcome.result?.content ?? [])
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n"),
        };
        return { content: [{ type: "text", text: `caller:${name_}` }] };
      },
    });
  };
  caller("mcp__fixture__call_ordinary", "mcp__fixture__ordinary", { project: "t73" });
  caller("mcp__fixture__call_protected", "mcp__fixture__ordinary", { path: ".env" });
  caller("mcp__fixture__call_denied", "mcp__fixture__denied", {});
};

const observerExtension = (pi) => {
  pi.on("tool_call", (event) => {
    hookObservations.push({
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      parentToolCallId: event.parentToolCallId,
    });
  });
};

const eventBus = createEventBus();
const loader = new DefaultResourceLoader({
  cwd,
  agentDir,
  extensionFactories: [fixtureExtension, observerExtension],
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
  throw new Error(`native nested permission fixture failed to load extensions: ${JSON.stringify(loaded.errors)}`);
}

// Explicit model runtime: the public pi-ai faux provider replaces the LLM
// transport only. Its own auth descriptor resolves to an empty auth result, so
// no credential or API key is ever provided. The tool loop, hooks and
// `ctx.executeTool` dispatcher stay entirely in the real SDK/AgentSession.
const modelRuntime = await ModelRuntime.create({
  authPath: join(agentDir, "auth.json"),
  modelsPath: null,
  refreshOnCreate: false,
});
const faux = fauxProvider();
modelRuntime.registerNativeProvider(faux.provider);

const { session } = await createAgentSession({
  cwd,
  agentDir,
  modelRuntime,
  model: faux.getModel(),
  resourceLoader: loader,
  sessionManager: SessionManager.inMemory(cwd),
  tools: [
    "mcp__fixture__call_ordinary",
    "mcp__fixture__call_protected",
    "mcp__fixture__call_denied",
    "mcp__fixture__ordinary",
    "mcp__fixture__denied",
  ],
});

session.subscribe((event) => {
  if (event.type === "tool_execution_start") {
    sessionEvents.push({
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      parentToolCallId: event.parentToolCallId,
    });
  }
});

const turns = ["mcp__fixture__call_ordinary", "mcp__fixture__call_protected", "mcp__fixture__call_denied"];
const responses = [];
for (const toolName of turns) {
  responses.push(fauxAssistantMessage([fauxToolCall(toolName, {})]));
  responses.push(fauxAssistantMessage("scripted final turn"));
}
faux.setResponses(responses);

for (let index = 0; index < turns.length; index += 1) {
  await session.prompt(`nested fixture turn ${index}`);
}
await session.dispose();

process.stdout.write(`${JSON.stringify({
  capability: { nestedToolDispatch: hasNestedToolDispatch, scriptedModel: hasScriptedModel, sessionApi: hasSessionApi },
  sdkVersion,
  provider: { name: providerManifest.name, version: providerManifest.version },
  effects,
  executeOutcomes,
  hookObservations,
  sessionEvents,
  isolated: {
    home,
    userProfile,
    agentDir,
    cwd,
    configBytes: readFileSync(permissionConfigPath, "utf8"),
  },
})}\n`);
