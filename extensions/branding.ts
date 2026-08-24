import { VERSION } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";

const restoreHint = "/jorgex:header builtin";
const wideWordmark = [
  "     ██╗ ██████╗ ██████╗  ██████╗ ███████╗██╗  ██╗",
  "     ██║██╔═══██╗██╔══██╗██╔════╝ ██╔════╝╚██╗██╔╝",
  "     ██║██║   ██║██████╔╝██║  ███╗█████╗   ╚███╔╝ ",
  "██   ██║██║   ██║██╔══██╗██║   ██║██╔══╝   ██╔██╗ ",
  "╚█████╔╝╚██████╔╝██║  ██║╚██████╔╝███████╗██╔╝ ██╗",
  " ╚════╝  ╚═════╝ ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═╝",
];

export default function installBranding(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    applyCustomHeader(ctx);
  });

  pi.registerCommand("jorgex:header", {
    description: "Use `builtin` or `custom` to choose the startup header for this session.",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") return;

      if (args.trim() === "builtin") {
        ctx.ui.setHeader(undefined);
        return;
      }

      if (args.trim() === "custom") applyCustomHeader(ctx);
    },
  });
}

function applyCustomHeader(ctx: ExtensionContext | ExtensionCommandContext) {
  if (ctx.mode === "tui") ctx.ui.setHeader(createJorgeXHeader);
}

function createJorgeXHeader(_tui: unknown, theme: Theme) {
  return {
    render(width: number) {
      const logo = theme.fg("accent", "JorgeX");
      if (width < 28) return [logo];
      if (width < 72) return [
        `${logo}${theme.fg("muted", ` · Pi v${VERSION}`)}`,
        theme.fg("muted", restoreHint),
      ];
      return [
        ...wideWordmark.map((line) => theme.fg("accent", line)),
        `${logo}${theme.fg("muted", ` · Pi v${VERSION} · ${restoreHint}`)}`,
      ];
    },
    invalidate() {},
  };
}
