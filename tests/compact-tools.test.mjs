import assert from "node:assert/strict";
import { pathToFileURL, fileURLToPath } from "node:url";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { mountCompactTools } from "../extensions/compact-tools.mjs";

const host = process.env.JORGEX_PI_TEST_HOST;

test("group, expand every original result, collapse and restore the transcript", { skip: !host }, async () => {
  const agent = await import(pathToFileURL(`${host}/@earendil-works/pi-coding-agent/dist/index.js`).href);
  const tui = await import(pathToFileURL(`${host}/@earendil-works/pi-tui/dist/index.js`).href);
  const { theme } = await import(pathToFileURL(`${host}/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js`).href);
  assert.equal(agent.VERSION, "1.0.0", "the prepared component host must be Pi 1.0.0");
  agent.initTheme("dark", false);
  const chat = new tui.Container();
  const originalRender = chat.render;
  const ui = { requestRender() {} };
  for (const [id, name] of [["r1", "read"], ["r2", "read"], ["e1", "edit"], ["c1", "codemode"]]) {
    const row = new agent.ToolExecutionComponent(name, id, { path: "/example/file" }, { showImages: false }, undefined, ui, "/example");
    row.updateResult({ content: [{ type: "text", text: `DETAIL-${id}\nSECOND-${id}` }], details: undefined }, false);
    chat.addChild(row);
  }
  const restore = mountCompactTools(chat, { ...tui, ...agent, theme, requestRender: ui.requestRender, getExpanded: () => false });
  try {
    const collapsed = chat.render(100).join("\n");
    assert.match(collapsed, /1 edit, 2 reads, 1 tool/);
    assert.doesNotMatch(collapsed, /DETAIL-/);
    const click = { type: "click", button: "left", x: 2, y: 1, screenX: 2, screenY: 1, width: 100, height: 2 };
    chat.handleMouse(click);
    const expanded = chat.render(100).join("\n");
    for (const id of ["r1", "r2", "e1", "c1"]) assert.match(expanded, new RegExp(`SECOND-${id}`));
    chat.handleMouse({ ...click, height: chat.render(100).length });
    assert.doesNotMatch(chat.render(100).join("\n"), /DETAIL-/);
    chat.addChild(new tui.Text("ANSWER", 0, 0));
    assert.match(chat.render(100).join("\n"), /ANSWER/);
    const failed = new agent.ToolExecutionComponent("bash", "bad", {}, { showImages: false }, undefined, ui, "/example");
    failed.updateResult({ content: [{ type: "text", text: "FAILURE DETAIL" }], details: undefined, isError: true }, false);
    chat.addChild(failed);
    assert.match(chat.render(100).join("\n"), /1 failed/);
    assert.equal(chat.children.length, 6, "presentation must not replace stored components");
  } finally {
    restore();
  }
  assert.equal(chat.render, originalRender);
  assert.match(chat.render(100).join("\n"), /DETAIL-r1/);
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
  const { createJiti } = await import(pathToFileURL(`${host}/jiti/lib/jiti.mjs`).href);
  const jiti = createJiti(import.meta.url, { fsCache: false, alias: {
    "@earendil-works/pi-coding-agent": `${host}/@earendil-works/pi-coding-agent/dist/index.js`,
    "@earendil-works/pi-tui": `${host}/@earendil-works/pi-tui/dist/index.js`,
  } });
  const { default: extension } = await jiti.import(fileURLToPath(new URL("../extensions/compact-tools.ts", import.meta.url)));
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
