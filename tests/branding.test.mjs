import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { visibleWidth } from "@earendil-works/pi-tui";

const testDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(testDir, "..");
const themePath = join(root, "themes", "JorgeX.json");
const designPath = join(root, "DESIGN.md");
const logoSourcePath = join(root, "assets", "brand", "eye-logo.svg");
const canonicalLogoSha256 = "0bd562e7707995135a5751ecf055a032c8f12a3d0b1f373e2299a6b94c4dab5d";
const packageManifest = readJson(join(root, "package.json"));
const runtimeAgents = readJson(join(root, "contract", "runtime-agents.v1.json"));

test("JorgeX declares a valid opt-in Pi theme without selecting it", async () => {
  assert.deepEqual(packageManifest.pi?.themes, ["./themes/JorgeX.json"]);

  const theme = readJson(themePath);
  assert.equal(theme.name, "JorgeX");

  const design = readFileSync(designPath, "utf8");
  const tokenMatch = design.match(/<!-- jorgex-pi:theme:start -->\s*```json\s*([\s\S]*?)\s*```\s*<!-- jorgex-pi:theme:end -->/);
  assert.ok(tokenMatch, "DESIGN.md must expose one strict JSON theme block as the design authority");
  const tokens = JSON.parse(tokenMatch[1]);
  assert.deepEqual(tokens.palette, {
    background: "#060913",
    surface: "#0B1120",
    primary: "#22D3EE",
    primaryStrong: "#06B6D4",
    secondary: "#A78BFA",
    secondaryStrong: "#8B5CF6",
    text: "#F8FAFC",
    textSecondary: "#E2E8F0",
    muted: "#64748B",
    success: "#10B981",
    error: "#EF4444",
    warning: "#F59E0B"
  });
  assert.equal(theme.vars.background, tokens.palette.background);
  assert.equal(theme.vars.surface, tokens.palette.surface);
  assert.equal(theme.vars.cyan, tokens.palette.primary);
  assert.equal(theme.vars.cyanStrong, tokens.palette.primaryStrong);
  assert.equal(theme.vars.purple, tokens.palette.secondary);
  assert.equal(theme.vars.purpleStrong, tokens.palette.secondaryStrong);
  assert.equal(theme.vars.text, tokens.palette.text);
  assert.equal(theme.vars.textSecondary, tokens.palette.textSecondary);
  assert.equal(theme.vars.muted, tokens.palette.muted);
  assert.equal(theme.vars.green, tokens.palette.success);

  const sourceLogo = readFileSync(logoSourcePath, "utf8").trimEnd();
  assert.equal(createHash("sha256").update(sourceLogo).digest("hex"), canonicalLogoSha256, "the package brand source must preserve the exact reviewed JorgeX eye SVG content");

  const piPackageEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const piPackageRoot = resolve(dirname(piPackageEntry), "..");
  const loaderPath = join(piPackageRoot, "dist", "modes", "interactive", "theme", "theme.js");
  const { loadThemeFromPath } = await import(pathToFileURL(loaderPath).href);
  assert.equal(loadThemeFromPath(themePath).name, "JorgeX", "the declared theme must load through Pi 0.84.2's native loader");
});

