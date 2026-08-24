const toolNames = [
  "mem_save", "mem_search", "mem_context", "mem_session_summary", "mem_session_start", "mem_session_end",
  "mem_get_observation", "mem_suggest_topic_key", "mem_capture_passive", "mem_save_prompt", "mem_update",
  "mem_current_project", "mem_judge", "mem_compare", "mem_doctor", "mem_review", "mem_pin", "mem_unpin",
];
let buffer = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (buffer.includes("\n")) {
    const index = buffer.indexOf("\n");
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) respond(JSON.parse(line));
  }
});

function respond(message) {
  if (message.id === undefined) return;
  let result;
  if (message.method === "initialize") {
    result = {
      protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "fake-engram", version: "1.20.0" },
    };
  } else if (message.method === "tools/list") {
    result = { tools: toolNames.map((name) => ({ name, description: name, inputSchema: { type: "object", properties: {} } })) };
  } else if (message.method === "resources/list") result = { resources: [] };
  else if (message.method === "prompts/list") result = { prompts: [] };
  else result = {};
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
}
