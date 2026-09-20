import { createEventBus, DefaultResourceLoader, ExtensionRunner } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const probeDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(probeDir, "..", "..");

const POSITIVE = [
  "mem_search",
  "mem_context",
  "mem_get_observation",
  "mem_suggest_topic_key",
  "mem_current_project",
  "mem_doctor",
];

let fetchCount = 0;
globalThis.fetch = async (...args) => {
  fetchCount += 1;
  throw new Error("network blocked by engram child probe");
};

const jiti = createJiti(import.meta.url, { moduleCache: false });

function isolation() {
  return {
    home: process.env.HOME,
    userprofile: process.env.USERPROFILE,
    agentDir: process.env.PI_CODING_AGENT_DIR,
    xdgConfig: process.env.XDG_CONFIG_HOME,
    xdgCache: process.env.XDG_CACHE_HOME,
    xdgData: process.env.XDG_DATA_HOME,
    temp: process.env.TEMP,
    tmp: process.env.TMP,
    tmpdir: process.env.TMPDIR,
    subagentsTemp: process.env.PI_SUBAGENTS_TEMP_ROOT,
    path: process.env.PATH,
    engramBin: process.env.ENGRAM_BIN,
    mcpDirectTools: process.env.MCP_DIRECT_TOOLS,
    cwd: process.cwd(),
    piPackageDirConfigured: Object.hasOwn(process.env, "PI_PACKAGE_DIR"),
  };
}

async function resolvePreflight() {
  const { resolveSubagentLaunchContract } = await jiti.import("pi-subagents/preflight");
  const result = await resolveSubagentLaunchContract({
    agent: "engram",
    cwd: process.cwd(),
    context: "fresh",
    artifacts: false,
  });
  if (!result.ok) {
    return { ok: false, code: result.code, message: result.message, diagnostics: result.diagnostics };
  }
  return {
    ok: true,
    model: result.contract.model,
    modelCandidates: result.contract.modelCandidates,
    effectiveAllowlist: result.contract.tools.effectiveAllowlist,
    requiredChildTools: result.contract.tools.requiredChildTools,
    effectiveMcpTools: result.contract.tools.effectiveMcpTools,
    explicitAllowlist: result.contract.tools.explicitAllowlist,
    extensionArgs: result.contract.tools.extensionArgs,
    configuredExtensions: result.contract.tools.configuredExtensions,
    diagnostics: result.contract.diagnostics,
  };
}

