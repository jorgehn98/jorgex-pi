// Probe-only stand-in for the provider-managed adapter transport.
//
// In production the official setup owns the Engram channel: the external
// pi-mcp-adapter serves the official mcp.json server and gentle-engram
// provides native tools, while JorgeX Pi only inspects and registers over the
// event bus. The sandbox cannot install provider packages, so the probe drives
// an external test-only adapter copy directly with an explicit
// official-shaped config against the fake backend. Production bootstrap must
// never install or bundle an adapter; this file exists only for the child runtime probe.
import { accessSync, constants, statSync } from "node:fs";

function isRunnableFile(path: string): boolean {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return false;
    if (process.platform !== "win32") accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export default async function probeOfficialAdapterInstaller(pi: any): Promise<void> {
  const binary = process.env.ENGRAM_BIN;
  // Fail closed like the official bridge: a missing backend installs nothing.
  if (typeof binary !== "string" || !binary || !isRunnableFile(binary)) return;
  // This test-only stand-in uses the retired adapter API to model the native
  // six-read provider surface; production does not set this environment value.
  // Publish the selectors only while creating the stand-in, then restore the
  // environment before the probe continues.
  const selectors = [
    "mem_search",
    "mem_context",
    "mem_get_observation",
    "mem_suggest_topic_key",
    "mem_current_project",
    "mem_doctor",
  ].map((name) => `engram/${name}`).join(",");
  const previous = process.env.MCP_DIRECT_TOOLS;
  process.env.MCP_DIRECT_TOOLS = selectors;
  try {
    const adapterEntry = import.meta.resolve("pi-mcp-adapter");
    const { createMcpAdapter } = await import(adapterEntry);
    createMcpAdapter({
      config: {
        // Child posture for the stand-in only: disable its proxy and script
        // tools so the probe checks the same gateway boundary as production.
        // The official Pi bridge carries no adapter settings.
        settings: { disableProxyTool: true, scriptMode: false },
        mcpServers: {
          engram: {
            command: binary,
            args: ["mcp", "--tools=agent"],
            lifecycle: "lazy",
            directTools: true,
            toolPrefix: "none",
            excludeTools: ["mem_capture_passive"],
          },
        },
      },
    })(pi);
  } finally {
    if (previous === undefined) delete process.env.MCP_DIRECT_TOOLS;
    else process.env.MCP_DIRECT_TOOLS = previous;
  }
}
