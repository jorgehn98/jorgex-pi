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
  // ambient merge Pi uses for --extension flags. The official bridge never
  // installs an adapter, so the probe appends its own stand-in for the
  // provider-managed transport (see probe-official-adapter.ts) after the
  // production extensions. This stand-in is test-only and is not installed by
  // the production bootstrap.
  const additionalExtensionPaths = [...extensionArgs, root, join(probeDir, "probe-official-adapter.ts")];
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
  // Probe-side transport signal for the stand-in adapter: the retired shim
  // used to publish the six selectors before session_start and restore the
  // previous value on agent_start. Production sets nothing (gentle-engram
  // provides native tools); the probe reproduces the signal window so the
  // test-only stand-in registers direct tools, then restores it.
  const transportSelectors = [...POSITIVE].map((name) => `engram/${name}`).join(",");
  process.env.MCP_DIRECT_TOOLS = transportSelectors;
  await runner.emit({ type: "session_start", reason: "startup" });
  await waitFor(
    () => runner.getAllRegisteredTools().some(({ definition }) => definition.name.startsWith("mem_")),
    { timeoutMs: 8_000, intervalMs: 50 },
  );
  const allTools = runner.getAllRegisteredTools().map(({ definition }) => definition.name).sort();
  const envAfterSessionStart = process.env.MCP_DIRECT_TOOLS;
  // Security: the child config disables the proxy gateway and script tool.
  // The proxy may exist transiently before the adapter syncs direct tools, so
  // wait boundedly for its deactivation and fail if it persists. Active tools
  // are only observed here, never preset to a favorable set.
  const proxyDeactivated = await waitFor(
    () => !activeTools.includes("mcp") && !activeTools.includes("mcpScript"),
    { timeoutMs: 8_000, intervalMs: 50 },
  );
  process.env.MCP_DIRECT_TOOLS = "__none__";
  const activeAfterStart = [...activeTools];
  // Gateway attempt through the live active set: with the proxy deactivated
  // there must be no active mcp definition to invoke. Registry presence alone
  // (inactive) is recorded as evidence, not as invocation surface.
  const gatewayActive = runner.getAllRegisteredTools()
    .filter(({ definition }) => activeAfterStart.includes(definition.name))
    .find(({ definition }) => definition.name === "mcp");
  const gatewayAttempt = { active: gatewayActive !== undefined, invokable: false };
  if (gatewayActive?.definition && typeof gatewayActive.definition.execute === "function") {
    try {
      const result = await gatewayActive.definition.execute("probe-gateway", { action: "status" }, undefined);
      gatewayAttempt.invokable = true;
      gatewayAttempt.result = result;
    } catch (error) {
      gatewayAttempt.error = error instanceof Error ? error.message : String(error);
    }
  } else {
    gatewayAttempt.error = "mcp has no active definition in the child runtime";
  }
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

  // Fail-closed gate at the real dispatch seam: the shim tool_call handler
  // must block the mcp gateway before any backend execution. Recorded while
  // the runtime is still live, before shutdown restore.
  const gateMcp = await runner.emitToolCall({
    type: "tool_call",
    toolName: "mcp",
    toolCallId: "probe-gate-mcp",
    input: { tool: "mem_save", server: "engram", args: {} },
  });

  await runner.emit({ type: "session_shutdown" });
  return {
    extensionArgs,
    additionalExtensionPaths,
    loadOrder,
    loaderErrors: loaded.errors,
    allTools,
    activeAfterStart,
    proxy: {
      deactivatedInTime: proxyDeactivated,
      mcpRegistered: allTools.includes("mcp"),
      mcpScriptRegistered: allTools.includes("mcpScript"),
      mcpActive: activeAfterStart.includes("mcp"),
      mcpScriptActive: activeAfterStart.includes("mcpScript"),
    },
    gatewayAttempt,
    toolCallGate: { mcp: gateMcp ?? null },
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
  // Closest seam for the official shim contract: invoke the real production
  // module directly with a fake pi, no network and no model. gentle-engram
  // provides native tools, so the shim must leave the process environment
  // untouched in every lifecycle transition and register only its tool_call
  // gate (covered separately by checkShimToolCall).
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

    // previous undefined → untouched through load, agent_start and shutdown
    delete process.env.MCP_DIRECT_TOOLS;
    process.env.PI_SUBAGENT_CHILD_AGENT = "engram";
    const piUndef = fakePi();
    await engramChildMcpSelection(piUndef);
    const undefDuringLoad = readDirect();
    fire(piUndef, "agent_start");
    const undefAfterAgentStart = readDirect();
    fire(piUndef, "session_shutdown");
    const undefAfterShutdown = readDirect();

    // previous foreign list → preserved exactly, never replaced or restored
    process.env.MCP_DIRECT_TOOLS = "foreign,keep-me";
    const piForeign = fakePi();
    await engramChildMcpSelection(piForeign);
    const foreignDuringLoad = readDirect();
    fire(piForeign, "agent_start");
    const foreignAfterAgentStart = readDirect();
    fire(piForeign, "session_shutdown");
    const foreignAfterShutdown = readDirect();

    // other agent → noop, no handlers, env untouched
    process.env.MCP_DIRECT_TOOLS = "untouched";
    process.env.PI_SUBAGENT_CHILD_AGENT = "other-agent";
    const piOther = fakePi();
    await engramChildMcpSelection(piOther);
    const nonEngramAfter = readDirect();
    const nonEngramHandlers = {
      tool_call: piOther.handlers.tool_call?.length ?? 0,
      agent_start: piOther.handlers.agent_start?.length ?? 0,
      session_shutdown: piOther.handlers.session_shutdown?.length ?? 0,
    };

    return {
      undefDuringLoad, undefAfterAgentStart, undefAfterShutdown,
      foreignBefore: "foreign,keep-me", foreignDuringLoad, foreignAfterAgentStart, foreignAfterShutdown,
      nonEngramAfter, nonEngramHandlers,
      engramHandlerNames: Object.keys(piUndef.handlers).sort(),
    };
  } finally {
    if (savedAgent === undefined) delete process.env.PI_SUBAGENT_CHILD_AGENT;
    else process.env.PI_SUBAGENT_CHILD_AGENT = savedAgent;
    if (savedDirect === undefined) delete process.env.MCP_DIRECT_TOOLS;
    else process.env.MCP_DIRECT_TOOLS = savedDirect;
  }
}

