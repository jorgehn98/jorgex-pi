import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AssistantMessageComponent, ToolExecutionComponent, UserMessageComponent, VERSION, getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, MouseRegion, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { findChatContainer, mountCompactTools } from "./compact-tools.mjs";

const WIDGET = "jorgex.compact-tools";

export default function compactTools(pi: ExtensionAPI) {
  let dispose = () => {};

  function mount(ctx: ExtensionContext) {
    dispose();
    if (ctx.mode !== "tui") return;
    ctx.ui.setWidget(WIDGET, undefined);
    try {
      const config = JSON.parse(readFileSync(join(getAgentDir(), "extensions", "jorgex-compact-tools", "config.json"), "utf8"));
      if (typeof config.enabled !== "boolean") throw new Error("enabled must be true or false");
      if (!config.enabled) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        ctx.ui.notify("Invalid compact-tools config; use enabled: true or false. Keeping native rendering.", "warning");
        return;
      }
    }
    if (VERSION !== "1.0.0") {
      ctx.ui.notify("Compact tools currently supports Pi 1.0.0; keeping native rendering.", "warning");
      return;
    }
    ctx.ui.setWidget(WIDGET, (tui, theme) => {
      let mounted = false;
      const host = {
        Container, MouseRegion, Spacer, Text, truncateToWidth,
        AssistantMessageComponent, ToolExecutionComponent, UserMessageComponent,
        theme,
        requestRender: () => tui.requestRender(),
        getExpanded: () => ctx.ui.getToolsExpanded(),
      };
      return {
        render() {
          if (!mounted) {
            const chat = findChatContainer(tui, host);
            if (chat) {
              dispose = mountCompactTools(chat, host);
              mounted = true;
              tui.requestRender();
            }
          }
          return [];
        },
        invalidate() {},
        dispose() { dispose(); },
      };
    });
  }

  pi.on("session_start", (_event, ctx) => mount(ctx));
  pi.on("session_shutdown", () => dispose());
}
