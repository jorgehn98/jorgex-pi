import { pathToFileURL } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2];
if (!root) throw new Error("package root argument is required");

const sdkRoot = process.env.JORGEX_PI_SDK_ROOT;
const sdk = await import(sdkRoot
  ? pathToFileURL(join(sdkRoot, "dist", "index.js")).href
  : "@earendil-works/pi-coding-agent");
const { createEventBus, DefaultResourceLoader, ExtensionRunner } = sdk;

const cwd = process.cwd();
const agentDir = process.env.PI_CODING_AGENT_DIR;
if (!agentDir) throw new Error("PI_CODING_AGENT_DIR is required");

const eventBus = createEventBus();
const loader = new DefaultResourceLoader({
  cwd,
  agentDir,
  additionalExtensionPaths: [
    join(root, "node_modules", "@gotgenes", "pi-permission-system", "src", "index.ts"),
    join(root, "tests", "fixtures", "permissions-tools.ts"),
    join(root, "extensions", "git-read.ts"),
    join(root, "tests", "fixtures", "permissions-observer.ts"),
  ],
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
  eventBus,
});
await loader.reload();
const loaded = loader.getExtensions();
if (loaded.errors.length > 0) {
  throw new Error(`Pi permission fixture failed to load extensions: ${JSON.stringify(loaded.errors)}`);
}