async function runChildRuntime(preflight) {
  const required = preflight.ok ? preflight.requiredChildTools : [...POSITIVE];
  const effectiveMcp = preflight.ok ? preflight.effectiveMcpTools : [];
  const extensionArgs = preflight.ok ? preflight.extensionArgs : [];
  // Derive the child env exactly as pi-subagents buildPiArgs does from the
  // contract: required tools pin the pre-turn diagnostic, effectiveMcpTools
  // selects MCP direct tools, and an empty MCP set becomes "__none__".
  const base = process.env.PI_SUBAGENTS_TEMP_ROOT;
  mkdirSync(base, { recursive: true });
  const diagnosticPath = join(base, `tool-diagnostic-${process.pid}.json`);
  try { await import("node:fs").then((fs) => fs.rmSync(diagnosticPath, { force: true })); } catch { /* fresh diagnostic */ }
  process.env.PI_SUBAGENT_REQUIRED_TOOLS = JSON.stringify(required);
  process.env.PI_SUBAGENT_TOOL_DIAGNOSTIC_PATH = diagnosticPath;
  if (effectiveMcp.length > 0) process.env.PI_SUBAGENT_MCP_DIRECT_TOOLS = JSON.stringify(effectiveMcp);
  else delete process.env.PI_SUBAGENT_MCP_DIRECT_TOOLS;
  if (effectiveMcp.length === 0) process.env.MCP_DIRECT_TOOLS = "__none__";
  else process.env.MCP_DIRECT_TOOLS = effectiveMcp.join(",");
  process.env.PI_SUBAGENT_CHILD_AGENT = "engram";
  process.env.PI_SUBAGENT_CHILD = "1";
  const envBeforeLoad = process.env.MCP_DIRECT_TOOLS;

  const agentDir = process.env.PI_CODING_AGENT_DIR;
  const metadataCachePath = join(agentDir, "mcp-cache.json");
  if (!existsSync(metadataCachePath)) writeFileSync(metadataCachePath, '{"version":1,"servers":{}}\n');

  // Real package order: contract CLI extensionArgs first (prompt-runtime,
  // then the engram child-only shim from the installed sandbox copy), package
  // root last so ambient bootstrap loads after them — the same CLI-before-
  // ambient merge Pi uses for --extension flags. No separate artificial
  // installer: the bundled adapter arrives via the real bootstrap path.
  const additionalExtensionPaths = [...extensionArgs, root];
  const eventBus = createEventBus();
  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir,
    additionalExtensionPaths,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    eventBus,
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  const loadOrder = loaded.extensions.map((entry) => entry.path);
  const envAfterLoad = process.env.MCP_DIRECT_TOOLS;

  let activeTools = [];
  const entries = [];
  const sessionManager = {
    getSessionId: () => "child-session",
    getSessionDir: () => process.cwd(),
    getEntries: () => entries,
    getBranch: () => entries,
  };
  const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, process.cwd(), sessionManager, {});
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
  await runner.emit({ type: "session_start", reason: "startup" });
  await waitFor(
    () => runner.getAllRegisteredTools().some(({ definition }) => definition.name.startsWith("mem_")),
    { timeoutMs: 8_000, intervalMs: 50 },
  );
  const allTools = runner.getAllRegisteredTools().map(({ definition }) => definition.name).sort();
  const envAfterSessionStart = process.env.MCP_DIRECT_TOOLS;
  // Real pre-turn diagnostic: prompt-runtime writes it on agent_start from
  // pi.getAllTools() observed above, never from a hardcoded list. The file
  // must really be written: wait boundedly for it.
  await runner.emit({ type: "agent_start" });
  const firstAppeared = await waitFor(() => existsSync(diagnosticPath), { timeoutMs: 2_000, intervalMs: 50 });

  // Canary proof that the writer fires: production deletes the file when
  // nothing is missing, so absence alone proves nothing. Re-emit requiring a
  // never-registered tool; the file must then list it. Afterwards restore and
  // re-emit to leave the genuine diagnostic behind.
  const CANARY = "probe_canary_never_registered";
  process.env.PI_SUBAGENT_REQUIRED_TOOLS = JSON.stringify([...required, CANARY]);
  await runner.emit({ type: "agent_start" });
  const canaryAppeared = await waitFor(() => existsSync(diagnosticPath), { timeoutMs: 2_000, intervalMs: 50 });
  let canaryListed = false;
  if (canaryAppeared) {
    try {
      canaryListed = (JSON.parse(readFileSync(diagnosticPath, "utf8")).missing ?? []).includes(CANARY);
    } catch { canaryListed = false; }
  }
  process.env.PI_SUBAGENT_REQUIRED_TOOLS = JSON.stringify(required);
  await runner.emit({ type: "agent_start" });
  const finalAppeared = await waitFor(() => existsSync(diagnosticPath), { timeoutMs: 2_000, intervalMs: 50 });
  // When clean, production deletes the file: observe the delete as proof.
  const cleanDeleteObserved = !finalAppeared && canaryListed;
  let diagnostic = { required, missing: [...required], available: allTools, diagnosticPath };
  if (finalAppeared) {
    try { diagnostic = { ...diagnostic, ...JSON.parse(readFileSync(diagnosticPath, "utf8")), diagnosticPath }; }
    catch (error) { diagnostic = { ...diagnostic, readError: error instanceof Error ? error.message : String(error) }; }
  } else if (canaryListed && required.every((name) => allTools.includes(name))) {
    diagnostic = { ...diagnostic, missing: [], cleanDeleteObserved };
  } else {
    diagnostic = { ...diagnostic, timedOut: true };
  }
  diagnostic = { ...diagnostic, fileAppearedFirstEmit: firstAppeared, writerProof: { canaryListed, cleanDeleteObserved } };
  const envAfterAgentStart = process.env.MCP_DIRECT_TOOLS;

  // Execute through the definition registered in the child runtime: tool
  // objects from getAllRegisteredTools() carry { definition, sourceInfo } and
  // the executable lives at definition.execute.
  let executed = { ok: false, error: "mem_doctor not registered in child runtime" };
  const found = runner.getAllRegisteredTools().find(({ definition }) => definition.name === "mem_doctor");
  if (found && found.definition && typeof found.definition.execute === "function") {
    try {
      const result = await found.definition.execute("probe-call", {}, undefined);
      const text = result?.content?.[0]?.text ?? "";
      let payload;
      try { payload = JSON.parse(text); } catch { payload = { raw: text }; }
      executed = { ok: true, result, payload };
    } catch (error) {
      executed = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  // Mutant through the same registry: mem_save must have no definition even
  // when a hostile backend advertises it; only direct registration counts.
  let executedMutant = { ok: false, error: "mem_save not registered in child runtime" };
  const mutant = runner.getAllRegisteredTools().find(({ definition }) => definition.name === "mem_save");
  if (mutant && mutant.definition && typeof mutant.definition.execute === "function") {
    try {
      const result = await mutant.definition.execute("probe-call-mutant", {}, undefined);
      executedMutant = { ok: true, result };
    } catch (error) {
      executedMutant = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  // Negative through the same registry: mutating tools must not be registered.
  const negativeDefinitions = ["mem_save", "mem_session_summary", "bash", "subagent"]
    .map((name) => ({ name, registered: allTools.includes(name) }));

  await runner.emit({ type: "session_shutdown" });
  return {
    extensionArgs,
    additionalExtensionPaths,
    loadOrder,
    loaderErrors: loaded.errors,
    allTools,
    memTools: allTools.filter((name) => name.startsWith("mem_")),
    diagnostic,
    executed,
    executedMutant,
    negativeDefinitions,
    mcpDirectToolsEnv: process.env.MCP_DIRECT_TOOLS,
    envBeforeLoad,
    envAfterLoad,
    envAfterSessionStart,
    envAfterAgentStart,
  };
}

async function checkShimRestore() {
  // Closest seam for the shim restore paths: invoke the real production
  // module directly with a fake pi, no network and no model.
  const savedAgent = process.env.PI_SUBAGENT_CHILD_AGENT;
  const savedDirect = process.env.MCP_DIRECT_TOOLS;
  const hasDirect = () => Object.hasOwn(process.env, "MCP_DIRECT_TOOLS");
  const readDirect = () => (hasDirect() ? process.env.MCP_DIRECT_TOOLS : null);
  try {
    const { default: engramChildMcpSelection } = await jiti.import(join(root, "extensions", "engram-child.ts"));
    const fakePi = () => {
      const handlers = {};
      return { handlers, on(event, fn) { (handlers[event] ??= []).push(fn); } };
    };
    const fire = (pi, event) => { for (const fn of pi.handlers[event] ?? []) fn(); };

    // previous undefined → six during load, deleted on restore
    delete process.env.MCP_DIRECT_TOOLS;
    process.env.PI_SUBAGENT_CHILD_AGENT = "engram";
    const piUndef = fakePi();
    await engramChildMcpSelection(piUndef);
    const undefDuringLoad = readDirect();
    fire(piUndef, "agent_start");
    const undefAfterAgentStart = readDirect();
    fire(piUndef, "agent_start");
    const undefAfterSecondAgentStart = readDirect();
    fire(piUndef, "session_shutdown");
    const undefAfterShutdown = readDirect();

    // previous foreign list → replaced by six during load, restored exactly
    process.env.MCP_DIRECT_TOOLS = "foreign,keep-me";
    const piForeign = fakePi();
    await engramChildMcpSelection(piForeign);
    const foreignDuringLoad = readDirect();
    fire(piForeign, "agent_start");
    const foreignAfterAgentStart = readDirect();
    fire(piForeign, "agent_start");
    const foreignAfterSecond = readDirect();

    // shutdown without agent_start restores (fresh instances)
    delete process.env.MCP_DIRECT_TOOLS;
    const piShutdownUndef = fakePi();
    await engramChildMcpSelection(piShutdownUndef);
    fire(piShutdownUndef, "session_shutdown");
    const shutdownUndefAfter = readDirect();
    process.env.MCP_DIRECT_TOOLS = "foreign,keep-me";
    const piShutdownForeign = fakePi();
    await engramChildMcpSelection(piShutdownForeign);
    fire(piShutdownForeign, "session_shutdown");
    const shutdownForeignAfter = readDirect();

    // other agent → noop, no handlers, env untouched
    process.env.MCP_DIRECT_TOOLS = "untouched";
    process.env.PI_SUBAGENT_CHILD_AGENT = "other-agent";
    const piOther = fakePi();
    await engramChildMcpSelection(piOther);
    const nonEngramAfter = readDirect();
    const nonEngramHandlers = {
      agent_start: piOther.handlers.agent_start?.length ?? 0,
      session_shutdown: piOther.handlers.session_shutdown?.length ?? 0,
    };

    return {
      undefDuringLoad, undefAfterAgentStart, undefAfterSecondAgentStart, undefAfterShutdown,
      foreignBefore: "foreign,keep-me", foreignDuringLoad, foreignAfterAgentStart, foreignAfterSecond,
      shutdownUndefAfter, shutdownForeignBefore: "foreign,keep-me", shutdownForeignAfter,
      nonEngramAfter, nonEngramHandlers,
    };
  } finally {
    if (savedAgent === undefined) delete process.env.PI_SUBAGENT_CHILD_AGENT;
    else process.env.PI_SUBAGENT_CHILD_AGENT = savedAgent;
    if (savedDirect === undefined) delete process.env.MCP_DIRECT_TOOLS;
    else process.env.MCP_DIRECT_TOOLS = savedDirect;
  }
}

async function waitFor(predicate, { timeoutMs, intervalMs }) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(intervalMs, remaining)));
  }
  return true;
}

try {
  const preflight = await resolvePreflight();
  const shimRestore = await checkShimRestore();
  const child = await runChildRuntime(preflight);
  writeFileSync(1, `${JSON.stringify({
    positive: POSITIVE,
    isolation: isolation(),
    fetchCount,
    preflight,
    shimRestore,
    child,
  })}\n`);
} catch (error) {
  writeFileSync(1, `${JSON.stringify({ fatal: error instanceof Error ? { message: error.message, stack: error.stack } : String(error) })}\n`);
  process.exitCode = 1;
}
