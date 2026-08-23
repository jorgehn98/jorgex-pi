import { DefaultResourceLoader, ExtensionRunner } from "@earendil-works/pi-coding-agent";
import { writeFileSync } from "node:fs";

const root = process.argv[2];
if (!root) throw new Error("package root argument is required");

const loader = new DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir: process.env.PI_CODING_AGENT_DIR,
  additionalExtensionPaths: [root],
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
});
await loader.reload();
const loaded = loader.getExtensions();

let activeTools = [];
const runner = new ExtensionRunner(
  loaded.extensions,
  loaded.runtime,
  process.cwd(),
  { getSessionId: () => "loader-session" },
  {},
);
runner.bindCore(
  {
    sendMessage() {},
    sendUserMessage() {},
    appendEntry() {},
    setSessionName() {},
    getSessionName: () => undefined,
    setLabel() {},
    getActiveTools: () => [...activeTools],
    getAllTools: () => [],
    setActiveTools: (names) => { activeTools = [...names]; },
    refreshTools() {},
    getCommands: () => [],
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
const guard = await runner.emitToolCall({
  type: "tool_call",
  toolName: "bash",
  toolCallId: "pre-health",
  input: { command: "echo must-not-run" },
});

writeFileSync(1, `${JSON.stringify({
  errors: loaded.errors,
  extensionCount: loaded.extensions.length,
  guard,
  isolation: {
    home: process.env.HOME,
    agentDir: process.env.PI_CODING_AGENT_DIR,
    xdgConfig: process.env.XDG_CONFIG_HOME,
    tempRoot: process.env.PI_SUBAGENTS_TEMP_ROOT,
    piPackageDirConfigured: Object.hasOwn(process.env, "PI_PACKAGE_DIR"),
  },
})}\n`);
