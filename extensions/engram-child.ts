const ENGRAM_CHILD_DIRECT_TOOLS = [
  "engram/mem_search",
  "engram/mem_context",
  "engram/mem_get_observation",
  "engram/mem_suggest_topic_key",
  "engram/mem_current_project",
  "engram/mem_doctor",
].join(",");

export default async function engramChildMcpSelection(pi) {
  if (process.env.PI_SUBAGENT_CHILD_AGENT !== "engram") return;
  const previous = process.env.MCP_DIRECT_TOOLS;
  if (previous !== "__none__") return;
  process.env.MCP_DIRECT_TOOLS = ENGRAM_CHILD_DIRECT_TOOLS;
  pi.on("agent_start", () => {
    process.env.MCP_DIRECT_TOOLS = previous;
  });
}
