import { Type } from "typebox";

const emptyParameters = Type.Object({});
const bashParameters = Type.Object({ command: Type.String() });
const readParameters = Type.Object({ path: Type.String() });
const mcpParameters = Type.Object({
  server: Type.Optional(Type.String()),
  tool: Type.Optional(Type.String()),
});

export default function permissionsTools(pi) {
  pi.registerTool({
    name: "bash",
    label: "Bash fixture",
    description: "Native bash permission fixture.",
    parameters: bashParameters,
    async execute() {
      return { content: [{ type: "text", text: "fixture" }] };
    },
  });
  pi.registerTool({
    name: "read",
    label: "Read fixture",
    description: "Native read permission fixture.",
    parameters: readParameters,
    async execute() {
      return { content: [{ type: "text", text: "fixture" }] };
    },
  });
  pi.registerTool({
    name: "edit",
    label: "Edit fixture",
    description: "Native edit permission fixture.",
    parameters: readParameters,
    async execute() {
      return { content: [{ type: "text", text: "fixture" }] };
    },
  });
  pi.registerTool({
    name: "mcp",
    label: "MCP fixture",
    description: "MCP permission fixture.",
    parameters: mcpParameters,
    async execute() {
      return { content: [{ type: "text", text: "fixture" }] };
    },
  });
  for (const name of ["known_tool", "unclassified_tool"]) {
    pi.registerTool({
      name,
      label: `${name} fixture`,
      description: "Permission policy fixture.",
      parameters: emptyParameters,
      async execute() {
        return { content: [{ type: "text", text: "fixture" }] };
      },
    });
  }
}
