import assert from "node:assert/strict";
import { pathToFileURL, fileURLToPath } from "node:url";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
const host = process.env.JORGEX_PI_TEST_HOST;

async function importCompactTools() {
  const { createJiti } = await import(pathToFileURL(`${host}/jiti/lib/jiti.mjs`).href);
  const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false, alias: {
    "@earendil-works/pi-coding-agent": `${host}/@earendil-works/pi-coding-agent/dist/index.js`,
    "@earendil-works/pi-tui": `${host}/@earendil-works/pi-tui/dist/index.js`,
  } });
  return jiti.import(fileURLToPath(new URL("../extensions/compact-tools.ts", import.meta.url)));
}

test("group visibility preserves native tool detail and restores the transcript", { skip: !host }, async () => {
  const agent = await import(pathToFileURL(`${host}/@earendil-works/pi-coding-agent/dist/index.js`).href);
  const tui = await import(pathToFileURL(`${host}/@earendil-works/pi-tui/dist/index.js`).href);
  const { theme } = await import(pathToFileURL(`${host}/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js`).href);
  assert.equal(agent.VERSION, "1.0.0", "the prepared component host must be Pi 1.0.0");
  agent.initTheme("dark", false);
  const chat = new tui.Container();
  const originalRender = chat.render;
  const ui = { requestRender() {} };
  const thought = new agent.AssistantMessageComponent({ role: "assistant", content: [{ type: "thinking", thinking: "THOUGHT-DETAIL" }] }, true);
  chat.addChild(thought);
  for (const [id, name] of [["r1", "read"], ["r2", "read"], ["e1", "edit"], ["c1", "codemode"]]) {
    const definition = name === "read" ? agent.createReadToolDefinition("/example") : name === "edit" ? agent.createEditToolDefinition("/example") : {};
    const row = new agent.ToolExecutionComponent(name, id, { path: "/example/file" }, { showImages: false }, definition, ui, "/example");
    row.updateResult({ content: [{ type: "text", text: `DETAIL-${id}\nSECOND-${id}\n${Array.from({ length: 24 }, (_, n) => `LINE-${n}-${id}`).join("\n")}` }], details: undefined }, false);
    chat.addChild(row);
  }
  const nativeCompact = originalRender.call(chat, 100).join("\n");
  const { mountCompactTools } = await importCompactTools();
  const restore = mountCompactTools(chat, { ...tui, ...agent, theme, requestRender: ui.requestRender });
  try {
    const collapsed = chat.render(100).join("\n");
    assert.match(collapsed, /1 edit, 1 thought, 2 reads, 1 tool/);
    assert.doesNotMatch(collapsed, /DETAIL-/);
    const click = { type: "click", button: "left", x: 2, y: 1, screenX: 2, screenY: 1, width: 100, height: 2 };
    chat.handleMouse(click);
    const expanded = chat.render(100).join("\n");
    assert.ok(expanded.endsWith(nativeCompact), "opening the group must render exactly the native compact components");
    assert.doesNotMatch(expanded, /LINE-23-c1/);
    assert.equal(chat.children[1].expanded, false, "group visibility must not change native tool detail");
    assert.equal(thought.hideThinkingBlock, true, "opening a group must not force reasoning visibility");
    assert.doesNotMatch(expanded, /THOUGHT-DETAIL/);
    const rows = chat.children.filter(row => row instanceof agent.ToolExecutionComponent);
    for (const row of rows) row.setExpanded(true);
    const nativeFull = originalRender.call(chat, 100).join("\n");
    const groupedFull = chat.render(100).join("\n");
    assert.ok(groupedFull.endsWith(nativeFull), "native detail changes must leave the group open and render exactly the native full components");
    assert.match(groupedFull, /LINE-23-r1/);
    assert.match(groupedFull, /LINE-23-c1/);
    for (const row of rows) row.setExpanded(false);
    const compactAgain = chat.render(100).join("\n");
    assert.ok(compactAgain.endsWith(nativeCompact));
    assert.match(compactAgain, /DETAIL-c1/);
    assert.doesNotMatch(compactAgain, /LINE-23-c1/);
    chat.handleMouse({ ...click, height: chat.render(100).length });
    assert.doesNotMatch(chat.render(100).join("\n"), /DETAIL-/);
    chat.addChild(new tui.Text("ANSWER", 0, 0));
    assert.match(chat.render(100).join("\n"), /ANSWER/);
    const failed = new agent.ToolExecutionComponent("bash", "bad", {}, { showImages: false }, undefined, ui, "/example");
    failed.updateResult({ content: [{ type: "text", text: "FAILURE DETAIL" }], details: undefined, isError: true }, false);
    chat.addChild(failed);
    assert.match(chat.render(100).join("\n"), /1 failed/);
    assert.equal(chat.children.length, 7, "presentation must not replace stored components");
  } finally {
    restore();
  }
  assert.equal(chat.render, originalRender);
  assert.match(chat.render(100).join("\n"), /DETAIL-c1/);
});