test("JorgeX header is TUI-only, reversible, and leaves the active theme alone", async () => {
  const { VERSION } = await import("@earendil-works/pi-coding-agent");
  const { default: installBranding } = await import("../extensions/branding.ts");
  const pi = createPiHarness();
  installBranding(pi.api);

  assert.deepEqual(pi.commandNames(), ["jorgex:header"]);

  const headers = [];
  const preferences = { activeTheme: "user-selected-theme" };
  let themeSelections = 0;
  const workspace = join(root, "fixtures", `sample-workspace-${"界".repeat(30)}🚀`);
  const tuiContext = {
    mode: "tui",
    cwd: workspace,
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

  const header = headers[0]({ requestRender() {} }, fakeTheme());
  const narrow = header.render(39);
  assert.ok(narrow.every((line) => visibleWidth(line) <= 39), "narrow branding must never overflow");
  assert.match(narrow.join("\n"), /[⠀-⣿]/u, "narrow branding must retain an SVG-derived Braille eye mark");

  const compact = header.render(40);
  assert.ok(compact.every((line) => visibleWidth(line) <= 40), "compact branding must fit its activation width");
  assert.match(compact.join("\n"), /JorgeX Pi/);
  assert.match(compact.join("\n"), new RegExp(`PI\\s+v${VERSION.replaceAll(".", "\\.")}`, "i"));
  assert.match(compact.join("\n"), new RegExp(`PACKAGE\\s+v${packageManifest.version.replaceAll(".", "\\.")}`, "i"));
  assert.match(compact.join("\n"), new RegExp(`${runtimeAgents.agents.filter(({ status }) => status === "runnable").length} RUNNABLE`));
  assert.match(compact.join("\n"), new RegExp(`${packageManifest.pi.skills.length} PACKAGED`));
  assert.match(compact.join("\n"), /sample-workspace/);
  assert.match(compact.join("\n"), /\/jorgex:header builtin/);

  const wide = header.render(100);
  assert.ok(wide.every((line) => visibleWidth(line) <= 100), "wide branding must fit its activation width");
  assert.match(wide.slice(0, 9).join("\n"), /[⠀-⣿]/u, "wide branding must use the detailed SVG-derived eye");
  assert.match(wide.slice(0, 9).join("\n"), /JorgeX Pi|JORGEX PI/, "wide branding must compose the JorgeX Pi wordmark to the right of the eye");
  assert.doesNotMatch(wide.join("\n"), /_{4,}|\\_{2,}|<\s+\/./, "the rejected hand-drawn underscore eye must not survive");
  assert.equal(typeof header.dispose, "function", "the animated header must own a deterministic dispose hook");

  const previousNoColor = process.env.NO_COLOR;
  delete process.env.NO_COLOR;
  try {
    const themedHeader = headers[0]({ requestRender() {} }, tokenTheme());
    const themedWide = themedHeader.render(100);
    assert.ok(themedWide.slice(0, 8).every((line) => line.startsWith("<text>")), "the eye and JorgeX Pi wordmark must use the white text token");
    assert.ok(themedWide[9].startsWith("<muted>"), "package metadata must retain its muted semantic color");
    themedHeader.dispose();
  } finally {
    if (previousNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previousNoColor;
  }

  await pi.emitLifecycle("session_start", {}, { mode: "rpc", ui: tuiContext.ui });
  assert.equal(headers.length, 1, "non-TUI sessions must not install terminal branding");

  await pi.executeCommand("jorgex:header", "builtin", tuiContext);
  assert.equal(headers.at(-1), undefined, "`/jorgex:header builtin` must restore Pi's built-in header");

  await pi.executeCommand("jorgex:header", "custom", tuiContext);
  assert.equal(typeof headers.at(-1), "function", "`/jorgex:header custom` must reapply JorgeX branding");
  assert.equal(themeSelections, 0, "neither header command may select or persist a theme");
});

test("branding has no stdout clearing, shell, network, or settings-write surface", () => {
  const source = readFileSync(join(root, "extensions", "branding.ts"), "utf8");
  assert.doesNotMatch(
    source,
    /\b(?:console\.(?:log|info|warn|error)|process\.stdout\.write|process\.stderr\.write|child_process|execFile|spawn|fetch|writeFile|appendFile|mkdir|rmSync)\b/,
    "branding may animate in memory but must not clear output, run processes, use network, or write settings",
  );
});

test("the finite reveal honors reduced motion and releases its timer", async () => {
  const previous = snapshotEnvironment(["CI", "TERM", "JORGEX_PI_MOTION"]);
  const previousIsTty = process.stdout.isTTY;
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  try {
    process.env.JORGEX_PI_MOTION = "full";
    delete process.env.CI;
    process.env.TERM = "xterm-256color";
    const animatedPi = createPiHarness();
    const { default: installBranding } = await import(`../extensions/branding.ts?animation=${Date.now()}`);
    installBranding(animatedPi.api);
    let renders = 0;
    let factory;
    await animatedPi.emitLifecycle("session_start", {}, {
      mode: "tui",
      cwd: root,
      ui: { setHeader(value) { factory = value; } },
    });
    const component = factory({ requestRender() { renders += 1; } }, fakeTheme());
    await delay(100);
    assert.ok(renders > 0, "full motion must request finite animation frames");
    component.dispose();
    const stoppedAt = renders;
    await delay(100);
    assert.equal(renders, stoppedAt, "dispose must stop every future frame");

    let narrowRenders = 0;
    const narrow = factory({ terminal: { columns: 39 }, requestRender() { narrowRenders += 1; } }, fakeTheme());
    await delay(100);
    assert.equal(narrowRenders, 0, "narrow terminals must stay static even when full motion is requested");
    narrow.dispose();

    process.env.JORGEX_PI_MOTION = "reduce";
    const reducedPi = createPiHarness();
    installBranding(reducedPi.api);
    let reducedRenders = 0;
    let reducedFactory;
    await reducedPi.emitLifecycle("session_start", {}, {
      mode: "tui",
      cwd: root,
      ui: { setHeader(value) { reducedFactory = value; } },
    });
    const reduced = reducedFactory({ requestRender() { reducedRenders += 1; } }, fakeTheme());
    await delay(100);
    assert.equal(reducedRenders, 0, "reduced motion must render the final static frame without a timer");
    reduced.dispose();
  } finally {
    restoreEnvironment(previous);
    if (previousIsTty === undefined) delete process.stdout.isTTY;
    else Object.defineProperty(process.stdout, "isTTY", { value: previousIsTty, configurable: true });
  }
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

function fakeTheme() {
  return { fg: (_token, text) => text };
}

function tokenTheme() {
  return { fg: (token, text) => `<${token}>${text}` };
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function snapshotEnvironment(keys) {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function restoreEnvironment(snapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
