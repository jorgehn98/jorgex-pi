const ENGRAM_CHILD_TOOL_SELECTORS = [
  "engram/mem_search",
  "engram/mem_context",
  "engram/mem_get_observation",
  "engram/mem_suggest_topic_key",
  "engram/mem_current_project",
  "engram/mem_doctor",
];
const ENGRAM_CHILD_DIRECT_TOOLS = ENGRAM_CHILD_TOOL_SELECTORS.join(",");
const ENGRAM_CHILD_ALLOWED_TOOLS = new Set(
  ENGRAM_CHILD_TOOL_SELECTORS.map((selector) => selector.slice(selector.indexOf("/") + 1)),
);

export default async function engramChildMcpSelection(pi) {
  if (process.env.PI_SUBAGENT_CHILD_AGENT !== "engram") return;
  const previous = process.env.MCP_DIRECT_TOOLS;
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    if (previous === undefined) delete process.env.MCP_DIRECT_TOOLS;
    else process.env.MCP_DIRECT_TOOLS = previous;
  };
  process.env.MCP_DIRECT_TOOLS = ENGRAM_CHILD_DIRECT_TOOLS;
  pi.on("agent_start", restore);
  pi.on("session_shutdown", restore);
  pi.on("tool_call", (event) => {
    const toolName = typeof event?.toolName === "string" ? event.toolName : "";
    return ENGRAM_CHILD_ALLOWED_TOOLS.has(toolName)
      ? undefined
      : {
          block: true,
          terminate: true,
          reason: `Engram child allows only read-only memory tools (${[...ENGRAM_CHILD_ALLOWED_TOOLS].join(", ")}); blocked tool call: ${toolName || "unknown"}.`,
        };
  });
}
