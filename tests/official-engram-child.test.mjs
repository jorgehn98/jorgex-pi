import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const testDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(testDir, "..");
const jiti = createJiti(import.meta.url, { moduleCache: false });

const SIX_READS = [
  "mem_search",
  "mem_context",
  "mem_get_observation",
  "mem_suggest_topic_key",
  "mem_current_project",
  "mem_doctor",
];
const BLOCKED = ["mem_save", "mem_session_summary", "mem_update", "bash", "subagent", "mcp", "mcpScript"];

test("child extension never sets MCP_DIRECT_TOOLS (source and runtime)", async () => {
  const source = readFileSync(join(root, "extensions", "engram-child.ts"), "utf8");
  assert.doesNotMatch(source, /MCP_DIRECT_TOOLS/, "official child must not touch MCP_DIRECT_TOOLS; gentle-engram provides native tools");

  const savedAgent = process.env.PI_SUBAGENT_CHILD_AGENT;
  const hadDirect = Object.hasOwn(process.env, "MCP_DIRECT_TOOLS");
  const savedDirect = process.env.MCP_DIRECT_TOOLS;
  try {
    delete process.env.MCP_DIRECT_TOOLS;
    process.env.PI_SUBAGENT_CHILD_AGENT = "engram";
    const { default: engramChildMcpSelection } = await jiti.import(join(root, "extensions", "engram-child.ts"));
    const handlers = {};
    const pi = { handlers, on: (event, fn) => { (handlers[event] ??= []).push(fn); } };
    await engramChildMcpSelection(pi);
    assert.equal(Object.hasOwn(process.env, "MCP_DIRECT_TOOLS"), false, "child load must leave MCP_DIRECT_TOOLS unset");
    for (const event of ["agent_start", "session_shutdown"]) {
      for (const fn of handlers[event] ?? []) fn();
      assert.equal(Object.hasOwn(process.env, "MCP_DIRECT_TOOLS"), false, `${event} must not create MCP_DIRECT_TOOLS`);
    }
  } finally {
    if (savedAgent === undefined) delete process.env.PI_SUBAGENT_CHILD_AGENT;
    else process.env.PI_SUBAGENT_CHILD_AGENT = savedAgent;
    if (!hadDirect) delete process.env.MCP_DIRECT_TOOLS;
    else process.env.MCP_DIRECT_TOOLS = savedDirect;
  }
});

test("official gentle child exposes exactly six reads and blocks writes/shell/subagent", async () => {
  const savedAgent = process.env.PI_SUBAGENT_CHILD_AGENT;
  const hadDirect = Object.hasOwn(process.env, "MCP_DIRECT_TOOLS");
  const savedDirect = process.env.MCP_DIRECT_TOOLS;
  try {
    delete process.env.MCP_DIRECT_TOOLS;
    process.env.PI_SUBAGENT_CHILD_AGENT = "engram";
    const { default: engramChildMcpSelection } = await jiti.import(join(root, "extensions", "engram-child.ts"));
    const handlers = {};
    const pi = { handlers, on: (event, fn) => { (handlers[event] ??= []).push(fn); } };
    await engramChildMcpSelection(pi);

    // The gate is the read-only boundary closest to the risk: six native
    // gentle reads pass, everything else blocks before backend execution.
    const toolCall = handlers.tool_call ?? [];
    assert.equal(toolCall.length, 1, "engram child must register exactly one tool_call gate");
    const invoke = (toolName) => toolCall[0]({ type: "tool_call", toolName, toolCallId: "probe", input: {} });
    for (const name of SIX_READS) {
      assert.equal(invoke(name), undefined, `${name} must pass through the official read-only gate`);
    }
    for (const name of BLOCKED) {
      const result = invoke(name);
      assert.equal(result?.block, true, `${name} must block`);
      assert.equal(result?.terminate, true, `${name} must terminate the batch`);
      assert.match(result?.reason ?? "", /Engram child allows only/, `${name} must carry the specific gate reason`);
    }
    assert.equal(Object.hasOwn(process.env, "MCP_DIRECT_TOOLS"), false, "gentle reads must not require MCP_DIRECT_TOOLS");
  } finally {
    if (savedAgent === undefined) delete process.env.PI_SUBAGENT_CHILD_AGENT;
    else process.env.PI_SUBAGENT_CHILD_AGENT = savedAgent;
    if (!hadDirect) delete process.env.MCP_DIRECT_TOOLS;
    else process.env.MCP_DIRECT_TOOLS = savedDirect;
  }
});

test("agent contract keeps exactly six read-only tools for the engram child (control)", async () => {
  const agentSource = readFileSync(join(root, "agents", "engram.md"), "utf8");
  const toolsLine = agentSource.split("\n").find((line) => line.startsWith("tools:"));
  assert.ok(toolsLine, "engram agent must declare its tools line");
  assert.deepEqual(
    toolsLine.replace(/^tools:\s*/, "").split(",").map((name) => name.trim()).sort(),
    [...SIX_READS].sort(),
    "engram agent must keep exactly the six official reads",
  );
  for (const blocked of ["mem_save", "mem_session_summary", "bash", "subagent"]) {
    assert.equal(
      toolsLine.split(",").map((name) => name.trim()).includes(blocked),
      false,
      `engram tools line must not advertise ${blocked}`,
    );
  }
});