test("configuration enables or disables the extension without registering a command", { skip: !host }, async t => {
  let owned;
  const previous = process.env.PI_CODING_AGENT_DIR;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    if (owned) {
      rmSync(owned, { recursive: true, force: true });
      assert.equal(existsSync(owned), false);
    }
  });
  owned = mkdtempSync(join(tmpdir(), "jorgex-compact-config-"));
  process.env.PI_CODING_AGENT_DIR = owned;
  const configDir = join(owned, "extensions", "jorgex-compact-tools");
  mkdirSync(configDir, { recursive: true });
  const { default: extension } = await importCompactTools();
  const handlers = new Map();
  let widget;
  const warnings = [];
  extension({ on: (name, handler) => handlers.set(name, handler), registerCommand() { assert.fail("no extension command should be registered"); } });
  const ctx = { mode: "tui", ui: {
    setWidget: (_name, factory) => { widget?.dispose?.(); widget = factory?.({ requestRender() {} }, {}); },
    notify: text => warnings.push(text),
  } };
  t.after(() => handlers.get("session_shutdown")());
  for (const [config, expected] of [[{ enabled: false }, false], [{ enabled: true }, true], [{ enabled: "false" }, false]]) {
    writeFileSync(join(configDir, "config.json"), JSON.stringify(config));
    await handlers.get("session_start")({}, ctx);
    assert.equal(Boolean(widget), expected);
  }
  assert.equal(warnings.length, 1);
  rmSync(join(configDir, "config.json"));
  await handlers.get("session_start")({}, ctx);
  assert.equal(Boolean(widget), true, "missing config defaults to enabled");
});

test("Pi reload refreshes the grouping helper rather than retaining a cached module", { skip: !host }, async t => {
  let owned;
  const previous = process.env.PI_CODING_AGENT_DIR;
  let extension;
  const ctx = { mode: "tui", ui: {} };
  t.after(async () => {
    try { await extension?.handlers.get("session_shutdown")?.[0]({}, ctx); }
    finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      if (owned) {
        rmSync(owned, { recursive: true, force: true });
        assert.equal(existsSync(owned), false);
      }
    }
  });
  owned = mkdtempSync(join(tmpdir(), "jorgex-compact-reload-"));
  process.env.PI_CODING_AGENT_DIR = owned;
  const entryPath = join(owned, "index.ts");
  writeFileSync(entryPath, readFileSync(new URL("../extensions/compact-tools.ts", import.meta.url)));
  const original = readFileSync(entryPath, "utf8");
  assert.ok(original.includes("export function mountCompactTools(chat, host) {"));
  const agent = await import(pathToFileURL(`${host}/@earendil-works/pi-coding-agent/dist/index.js`).href);
  const tui = await import(pathToFileURL(`${host}/@earendil-works/pi-tui/dist/index.js`).href);
  const { theme } = await import(pathToFileURL(`${host}/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js`).href);
  const loader = await import(pathToFileURL(`${host}/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js`).href);
  agent.initTheme("dark", false);
  const screen = new tui.Container();
  screen.requestRender = () => {};
  const chat = new tui.Container();
  screen.addChild(chat);
  chat.addChild(new agent.ToolExecutionComponent("read", "r1", { path: "/example/a" }, {}, {}, screen, "/example"));
  let widget;
  ctx.ui = {
    setWidget: (_key, factory) => { widget?.dispose?.(); widget = factory?.(screen, theme); },
    notify: text => assert.fail(text),
  };
  for (const revision of [1, 2]) {
    await extension?.handlers.get("session_shutdown")?.[0]({}, ctx);
    writeFileSync(entryPath, original.replace("export function mountCompactTools(chat, host) {", `export function mountCompactTools(chat, host) { chat.loadedRevision = ${revision};`));
    loader.clearExtensionCache();
    const loaded = await loader.loadExtensions([entryPath], owned);
    assert.deepEqual(loaded.errors, []);
    extension = loaded.extensions[0];
    await extension.handlers.get("session_start")[0]({}, ctx);
    widget.render();
    assert.equal(chat.loadedRevision, revision, "reload must use the updated helper, not the previous ESM module");
    assert.match(chat.render(80).join("\n"), /1 read/);
  }
});
