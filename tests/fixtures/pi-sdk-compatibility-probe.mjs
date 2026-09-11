import { appendFileSync } from "node:fs";

const markerPath = process.env.JORGEX_PI_COMPAT_MARKERS;

function record(event, details = {}) {
  if (!markerPath) return;
  appendFileSync(markerPath, `${JSON.stringify({ event, ...details })}\n`);
}

export default function install(pi) {
  pi.on("session_start", () => record("session_start"));
  pi.on("session_shutdown", () => record("session_shutdown"));

  pi.registerCommand("jx-compat-probe", {
    description: "Probe the real Pi extension API without an LLM turn.",
    handler: async () => {
      for (let attempt = 0; attempt < 100 && !pi.getAllTools().some((tool) => tool.name === "mem_context"); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      record("probe", {
        activeTools: pi.getActiveTools(),
        allTools: pi.getAllTools().map((tool) => tool.name),
        commands: pi.getCommands().map((command) => command.name),
      });
    },
  });
}
