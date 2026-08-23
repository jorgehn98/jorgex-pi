import { createEventBus, DefaultResourceLoader, ExtensionRunner } from "@earendil-works/pi-coding-agent";
import { writeFileSync } from "node:fs";

const root = process.argv[2];
if (!root) throw new Error("package root argument is required");

const eventBus = createEventBus();
const loader = new DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir: process.env.PI_CODING_AGENT_DIR,
  additionalExtensionPaths: [root],
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
  eventBus,
});
await loader.reload();
const loaded = loader.getExtensions();

let activeTools = [];
const entries = [];
const sentUserMessages = [];
const sessionManager = {
  getSessionId: () => "loader-session",
  getSessionDir: () => process.cwd(),
  getEntries: () => entries,
  getBranch: () => entries,
};
const runner = new ExtensionRunner(
  loaded.extensions,
  loaded.runtime,
  process.cwd(),
  sessionManager,
  {},
);
runner.bindCore(
  {
    sendMessage() {},
    sendUserMessage(message) { sentUserMessages.push(message); },
    appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
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
activeTools = runner.getAllRegisteredTools().map(({ definition }) => definition.name);
const guard = await runner.emitToolCall({
  type: "tool_call",
  toolName: "bash",
  toolCallId: "pre-health",
  input: { command: "echo must-not-run" },
});

const realToolNames = runner.getAllRegisteredTools().map(({ definition }) => definition.name).sort();
const realCommandNames = runner.getRegisteredCommands().map(({ name }) => name).sort();
await runner.emit({ type: "session_start", reason: "startup" });
const goalCommand = runner.getCommand("goal");
if (!goalCommand) throw new Error("real /goal command was not registered");
await goalCommand.handler("verify real Goal routing", runner.createCommandContext());
const promptResult = await runner.emitBeforeAgentStart(
  "continue",
  undefined,
  "Base policy",
  { cwd: process.cwd() },
);
const managedRunEvents = [];
eventBus.on("pi-goal:event:loader-rpc", (event) => managedRunEvents.push(event));
eventBus.emit("pi-goal:start", { runId: "loader-rpc", objective: "must remain disabled" });
await new Promise((resolve) => setImmediate(resolve));

writeFileSync(1, `${JSON.stringify({
  errors: loaded.errors,
  extensionCount: loaded.extensions.length,
  guard,
  realGoal: {
    commandNames: realCommandNames,
    toolNames: realToolNames,
    prompt: promptResult?.systemPrompt,
    sentUserMessageCount: sentUserMessages.length,
    managedRunEvents,
  },
  isolation: {
    home: process.env.HOME,
    agentDir: process.env.PI_CODING_AGENT_DIR,
    xdgConfig: process.env.XDG_CONFIG_HOME,
    tempRoot: process.env.PI_SUBAGENTS_TEMP_ROOT,
    piPackageDirConfigured: Object.hasOwn(process.env, "PI_PACKAGE_DIR"),
  },
})}\n`);
