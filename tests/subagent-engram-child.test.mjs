import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(testDir, "..");
const probePath = join(testDir, "fixtures", "probe-engram-child.mjs");

const POSITIVE = [
  "mem_search",
  "mem_context",
  "mem_get_observation",
  "mem_suggest_topic_key",
  "mem_current_project",
  "mem_doctor",
];
const NEGATIVES = ["mem_save", "mem_session_summary", "bash", "subagent"];
const PARTIAL_OMITTED = "mem_doctor";
const PARTIAL_AVAILABLE = POSITIVE.filter((name) => name !== PARTIAL_OMITTED);
const HOSTILE_EXTRA = ["mem_save", "mem_session_summary", "bash", "subagent"];

test("engram child preflight exposes exactly six read-only tools without provider/model", () => {
  const sandbox = setupSandbox({ backend: "valid" });
  try {
    const probed = runProbe(sandbox);
    assert.equal(probed.preflight.ok, true, `engram preflight must resolve: ${probed.preflight.message ?? "no message"}`);
    assert.equal(probed.preflight.model, undefined, "isolated child must not select a model without a provider");
    assert.deepEqual(probed.preflight.modelCandidates, [], "isolated child must not resolve model fallbacks without a provider");
    assert.deepEqual(probed.preflight.effectiveAllowlist, POSITIVE, "engram child allowlist must be exactly the six read-only tools");
    assert.deepEqual(probed.preflight.requiredChildTools, POSITIVE, "explicit allowlist must require the six tools before the first turn");
    assert.deepEqual(probed.preflight.effectiveMcpTools, [], "today the allowlist carries no MCP direct wiring");
    for (const denied of NEGATIVES) {
      assert.equal(probed.preflight.effectiveAllowlist.includes(denied), false, `read-only child must not allow ${denied}`);
    }
    assert.equal(probed.isolation.piPackageDirConfigured, false, "PI_PACKAGE_DIR must remain the Pi binary read-only root");
    assert.ok(probed.isolation.home.startsWith(sandbox.root), "probe must run under isolated HOME");
    assert.ok(probed.isolation.agentDir.startsWith(sandbox.root), "probe must run under isolated PI_CODING_AGENT_DIR");
    assert.equal(probed.isolation.path, sandbox.emptyBin, "probe must run with an isolated empty PATH");
    for (const [label, value] of [
      ["XDG_CACHE_HOME", probed.isolation.xdgCache],
      ["XDG_CONFIG_HOME", probed.isolation.xdgConfig],
      ["XDG_DATA_HOME", probed.isolation.xdgData],
      ["TEMP", probed.isolation.temp],
      ["TMP", probed.isolation.tmp],
      ["TMPDIR", probed.isolation.tmpdir],
      ["PI_SUBAGENTS_TEMP_ROOT", probed.isolation.subagentsTemp],
    ]) {
      assert.ok(value.startsWith(sandbox.root), `${label} must stay under the isolated sandbox`);
    }
    assert.equal(probed.isolation.engramBin, sandbox.fakeBin, "ENGRAM_BIN must resolve to the isolated fake binary");
    assert.equal(probed.fetchCount, 0, "probe must not use the network");
  } finally {
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});

test("engram child runtime registers and executes its six read-only tools before the first LLM turn", () => {
  const sandbox = setupSandbox({ backend: "valid" });
  try {
    const probed = runProbe(sandbox);
    assert.equal(probed.preflight.ok, true, "preflight must resolve before the child runtime starts");
    assert.deepEqual(probed.child.loaderErrors, [], "child runtime must load its contract extensions without diagnostics");
    assert.equal(probed.child.mcpDirectToolsEnv, "__none__", "child env must carry the contract MCP selection into the runtime");
    const expectedSelectors = probed.preflight.effectiveAllowlist.map((name) => `engram/${name}`).join(",");
    assert.equal(probed.child.envAfterLoad, expectedSelectors, "shim selectors must match exactly the contract tools");
    // Proxy gateway off (config shape covered by the mcp-engram unit test
    // "engram child config hides proxy and script tools"): here only live
    // runtime state after session_start, before the turn. subagent_wait is
    // independent infra and stays out of this claim.
    assert.equal(probed.child.proxy.deactivatedInTime, true, "transient proxy must deactivate within the bound");
    assert.equal(probed.child.proxy.mcpScriptRegistered, false, "mcpScript must never register in the child");
    assert.equal(probed.child.proxy.mcpScriptActive, false, "mcpScript must not be active in the child");
    assert.equal(probed.child.proxy.mcpActive, false, "mcp gateway must not stay active once the six directs are available");
    assert.equal(probed.child.gatewayAttempt.active, false, "gateway attempt must find no active mcp definition");
    assert.equal(probed.child.gatewayAttempt.invokable, false, "gateway must not be invokable in the child");
    for (const denied of NEGATIVES) {
      assert.equal(probed.child.allTools.includes(denied), false, `child runtime must not register ${denied}`);
    }
    assert.deepEqual([...probed.child.memTools].sort(), [...POSITIVE].sort(), "child runtime must register all six tools before the first LLM turn");
    assert.equal(probed.child.diagnostic.timedOut, undefined, "pre-turn diagnostic file must really appear");
    for (const name of POSITIVE) {
      assert.ok((probed.child.diagnostic.available ?? []).includes(name), `diagnostic available must include ${name}`);
    }
    assert.deepEqual(probed.child.diagnostic.missing ?? [], [], "child diagnostic must report no missing tools before the first turn");
    assert.equal(probed.child.executed.ok, true, `child must execute mem_doctor through its registered definition: ${probed.child.executed.error ?? ""}`);
    assert.equal(probed.child.executed.payload?.tool, "mem_doctor", "deterministic read must answer for mem_doctor");
    assert.equal(probed.child.executed.payload?.backend, "probe-isolated", "deterministic read must come from the isolated fake");
    assert.equal(probed.fetchCount, 0, "child tool execution must stay local without network");
  } finally {
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});

test("hostile backend cannot smuggle mutants into the child registry", () => {
  // Registry (allTools, infra included) is distinguished from the effective
  // set: the mcp proxy may remain by architecture, but only the six selected
  // direct tools may register or execute.
  const sandbox = setupSandbox({ backend: "hostile" });
  try {
    const probed = runProbe(sandbox);
    assert.equal(probed.preflight.ok, true, "preflight must resolve before the child runtime starts");
    assert.deepEqual(probed.child.loaderErrors, [], "child runtime must load its contract extensions without diagnostics");
    // Gateway off under attack too; config shape stays covered by the
    // mcp-engram unit test, not duplicated here.
    assert.equal(probed.child.proxy.deactivatedInTime, true, "transient proxy must deactivate within the bound");
    assert.equal(probed.child.proxy.mcpScriptRegistered, false, "mcpScript must never register in the child");
    assert.equal(probed.child.proxy.mcpScriptActive, false, "mcpScript must not be active in the child");
    assert.equal(probed.child.proxy.mcpActive, false, "mcp gateway must not stay active once the six directs are available");
    assert.equal(probed.child.gatewayAttempt.active, false, "gateway attempt must find no active mcp definition");
    assert.equal(probed.child.gatewayAttempt.invokable, false, "gateway must not be invokable in the child");
    assert.deepEqual([...probed.child.memTools].sort(), [...POSITIVE].sort(), "only the six selected tools may register despite hostile extras");
    for (const denied of HOSTILE_EXTRA) {
      assert.equal(probed.child.allTools.includes(denied), false, `hostile ${denied} must not register as a direct tool`);
    }
    assert.equal(probed.child.diagnostic.timedOut, undefined, "pre-turn diagnostic file must really appear");
    assert.deepEqual(probed.child.diagnostic.missing ?? [], [], "diagnostic must report no missing tools with a hostile backend");
    assert.equal(probed.child.executed.ok, true, "mem_doctor must still execute through its registered definition");
    assert.equal(probed.child.executed.payload?.tool, "mem_doctor", "deterministic read must answer for mem_doctor");
    assert.equal(probed.child.executedMutant?.ok, false, "advertised mem_save must not be invocable through the child registry");
    assert.match(probed.child.executedMutant?.error ?? "", /not registered/i, "mutant must fail as unregistered");
    assert.equal(probed.fetchCount, 0, "hostile toolset must stay local without network");
  } finally {
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});

test("valid partial backend registers available tools and diagnostic identifies exactly the missing required tool", () => {
  const sandbox = setupSandbox({ backend: "partial" });
  try {
    const probed = runProbe(sandbox);
    assert.equal(probed.preflight.ok, true, "preflight must resolve before the child runtime starts");
    assert.equal(probed.preflight.model, undefined, "partial-backend child still selects no model without a provider");
    assert.deepEqual(probed.child.loaderErrors, [], "child runtime must load its contract extensions without diagnostics");
    assert.deepEqual([...probed.child.memTools].sort(), [...PARTIAL_AVAILABLE].sort(), "partial backend must register exactly the five advertised tools");
    assert.equal(probed.child.diagnostic.timedOut, undefined, "pre-turn diagnostic file must really appear");
    assert.deepEqual(probed.child.diagnostic.missing ?? [], [PARTIAL_OMITTED], "diagnostic must identify exactly the omitted required tool");
    assert.equal(probed.child.executed.ok, false, "omitted mem_doctor must not be invocable through the child registry");
    assert.match(probed.child.executed.error ?? "", /not registered/i, "partial toolset must fail as unregistered, without permissive fallback");
    for (const denied of NEGATIVES) {
      assert.equal(probed.child.allTools.includes(denied), false, `child runtime must not register ${denied}`);
    }
    assert.equal(probed.fetchCount, 0, "partial toolset must stay local without network");
  } finally {
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});

test("shim restore paths leave no leaked MCP selection behind", () => {
  const sandbox = setupSandbox({ backend: "valid" });
  try {
    const probed = runProbe(sandbox);
    const expectedSix = probed.preflight.effectiveAllowlist.map((name) => `engram/${name}`).join(",");
    assert.equal(probed.shimRestore.undefDuringLoad, expectedSix, "shim must apply the six selectors when previous is undefined");
    assert.equal(probed.shimRestore.undefAfterAgentStart, null, "undefined previous must be deleted on agent_start");
    assert.equal(probed.shimRestore.undefAfterSecondAgentStart, null, "double agent_start must stay deleted");
    assert.equal(probed.shimRestore.undefAfterShutdown, null, "shutdown after restore must stay deleted");
    assert.equal(probed.shimRestore.foreignDuringLoad, expectedSix, "foreign previous must be replaced by six during load");
    assert.equal(probed.shimRestore.foreignAfterAgentStart, "foreign,keep-me", "foreign previous must be restored exactly");
    assert.equal(probed.shimRestore.foreignAfterSecond, "foreign,keep-me", "double agent_start must keep the exact foreign value");
    assert.equal(probed.shimRestore.shutdownUndefAfter, null, "shutdown without agent_start must delete undefined previous");
    assert.equal(probed.shimRestore.shutdownForeignAfter, "foreign,keep-me", "shutdown without agent_start must restore foreign previous");
    assert.equal(probed.shimRestore.nonEngramAfter, "untouched", "other agents must leave the env untouched");
    assert.deepEqual(probed.shimRestore.nonEngramHandlers, { agent_start: 0, session_shutdown: 0 }, "other agents must register no restore handlers");
  } finally {
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});

test("invalid Engram backend fails closed without network or real HOME", () => {
  const sandbox = setupSandbox({ backend: "missing" });
  try {
    const probed = runProbe(sandbox);
    assert.deepEqual(probed.child.loaderErrors, [], "even the invalid-backend child must load its contract extensions");
    assert.equal(probed.child.memTools.length, 0, "missing backend must leave zero mem_* tools registered in the child runtime");
    assert.equal(probed.child.diagnostic.timedOut, undefined, "pre-turn diagnostic file must really appear");
    assert.deepEqual([...(probed.child.diagnostic.missing ?? [])].sort(), [...POSITIVE].sort(), "missing backend must leave all six tools unregistered in the runtime diagnostic");
    assert.equal(probed.child.executed.ok, false, "missing backend must leave mem_doctor non-invocable through the child registry");
    assert.match(probed.child.executed.error ?? "", /not registered/i, "invalid backend must fail as unregistered, not as a backend handshake");
    assert.ok(probed.isolation.home.startsWith(sandbox.root), "invalid backend probe must stay under isolated HOME");
    assert.equal(probed.fetchCount, 0, "invalid backend must fail without network");
  } finally {
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});

function setupSandbox({ backend }) {
  const sandboxRoot = mkdtempSync(join(tmpdir(), "jorgex-pi-engram-child-"));
  const agentDir = join(sandboxRoot, "agent");
  const installedPackage = join(agentDir, "npm", "node_modules", "jorgex-pi");
  const emptyBin = join(sandboxRoot, "empty-bin");
  const tempRoot = join(sandboxRoot, "pi-subagents-temp");
  mkdirSync(installedPackage, { recursive: true });
  mkdirSync(emptyBin, { recursive: true });
  mkdirSync(tempRoot, { recursive: true });
  cpSync(join(root, "package.json"), join(installedPackage, "package.json"));
  cpSync(join(root, "agents"), join(installedPackage, "agents"), { recursive: true });
  cpSync(join(root, "extensions"), join(installedPackage, "extensions"), { recursive: true });
  cpSync(join(root, "skills"), join(installedPackage, "skills"), { recursive: true });

  const fakeBin = join(sandboxRoot, "fake-engram");
  if (backend === "valid") writeFakeEngram(fakeBin);
  else if (backend === "partial") writeFakeEngram(fakeBin, { omit: [PARTIAL_OMITTED] });
  else if (backend === "hostile") writeFakeEngram(fakeBin, { extra: HOSTILE_EXTRA });

  const env = {
    ...allowedHostEnv(),
    HOME: join(sandboxRoot, "home"),
    USERPROFILE: join(sandboxRoot, "home"),
    PATH: emptyBin,
    PI_CODING_AGENT_DIR: agentDir,
    PI_SUBAGENTS_TEMP_ROOT: tempRoot,
    XDG_CACHE_HOME: join(sandboxRoot, "xdg-cache"),
    XDG_CONFIG_HOME: join(sandboxRoot, "xdg-config"),
    XDG_DATA_HOME: join(sandboxRoot, "xdg-data"),
    TEMP: join(sandboxRoot, "temp"),
    TMP: join(sandboxRoot, "temp"),
    TMPDIR: join(sandboxRoot, "temp"),
  };
  for (const path of [env.HOME, env.XDG_CACHE_HOME, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.TEMP]) {
    mkdirSync(path, { recursive: true });
  }
  if (backend === "missing") env.ENGRAM_BIN = join(sandboxRoot, "missing-engram");
  else env.ENGRAM_BIN = fakeBin;

  return { root: sandboxRoot, agentDir, emptyBin, fakeBin, env };
}

function runProbe(sandbox) {
  const output = execFileSync(process.execPath, [probePath], {
    cwd: sandbox.root,
    env: sandbox.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const probed = JSON.parse(output);
  if (probed.fatal) throw new Error(`probe failed: ${probed.fatal.message}`);
  return probed;
}

function writeFakeEngram(binary, { omit = [], extra = [] } = {}) {
  const advertised = [...POSITIVE.filter((name) => !omit.includes(name)), ...extra];
  const server = `const toolNames = ${JSON.stringify(advertised)};
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (buffer.includes("\\n")) {
    const index = buffer.indexOf("\\n");
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) respond(JSON.parse(line));
  }
});
function respond(message) {
  if (message.id === undefined) return;
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "probe-engram", version: "1.0.0" } } }) + "\\n");
    return;
  }
  if (message.method === "tools/list") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: toolNames.map((name) => ({ name, description: name, inputSchema: { type: "object", properties: {} } })) } }) + "\\n");
    return;
  }
  if (message.method === "tools/call") {
    const name = message.params?.name;
    if (toolNames.includes(name)) {
      const payload = name === "mem_doctor"
        ? { tool: name, status: "ok", backend: "probe-isolated" }
        : name === "mem_current_project"
          ? { tool: name, project: "probe-isolated" }
          : { tool: name, backend: "probe-isolated" };
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: JSON.stringify(payload) }], isError: false } }) + "\\n");
      return;
    }
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "tool not available: " + String(name) } }) + "\\n");
    return;
  }
  if (message.method === "resources/list") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { resources: [] } }) + "\\n");
    return;
  }
  if (message.method === "prompts/list") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { prompts: [] } }) + "\\n");
    return;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }) + "\\n");
}
`;
  writeFileSync(binary, `#!${process.execPath}\n${server}`);
  chmodSync(binary, 0o755);
}

function allowedHostEnv() {
  const allowed = {};
  for (const key of ["PATHEXT", "SYSTEMROOT", "SystemRoot", "COMSPEC", "ComSpec", "WINDIR", "windir"]) {
    if (process.env[key] !== undefined) allowed[key] = process.env[key];
  }
  return allowed;
}
