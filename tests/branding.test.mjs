import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(testDir, "..");
const themePath = join(root, "themes", "JorgeX.json");

test("JorgeX declares a valid opt-in Pi theme without selecting it", async () => {
  const manifest = readJson(join(root, "package.json"));
  assert.deepEqual(manifest.pi?.themes, ["./themes/JorgeX.json"]);

  const theme = readJson(themePath);
  assert.equal(theme.name, "JorgeX");

  const piPackageEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const piPackageRoot = resolve(dirname(piPackageEntry), "..");
  const loaderPath = join(piPackageRoot, "dist", "modes", "interactive", "theme", "theme.js");
  const { loadThemeFromPath } = await import(pathToFileURL(loaderPath).href);
  assert.equal(loadThemeFromPath(themePath).name, "JorgeX", "the declared theme must load through Pi 0.84.2's native loader");
});

test("JorgeX header is TUI-only, reversible, and leaves the active theme alone", async () => {
  const { default: installBranding } = await import("../extensions/branding.ts");
  const pi = createPiHarness();
  installBranding(pi.api);

  assert.deepEqual(pi.commandNames(), ["jorgex:header"]);

  const headers = [];
  const preferences = { activeTheme: "user-selected-theme" };
  let themeSelections = 0;
  const tuiContext = {
    mode: "tui",
    ui: {
      setHeader: (factory) => headers.push(factory),
      setTheme: (theme) => {
        themeSelections += 1;
        preferences.activeTheme = theme;
      },
    },
  };
  await pi.emitLifecycle("session_start", {}, tuiContext);
  assert.equal(headers.length, 1, "a TUI session must install exactly one custom header");
  assert.equal(typeof headers[0], "function");
  assert.equal(themeSelections, 0, "branding must declare a theme without forcing a user's existing choice");
  assert.equal(preferences.activeTheme, "user-selected-theme", "branding must not replace an existing theme preference");

  const header = headers[0]({}, { fg: (_token, text) => text });
  const rendered = header.render(80);
  assert.ok(rendered.some((line) => /JorgeX/i.test(line)), "the custom header must visibly identify JorgeX");
  assert.deepEqual(header.render(27), ["JorgeX"], "very narrow terminals must use the one-line logo");
  for (const width of [28, 71]) {
    const compact = header.render(width);
    assert.equal(compact.length, 2, `width ${width} must use the compact header`);
    assert.ok(compact.every((line) => line.length <= width), `width ${width} must not overflow`);
    assert.match(compact[1], /\/jorgex:header builtin/, `width ${width} must retain the restore hint`);
  }
  const wide = header.render(72);
  assert.equal(wide.length, 7, "width 72 must switch to the full wordmark");
  assert.ok(wide.every((line) => line.length <= 72), "the full wordmark must fit its activation width");
  assert.match(wide.at(-1), /\/jorgex:header builtin/, "the full wordmark must retain the restore hint");

  await pi.emitLifecycle("session_start", {}, { mode: "rpc", ui: tuiContext.ui });
  assert.equal(headers.length, 1, "non-TUI sessions must not install terminal branding");

  await pi.executeCommand("jorgex:header", "builtin", tuiContext);
  assert.equal(headers.at(-1), undefined, "`/jorgex:header builtin` must restore Pi's built-in header");

  await pi.executeCommand("jorgex:header", "custom", tuiContext);
  assert.equal(typeof headers.at(-1), "function", "`/jorgex:header custom` must reapply JorgeX branding");
  assert.equal(themeSelections, 0, "neither header command may select or persist a theme");
});

test("branding has no stdout, shell, timer, animation, or settings-write surface", () => {
  const source = readFileSync(join(root, "extensions", "branding.ts"), "utf8");
  assert.doesNotMatch(
    source,
    /\b(?:console\.(?:log|info|warn|error)|process\.stdout|process\.stderr|child_process|execFile|spawn|setTimeout|setInterval|requestAnimationFrame|writeFile|appendFile|mkdir|rmSync)\b/,
    "the branding extension must remain a synchronous in-memory TUI customization",
  );
});

function createPiHarness() {
  const lifecycleHandlers = new Map();
  const commands = new Map();
  const add = (name, handler) => lifecycleHandlers.set(name, [...(lifecycleHandlers.get(name) ?? []), handler]);
  return {
    api: {
      on(name, handler) { add(name, handler); },
      registerCommand(name, command) { commands.set(name, command); },
    },
    commandNames: () => [...commands.keys()].sort(),
    async emitLifecycle(name, event, ctx) {
      for (const handler of lifecycleHandlers.get(name) ?? []) await handler(event, ctx);
    },
    async executeCommand(name, args, ctx) {
      const command = commands.get(name);
      assert.ok(command, `${name} must be registered`);
      return command.handler(args, ctx);
    },
  };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
