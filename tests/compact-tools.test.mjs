import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
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
