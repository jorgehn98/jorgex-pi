import { pathToFileURL } from "node:url";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Real-package probe for the official Engram smoke: loads the ACTUAL
// gentle-engram + pi-mcp-adapter installed by real `engram setup pi`
// (verified stable temp binary) plus the jorgex-pi worktree root through the
// real Pi DefaultResourceLoader/ExtensionRunner. No fake adapter on the bus.
// External network is never needed: ENGRAM_URL points at a discard port so
// gentle cannot spawn a server, fetch is blocked and counted, Context7 is
// only a bus definition, and the DevTools handoff is a fake executable.
const root = process.argv[2];
const gentleIndex = process.argv[3];
const adapterIndex = process.argv[4];
const order = process.argv[5] ?? "adapter-first";
if (!root || !gentleIndex || !adapterIndex) throw new Error("root gentleIndex adapterIndex arguments are required");
if (!["adapter-first", "jorgex-first"].includes(order)) throw new Error(`unknown order: ${order}`);

const sdkRoot = process.env.JORGEX_PI_SDK_ROOT;
const sdk = await import(
  sdkRoot ? pathToFileURL(join(sdkRoot, "dist", "index.js")).href : "@earendil-works/pi-coding-agent"
);
const { createEventBus, DefaultResourceLoader, ExtensionRunner } = sdk;

const RUNTIME_REGISTER_EVENT = "pi-mcp-adapter:runtime-register:v1";
const RUNTIME_SNAPSHOT_EVENT = "pi-mcp-adapter:runtime-snapshot:v1";
const SIX = ["mem_search", "mem_context", "mem_get_observation", "mem_suggest_topic_key", "mem_current_project", "mem_doctor"];

let fetchCount = 0;
const fetchHosts = [];
globalThis.fetch = async (...args) => {
  fetchCount += 1;
  try {
    const raw = typeof args[0] === "string" ? args[0] : args[0]?.url;
    const host = new URL(raw).host;
    if (fetchHosts.length < 10 && !fetchHosts.includes(host)) fetchHosts.push(host);
  } catch {
    // Non-URL fetch input still counts as an attempt without a host.
  }
  throw new Error("network blocked by official real probe");
};

const cwd = process.cwd();
const agentDir = process.env.PI_CODING_AGENT_DIR;
if (!agentDir) throw new Error("PI_CODING_AGENT_DIR is required");
const settingsPath = join(agentDir, "settings.json");
const mcpPath = join(agentDir, "mcp.json");
const metadataCachePath = join(agentDir, "mcp-cache.json");
if (!existsSync(metadataCachePath)) writeFileSync(metadataCachePath, '{"version":1,"servers":{}}\n');

const settingsBefore = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : undefined;
const mcpBefore = existsSync(mcpPath) ? readFileSync(mcpPath, "utf8") : undefined;

const paths = order === "adapter-first" ? [gentleIndex, adapterIndex, root] : [root, gentleIndex, adapterIndex];

const eventBus = createEventBus();
const loader = new DefaultResourceLoader({
  cwd,
  agentDir,
  additionalExtensionPaths: paths,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
  eventBus,
});
await loader.reload();
const loaded = loader.getExtensions();