const entries = [];
const sessionManager = {
  getSessionId: () => "permission-fixture-session",
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
let serviceReport;
eventBus.on("permissions-fixture:service", (report) => { serviceReport = report; });
await runner.emit({ type: "session_start", reason: "startup" });
await runner.emitBeforeAgentStart("permission fixture", undefined, "Base policy", { cwd });

if (!serviceReport) throw new Error("Pi permission service was not published for the fixture session");

const calls = {
  knownTool: await runner.emitToolCall({
    type: "tool_call",
    toolName: "known_tool",
    toolCallId: "known-tool",
    input: {},
  }),
  unknownPolicyTool: await runner.emitToolCall({
    type: "tool_call",
    toolName: "unclassified_tool",
    toolCallId: "unknown-policy-tool",
    input: {},
  }),
  mcpKnown: await runner.emitToolCall({
    type: "tool_call",
    toolName: "mcp",
    toolCallId: "mcp-known",
    input: { server: "context7", tool: "resolve-library-id" },
  }),
  mcpUnknown: await runner.emitToolCall({
    type: "tool_call",
    toolName: "mcp",
    toolCallId: "mcp-unknown",
    input: { server: "future", tool: "unknown-tool" },
  }),
  bashOrdinary: await runner.emitToolCall({
    type: "tool_call",
    toolName: "bash",
    toolCallId: "bash-ordinary",
    input: { command: "echo ordinary" },
  }),
  bashAsk: await runner.emitToolCall({
    type: "tool_call",
    toolName: "bash",
    toolCallId: "bash-ask",
    input: { command: "printf waiting" },
  }),
  bashDeny: await runner.emitToolCall({
    type: "tool_call",
    toolName: "bash",
    toolCallId: "bash-deny",
    input: { command: "rm -rf build" },
  }),
  bashCompound: await runner.emitToolCall({
    type: "tool_call",
    toolName: "bash",
    toolCallId: "bash-compound",
    input: { command: "echo ordinary && rm -rf build" },
  }),
  ordinary: await runner.emitToolCall({
    type: "tool_call",
    toolName: "git_read",
    toolCallId: "ordinary",
    input: { action: "diff", args: ["--", "src/index.ts"] },
  }),
  secret: await runner.emitToolCall({
    type: "tool_call",
    toolName: "git_read",
    toolCallId: "secret",
    input: { action: "diff", args: ["--", ".env"] },
  }),
  multiple: await runner.emitToolCall({
    type: "tool_call",
    toolName: "git_read",
    toolCallId: "multiple",
    input: { action: "diff", args: ["--", "src/index.ts", ".env"] },
  }),
  example: await runner.emitToolCall({
    type: "tool_call",
    toolName: "git_read",
    toolCallId: "example",
    input: { action: "diff", args: ["--", ".env.example"] },
  }),
  askPath: await runner.emitToolCall({
    type: "tool_call",
    toolName: "git_read",
    toolCallId: "ask-path",
    input: { action: "diff", args: ["--", "docs/guide.md"] },
  }),
};

let canonicalCalls;
if (process.env.JORGEX_PERMISSION_FIXTURE_CANONICAL === "1") {
  canonicalCalls = {
    bashOrdinary: await runner.emitToolCall({
      type: "tool_call",
      toolName: "bash",
      toolCallId: "canonical-bash-ordinary",
      input: { command: "echo canonical" },
    }),
    bashRemove: await runner.emitToolCall({
      type: "tool_call",
      toolName: "bash",
      toolCallId: "canonical-bash-remove",
      input: { command: "rm -rf build" },
    }),
    bashReset: await runner.emitToolCall({
      type: "tool_call",
      toolName: "bash",
      toolCallId: "canonical-bash-reset",
      input: { command: "git reset --hard HEAD" },
    }),
    bashForcePush: await runner.emitToolCall({
      type: "tool_call",
      toolName: "bash",
      toolCallId: "canonical-bash-force-push",
      input: { command: "git push --force origin main" },
    }),
    bashSudo: await runner.emitToolCall({
      type: "tool_call",
      toolName: "bash",
      toolCallId: "canonical-bash-sudo",
      input: { command: "sudo echo canonical" },
    }),
    bashSecret: await runner.emitToolCall({
      type: "tool_call",
      toolName: "bash",
      toolCallId: "canonical-bash-secret",
      input: { command: "cat .env" },
    }),
    bashMkfs: await runner.emitToolCall({
      type: "tool_call",
      toolName: "bash",
      toolCallId: "canonical-bash-mkfs",
      input: { command: "mkfs.ext4 /dev/null" },
    }),
    bashDd: await runner.emitToolCall({
      type: "tool_call",
      toolName: "bash",
      toolCallId: "canonical-bash-dd",
      input: { command: "dd if=/dev/zero of=canonical.img" },
    }),
    readInside: await runner.emitToolCall({
      type: "tool_call",
      toolName: "read",
      toolCallId: "canonical-read-inside",
      input: { path: "docs/guide.md" },
    }),
    readOutside: await runner.emitToolCall({
      type: "tool_call",
      toolName: "read",
      toolCallId: "canonical-read-outside",
      input: { path: "/tmp/jorgex-permission-ordinary.txt" },
    }),
    editInside: await runner.emitToolCall({
      type: "tool_call",
      toolName: "edit",
      toolCallId: "canonical-edit-inside",
      input: { path: "docs/guide.md" },
    }),
    mcpEngram: await runner.emitToolCall({
      type: "tool_call",
      toolName: "mcp",
      toolCallId: "canonical-mcp-engram",
      input: { server: "engram", tool: "mem_context" },
    }),
    mcpContext7: await runner.emitToolCall({
      type: "tool_call",
      toolName: "mcp",
      toolCallId: "canonical-mcp-context7",
      input: { server: "context7", tool: "resolve-library-id" },
    }),
    mcpUnknown: await runner.emitToolCall({
      type: "tool_call",
      toolName: "mcp",
      toolCallId: "canonical-mcp-unknown",
      input: { server: "future", tool: "unknown-tool" },
    }),
  };
}

entries.push({ type: "custom", customType: "active_agent", data: { name: "restricted-agent" } });
await runner.emitBeforeAgentStart("permission fixture agent", undefined, '<active_agent name="allow-agent">', { cwd });
const agentOverride = await runner.emitToolCall({
  type: "tool_call",
  toolName: "git_read",
  toolCallId: "agent-override",
  input: { action: "diff", args: ["--", "docs/guide.md", "src/index.ts"] },
});
const projectOverride = await runner.emitToolCall({
  type: "tool_call",
  toolCallId: "project-override",
  toolName: "read",
  input: { path: "docs/guide.md" },
});

await runner.emit({ type: "session_shutdown" });

process.stdout.write(`${JSON.stringify({
  toolNames: runner.getAllRegisteredTools().map(({ definition }) => definition.name).sort(),
  serviceCheck: serviceReport.path,
  toolPermission: serviceReport.tool,
  calls,
  agentOverride,
  projectOverride,
  canonicalCalls,
  decisions,
  config: readFileSync(join(agentDir, "extensions", "pi-permission-system", "config.json"), "utf8"),
  isolated: {
    home: process.env.HOME,
    agentDir,
    cwd,
    noAmbientConfig: !existsSync(join(cwd, ".pi", "extensions", "pi-permission-system", "config.json")),
  },
})}\n`);
