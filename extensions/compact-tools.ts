import { AssistantMessageComponent, ToolExecutionComponent, UserMessageComponent, VERSION, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, MouseRegion, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { findChatContainer, mountCompactTools } from "./compact-tools.mjs";

const WIDGET = "jorgex.compact-tools";

export default function compactTools(pi: ExtensionAPI) {
  let enabled = true;
  let dispose = () => {};

  function mount(ctx: ExtensionContext) {
    dispose();
    ctx.ui.setWidget(WIDGET, undefined);
    if (!enabled || ctx.mode !== "tui") return;
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
  pi.registerCommand("tool-display", {
    description: "Toggle grouped tool activity (click a row or Ctrl+O to expand)",
    handler: async (_args, ctx) => {
      enabled = !enabled;
      mount(ctx);
      ctx.ui.notify(`Tool display: ${enabled ? "grouped" : "native"}`, "info");
    },
  });
}
