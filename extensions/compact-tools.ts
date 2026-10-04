import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AssistantMessageComponent, ToolExecutionComponent, UserMessageComponent, getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, MouseRegion, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";

const MOUNTED = Symbol.for("jorgex-pi.compact-tools");

// Pi 1.0 has no renderer-only transcript API. Keep the private-field adapter
// here; unknown layouts retain native rendering, and disposal restores it.
export function findChatContainer(tui, host) {
  const seen = new Set();
  function visit(node, depth) {
    if (!node || depth > 6 || seen.has(node)) return undefined;
    seen.add(node);
    if (!Array.isArray(node.children)) return undefined;
    if (node.children.some(child => child instanceof host.ToolExecutionComponent || child instanceof host.AssistantMessageComponent || child instanceof host.UserMessageComponent)) return node;
    for (const child of node.children) {
      const found = visit(child, depth + 1);
      if (found) return found;
    }
  }
  return visit(tui, 0);
}

export function mountCompactTools(chat, host) {
  if (chat[MOUNTED]) return () => {};
  const { Container, Text, Spacer, MouseRegion, ToolExecutionComponent, AssistantMessageComponent, theme, requestRender } = host;
  const originalRender = chat.render;
  const originalMouse = chat.handleMouse;
  const projection = new Container();
  const groups = new WeakMap();
  let disposed = false;

  function activity(child) {
    if (child instanceof ToolExecutionComponent) return true;
    if (!(child instanceof AssistantMessageComponent)) return false;
    const content = child.lastMessage?.content;
    return Array.isArray(content) && content.length > 0 && !content.some(block => block.type === "text" && block.text?.trim());
  }

  function summary(members) {
    const counts = { edit: 0, thought: 0, read: 0, tool: 0 };
    let failed = 0;
    let running = 0;
    for (const member of members) {
      if (member instanceof AssistantMessageComponent) {
        if (member.lastMessage.content.some(block => block.type === "thinking")) counts.thought++;
      } else {
        const name = member.toolName;
        const kind = name === "edit" || name === "write" ? "edit" : name === "read" ? "read" : "tool";
        counts[kind]++;
        if (member.result?.isError) failed++;
        if (member.isPartial) running++;
      }
    }
    const text = Object.entries(counts).filter(([, count]) => count).map(([kind, count]) => `${count} ${kind}${count === 1 ? "" : "s"}`).join(", ");
    return { text: `${text}${running ? ` · ${running} running` : ""}${failed ? ` · ${failed} failed` : ""}`, failed };
  }

  class ActivityGroup extends Container {
    members = [];
    expanded = false;
    render(width) {
      const info = summary(this.members);
      const label = `${this.expanded ? "▾" : "▸"} ${info.text}`;
      // Headers contain counts only, never tool arguments or secret-bearing output.
      const header = new Text(theme.fg(info.failed ? "error" : "muted", host.truncateToWidth(label, Math.max(1, width - 2))), 1, 0);
      const clickable = new MouseRegion(header, event => {
        if (event.type !== "click" || event.button !== "left") return undefined;
        this.expanded = !this.expanded;
        requestRender();
        return { handled: true };
      });
      this.children = [new Spacer(1), clickable];
      if (this.expanded) this.children.push(...this.members);
      return super.render(width);
    }
  }

  function render(width) {
    if (disposed) return originalRender.call(chat, width);
    const children = [];
    let members = [];
    function flush() {
      if (!members.length) return;
      let group = groups.get(members[0]);
      if (!group) {
        group = new ActivityGroup();
        groups.set(members[0], group);
      }
      group.members = members;
      children.push(group);
      members = [];
    }
    for (const child of chat.children) {
      if (activity(child)) members.push(child);
      else {
        flush();
        children.push(child);
      }
    }
    flush();
    projection.children = children;
    return projection.render(width);
  }

  function handleMouse(event) {
    return projection.handleMouse(event);
  }
  chat.render = render;
  chat.handleMouse = handleMouse;
  chat[MOUNTED] = true;

  // Reversible, identity-checked cleanup follows pi-tool-display's disposal
  // pattern; don't undo a renderer another extension installed after this one.
  return () => {
    if (disposed) return;
    disposed = true;
    if (chat.render === render) chat.render = originalRender;
    if (chat.handleMouse === handleMouse) chat.handleMouse = originalMouse;
    delete chat[MOUNTED];
    projection.clear();
    requestRender();
  };
}

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
    ctx.ui.setWidget(WIDGET, (tui, theme) => {
      let mounted = false;
      const host = {
        Container, MouseRegion, Spacer, Text, truncateToWidth,
        AssistantMessageComponent, ToolExecutionComponent, UserMessageComponent,
        theme,
        requestRender: () => tui.requestRender(),
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