async function checkShimToolCall() {
  // Closest seam for the fail-closed tool_call barrier: invoke the real
  // production module directly with a fake pi, no network and no model.
  const savedAgent = process.env.PI_SUBAGENT_CHILD_AGENT;
  const savedDirect = process.env.MCP_DIRECT_TOOLS;
  try {
    const { default: engramChildMcpSelection } = await jiti.import(join(root, "extensions", "engram-child.ts"));
    const collect = async (agent) => {
      process.env.PI_SUBAGENT_CHILD_AGENT = agent;
      const handlers = {};
      const pi = { handlers, on(event, fn) { (handlers[event] ??= []).push(fn); } };
      await engramChildMcpSelection(pi);
      return handlers.tool_call ?? [];
    };
    const SIX = ["mem_search", "mem_context", "mem_get_observation", "mem_suggest_topic_key", "mem_current_project", "mem_doctor"];
    const DENIED = ["mcp", "mcpScript", "mem_save", "bash", "subagent", "mem_future_tool"];
    const invoke = (handlers, toolName) => {
      if (handlers.length === 0) return { noHandler: true };
      const result = handlers[0]({ type: "tool_call", toolName, toolCallId: "probe-gate", input: {} });
      if (result === undefined) return { pass: true };
      return { pass: false, block: result?.block, terminate: result?.terminate, reason: result?.reason };
    };
    const engramHandlers = await collect("engram");
    const otherHandlers = await collect("other-agent");
    return {
      engramHandlerCount: engramHandlers.length,
      otherHandlerCount: otherHandlers.length,
      six: Object.fromEntries(SIX.map((name) => [name, invoke(engramHandlers, name)])),
      denied: Object.fromEntries(DENIED.map((name) => [name, invoke(engramHandlers, name)])),
      empty: invoke(engramHandlers, undefined),
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
  const shimToolCall = await checkShimToolCall();
  const child = await runChildRuntime(preflight);
  writeFileSync(1, `${JSON.stringify({
    positive: POSITIVE,
    isolation: isolation(),
    fetchCount,
    preflight,
    shimRestore,
    shimToolCall,
    child,
  })}\n`);
} catch (error) {
  writeFileSync(1, `${JSON.stringify({ fatal: error instanceof Error ? { message: error.message, stack: error.stack } : String(error) })}\n`);
  process.exitCode = 1;
}
