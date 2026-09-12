import { createServer } from "node:http";

const CONTEXT7_TOOL = {
  name: "fixture_context7",
  description: "A deterministic local Context7 transport fixture.",
  inputSchema: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  },
};

export async function startFakeContext7Mcp() {
  const requests = [];
  const server = createServer(async (request, response) => {
    if (request.method === "DELETE") {
      response.writeHead(200);
      response.end();
      return;
    }

    const body = await readRequestBody(request);
    const messages = body.length === 0 ? [] : JSON.parse(body);
    const batch = Array.isArray(messages) ? messages : [messages];
    requests.push({
      method: request.method,
      headers: Object.fromEntries(Object.entries(request.headers)),
      messages: batch,
    });

    const message = batch.find((entry) => entry && entry.id !== undefined);
    if (!message) {
      response.writeHead(202);
      response.end();
      return;
    }

    let result;
    if (message.method === "initialize") {
      result = {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "context7-fixture", version: "1.0.0" },
      };
    } else if (message.method === "tools/list") {
      result = { tools: [CONTEXT7_TOOL] };
    } else if (message.method === "tools/call") {
      result = {
        content: [{ type: "text", text: `fixture:${message.params?.arguments?.value ?? "missing"}` }],
        isError: false,
      };
    } else {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: `Unsupported fixture method: ${message.method}` },
      }));
      return;
    }

    response.writeHead(200, {
      "content-type": "application/json",
      "mcp-session-id": "context7-fixture-session",
    });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("Context7 fixture did not expose a TCP address");
  }

  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    requests,
    async close() {
      await closeServer(server);
    },
  };
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