const entries = [];
const sessionManager = {
  getSessionId: () => "official-real-session",
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

const memTools = [...activeTools].filter((name) => name.startsWith("mem_")).sort();

function emitRegister(name, definition) {
  const request = { version: 1, name, definition };
  eventBus.emit(RUNTIME_REGISTER_EVENT, request);
  return request.result;
}

function emitSnapshot(name) {
  const request = { version: 1, name };
  eventBus.emit(RUNTIME_SNAPSHOT_EVENT, request);
  return request.result;
}

function describeResult(result) {
  if (result === undefined || result === null) return { present: false };
  return {
    present: true,
    ok: result.ok,
    hasTopDispose: typeof result.dispose,
    hasRegistration: result.registration === undefined ? "undefined" : typeof result.registration,
    hasRegDispose: typeof result.registration?.dispose,
    hasTopSnapshot: result.snapshot === undefined ? "undefined" : typeof result.snapshot,
    error: result.error ? String(result.error?.message ?? result.error).slice(0, 200) : undefined,
  };
}

await runner.emit({ type: "session_start", reason: "startup" });
// Bootstrap registers synchronously during session_start; poll a duplicate to
// observe the registration landing without disturbing adapter state.
let bootstrapRegistered = false;
for (let i = 0; i < 200 && !bootstrapRegistered; i++) {
  const dup = emitRegister("context7", { url: "https://mcp.context7.com/mcp", lifecycle: "lazy", directTools: false });
  if (dup?.ok !== true && String(dup?.error?.message ?? dup?.error ?? "").includes("already registered")) {
    bootstrapRegistered = true;
  } else {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const prompt1 = await runner.emitBeforeAgentStart("continue", undefined, "Base policy", { cwd });

// Third-name probe against the REAL adapter: records the actual result shape.
const probeResult = describeResult(
  emitRegister("smoke-probe", { url: "https://mcp.context7.com/mcp", lifecycle: "lazy", directTools: false }),
);

// Snapshots via the real snapshot event (needs the adapter's active state,
// which requires the faithful setup mcp.json with a real binary).
async function snapshotWithPoll(name) {
  let result;
  for (let i = 0; i < 60; i++) {
    result = emitSnapshot(name);
    if (result?.ok === true) {
      return {
        ok: true,
        name: result.snapshot?.name,
        directTools: result.snapshot?.definition?.directTools,
        runtime: result.snapshot?.runtime,
        persisted: result.snapshot?.persisted,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return { ok: false, error: String(result?.error?.message ?? result?.error ?? "snapshot unavailable") };
}
const snapshotContext7 = await snapshotWithPoll("context7");
const snapshotDevtools = await snapshotWithPoll("chrome-devtools");

// Dispose through the REAL shape and verify idempotence + re-registration.
// Re-emit to capture the live result object for disposal.
const disposable = (() => {
  const request = {
    version: 1,
    name: "smoke-dispose-probe",
    definition: { url: "https://mcp.context7.com/mcp", lifecycle: "lazy", directTools: false },
  };
  eventBus.emit(RUNTIME_REGISTER_EVENT, request);
  return request.result;
})();
let dispose1 = "NO-RESULT";
let dispose2 = "NO-RESULT";
if (disposable?.ok === true) {
  const disp = disposable.registration?.dispose ?? disposable.dispose;
  if (typeof disp === "function") {
    try {
      await disp();
      dispose1 = "ok";
    } catch (error) {
      dispose1 = `throw:${error instanceof Error ? error.message : String(error)}`;
    }
    try {
      await disp();
      dispose2 = dispose1 === "ok" ? "ok-idempotent" : "throw";
    } catch (error) {
      dispose2 = `throw:${error instanceof Error ? error.message : String(error)}`;
    }
  } else {
    dispose1 = "NO-DISPOSE-FUNCTION";
  }
}
const reRegister = emitRegister("smoke-dispose-probe", {
  url: "https://mcp.context7.com/mcp",
  lifecycle: "lazy",
  directTools: false,
});
const reRegisterOk = reRegister?.ok === true;
try {
  await (reRegister?.registration?.dispose ?? reRegister?.dispose)?.();
} catch {
  // Best-effort residue cleanup; the assertion below already recorded reRegisterOk.
}

await runner.emit({ type: "session_shutdown" });
// Second session on the same runner: bootstrap must release the first
// session's registrations on shutdown for the next registration to succeed.
// Prove release before the next start: a manual re-registration for the same
// name after shutdown must succeed (real duplicate fails closed); dispose it
// immediately so the next session's bootstrap can re-register the same name.
const dupAfterShutdown = emitRegister("context7", {
  url: "https://mcp.context7.com/mcp",
  lifecycle: "lazy",
  directTools: false,
});
const dupAfterShutdownOk = dupAfterShutdown?.ok === true;
try {
  await (dupAfterShutdown?.registration?.dispose ?? dupAfterShutdown?.dispose)?.();
} catch {
  // Best-effort cleanup of the disposal proof; the assertion below records dupAfterShutdownOk.
}
await runner.emit({ type: "session_start", reason: "restart" });
const prompt2 = await runner.emitBeforeAgentStart("continue", undefined, "Base policy", { cwd });
const secondSession = {
  promptHasContext7: (prompt2?.systemPrompt ?? "").includes("jorgex:context7"),
  duplicateError: dupAfterShutdownOk
    ? null
    : String(dupAfterShutdown?.error?.message ?? dupAfterShutdown?.error ?? "absent"),
};
await runner.emit({ type: "session_shutdown" });

const settingsAfter = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : undefined;
const mcpAfter = existsSync(mcpPath) ? readFileSync(mcpPath, "utf8") : undefined;

let piVersion = "unknown";
try {
  const sdkManifest = sdkRoot
    ? JSON.parse(readFileSync(join(sdkRoot, "package.json"), "utf8"))
    : await import("@earendil-works/pi-coding-agent/package.json", { with: { type: "json" } }).then((m) => m.default);
  piVersion = sdkManifest.version ?? piVersion;
} catch {
  // piVersion stays unknown; the test asserts versions via contract, not here.
}

process.stdout.write(
  `${JSON.stringify({
    order,
    piVersion,
    loaderErrors: loaded.errors,
    sixPresent: SIX.filter((name) => memTools.includes(name)),
    sixMissing: SIX.filter((name) => !memTools.includes(name)),
    memTools,
    bootstrapRegistered,
    prompt1HasContext7: (prompt1?.systemPrompt ?? "").includes("jorgex:context7"),
    prompt1HasPolicy: (prompt1?.systemPrompt ?? "").includes("jorgex:system-prompt"),
    probeResultShape: probeResult,
    snapshotContext7,
    snapshotDevtools,
    dispose1,
    dispose2,
    reRegisterAfterDispose: reRegisterOk,
    secondSession,
    settingsUnchanged: settingsBefore === settingsAfter,
    mcpUnchanged: mcpBefore === mcpAfter,
    fetchCount,
    fetchHosts,
    isolation: {
      home: process.env.HOME,
      agentDir: process.env.PI_CODING_AGENT_DIR,
      cwd,
      piPackageDirConfigured: Object.hasOwn(process.env, "PI_PACKAGE_DIR"),
    },
  })}\n`,
);
