// Engram child boundary: gentle-engram provides the six native read-only
// memory tools. The shim leaves the process environment untouched; it only
// gates tool_call so writes, shell access and subdelegation block before
// execution.
const ENGRAM_CHILD_ALLOWED_TOOLS = new Set([
  "mem_search",
  "mem_context",
  "mem_get_observation",
  "mem_suggest_topic_key",
  "mem_current_project",
  "mem_doctor",
]);

export default async function engramChildMcpSelection(pi) {
  if (process.env.PI_SUBAGENT_CHILD_AGENT !== "engram") return;
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
