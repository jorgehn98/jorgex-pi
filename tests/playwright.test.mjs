import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep, win32 } from "node:path";
import test from "node:test";

const EXPECTED_VERSION = "0.1.18";

function createSandbox(reportedVersion = EXPECTED_VERSION) {
  const root = mkdtempSync(join(tmpdir(), "jorgex-pi-playwright-"));
  const agentDir = join(root, "agent");
  const handoffDir = join(agentDir, "jorgex-pi");
  const command = join(root, "playwright-cli");
  mkdirSync(handoffDir, { recursive: true });
  writeFileSync(command, `#!/bin/sh
if [ "$1" != "--version" ]; then exit 64; fi
printf 'playwright-cli ${reportedVersion}\\n'
`);
  chmodSync(command, 0o755);
  return {
    root,
    agentDir,
    command,
    handoffPath: join(handoffDir, "playwright.v1.json"),
  };
}

function validHandoff(command, overrides = {}) {
  return {
    schemaVersion: 1,
    enabled: true,
    command,
    version: EXPECTED_VERSION,
    ...overrides,
  };
}

function writeHandoff(fixture, value) {
  writeFileSync(fixture.handoffPath, typeof value === "string" ? value : `${JSON.stringify(value)}\n`);
}

async function resolverModule() {
  return import("../extensions/playwright.ts");
}

async function withAgentDir(agentDir, callback) {
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    return await callback();
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
}

function browserTreeDigest(root) {
  const entries = [];
  const visit = (directory) => {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, item.name);
      const rel = relative(root, full).split(sep).join("/");
      if (item.isDirectory()) { entries.push({ kind: "dir", rel }); visit(full); }
      else if (item.isSymbolicLink()) entries.push({ kind: "symlink", rel, target: readlinkSync(full) });
      else if (item.isFile()) entries.push({ kind: "file", rel });
      else throw new Error(`unsupported test entry: ${full}`);
    }
  };
  visit(root);
  entries.sort((a, b) => a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0);
  const hash = createHash("sha256").update("browser-v2\0");
  for (const item of entries) {
    const bytes = item.kind === "symlink" ? Buffer.from(item.target)
      : item.kind === "file" ? readFileSync(join(root, ...item.rel.split("/"))) : Buffer.alloc(0);
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(`${item.kind}\0${item.rel}\0`).update(length).update(bytes);
  }
  return hash.digest("hex");
}

function trustedFixture() {
  const fixture = createSandbox("0.1.21");
  const rootPath = join(fixture.root, "managed-release");
  const treePath = join(rootPath, "node_modules");
  const packagePath = join(treePath, "@playwright", "cli");
  const entryPath = join(packagePath, "entry.js");
  const launcherPath = join(rootPath, "launcher.mjs");
  const marker = join(fixture.root, "version-probe.marker");
  mkdirSync(packagePath, { recursive: true });
  writeFileSync(join(packagePath, "package.json"), '{"name":"@playwright/cli","version":"0.1.21"}\n');
  writeFileSync(entryPath, "export {};\n");
  symlinkSync("entry.js", join(packagePath, "runtime-link"));
  writeFileSync(launcherPath, "await import('./node_modules/@playwright/cli/entry.js');\n");
  writeFileSync(fixture.command, `#!/bin/sh\nif [ "$1" != "--version" ]; then exit 64; fi\nprintf 'ran\\n' > '${marker}'\nprintf 'playwright-cli 0.1.21\\n'\n`);
  chmodSync(fixture.command, 0o755);
  const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
  const handoff = {
    schemaVersion: 2, enabled: true, command: fixture.command, version: "0.1.21",
    commandSha256: sha(fixture.command), rootPath, treePath, entryPath,
    launcherPath, launcherSha256: sha(launcherPath), treeSha256: browserTreeDigest(treePath),
  };
  return { ...fixture, marker, handoff, entryPath, launcherPath, treePath };
}

test("T33 RED: trusted Playwright v2 accepts safe relative links and validates before version spawn", { skip: process.platform === "win32" }, async () => {
  const { resolvePlaywrightCapability } = await resolverModule();
  const fixture = trustedFixture();
  try {
    writeHandoff(fixture, fixture.handoff);
    const ready = resolvePlaywrightCapability({ agentDir: fixture.agentDir });
    assert.equal(ready.status, "ready", "v2 evidence must be accepted after validation");
    assert.equal(ready.commandPath, fixture.command);
    assert.equal(readFileSync(fixture.marker, "utf8"), "ran\n");
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("T33 RED: Playwright v2 tamper and foreign command block before the version marker", { skip: process.platform === "win32" }, async () => {
  const { resolvePlaywrightCapability } = await resolverModule();
  for (const [name, change] of [
    ["launcher drift", (f) => writeFileSync(f.launcherPath, "mutated launcher\n")],
    ["tree drift", (f) => writeFileSync(f.entryPath, "mutated entry\n")],
    ["foreign command", (f) => { f.handoff.command = join(f.root, "other-command"); writeFileSync(f.handoff.command, "#!/bin/sh\nexit 0\n"); chmodSync(f.handoff.command, 0o755); }],
    ["command digest drift", (f) => { f.handoff.commandSha256 = "0".repeat(64); }],
    ["self-verifying command inside managed root", (f) => {
      const command = join(f.handoff.rootPath, "mutable-command");
      copyFileSync(f.command, command);
      chmodSync(command, 0o755);
      f.handoff.command = command;
      f.handoff.commandSha256 = createHash("sha256").update(readFileSync(command)).digest("hex");
    }],
    ["absolute symlink with matching tree digest", (f) => {
      const link = join(f.treePath, "@playwright", "cli", "runtime-link");
      unlinkSync(link);
      symlinkSync(f.command, link);
      f.handoff.treeSha256 = browserTreeDigest(f.treePath);
    }],
    ["symlink chain with matching tree digest", (f) => {
      const dir = join(f.treePath, "@playwright", "cli");
      unlinkSync(join(dir, "runtime-link"));
      symlinkSync("entry.js", join(dir, "other-link"));
      symlinkSync("other-link", join(dir, "runtime-link"));
      f.handoff.treeSha256 = browserTreeDigest(f.treePath);
    }],
    ["extra key", (f) => { f.handoff.extra = true; }],
  ]) {
    const fixture = trustedFixture();
    try {
      change(fixture);
      writeHandoff(fixture, fixture.handoff);
      assert.equal(resolvePlaywrightCapability({ agentDir: fixture.agentDir }).status, "hidden", name);
      assert.equal(fsExists(fixture.marker), false, `${name} must block before --version`);
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  }
});

function fsExists(file) {
  try { readFileSync(file); return true; } catch { return false; }
}

test("the default Playwright resolver accepts only an exact handoff and a real matching executable", async () => {
  const { resolvePlaywrightCapability } = await resolverModule();
  const fixture = createSandbox();
  try {
    writeHandoff(fixture, validHandoff(fixture.command));
    const capability = resolvePlaywrightCapability({ agentDir: fixture.agentDir });

    assert.equal(capability.status, "ready");
    assert.equal(capability.commandPath, fixture.command);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("missing, malformed, non-exact, or unverifiable Playwright handoffs stay hidden", async () => {
  const { resolvePlaywrightCapability } = await resolverModule();
  const scenarios = [
    {
      label: "missing handoff",
      setup: () => {},
    },
    {
      label: "malformed JSON",
      setup: (fixture) => writeHandoff(fixture, "{\n"),
    },
    {
      label: "missing command",
      setup: (fixture) => writeHandoff(fixture, validHandoff(fixture.command, { command: undefined })),
    },
    {
      label: "extra key",
      setup: (fixture) => writeHandoff(fixture, validHandoff(fixture.command, { extra: true })),
    },
    {
      label: "wrong schema version",
      setup: (fixture) => writeHandoff(fixture, validHandoff(fixture.command, { schemaVersion: 2 })),
    },
    {
      label: "disabled",
      setup: (fixture) => writeHandoff(fixture, validHandoff(fixture.command, { enabled: false })),
    },
    {
      label: "wrong declared version",
      setup: (fixture) => writeHandoff(fixture, validHandoff(fixture.command, { version: "0.1.17" })),
    },
    {
      label: "relative command",
      setup: (fixture) => writeHandoff(fixture, validHandoff(fixture.command, { command: "playwright-cli" })),
    },
    {
      label: "missing executable",
      setup: (fixture) => writeHandoff(fixture, validHandoff(join(fixture.root, "missing-playwright-cli"))),
    },
    {
      label: "wrong reported version",
      setup: (fixture) => {
        const wrongVersion = createSandbox("0.1.17");
        writeHandoff(fixture, validHandoff(wrongVersion.command));
        return () => rmSync(wrongVersion.root, { recursive: true, force: true });
      },
    },
  ];

  for (const scenario of scenarios) {
    const fixture = createSandbox();
    let cleanupScenario;
    try {
      cleanupScenario = scenario.setup(fixture);
      const capability = resolvePlaywrightCapability({ agentDir: fixture.agentDir });
      assert.equal(capability.status, "hidden", scenario.label);
      assert.equal(capability.commandPath, undefined, scenario.label);
    } finally {
      cleanupScenario?.();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test("the default bootstrap resolver advertises only the verified temporary Playwright path", async () => {
  const { createBootstrap } = await import("../extensions/bootstrap.ts");
  const fixture = createSandbox();
  const pi = createPiHarness();
  try {
    writeHandoff(fixture, validHandoff(fixture.command));
    await withAgentDir(fixture.agentDir, async () => {
      await createBootstrap({
        loadCompanion: async () => () => {},
        getPermissionsService: () => ({ ready: true }),
        detectWebAccessConflict: () => undefined,
        detectGoalConflict: () => undefined,
        readGoalConfig: () => ({ kind: "loaded" }),
        resolveMcpEngram: async () => ({ state: "managed" }),
        readSystemPromptAssets: readSystemPromptAssets,
      })(pi.api);
      const result = await pi.beforeAgentStart({ systemPrompt: "Existing prompt" }, { sessionId: "playwright-default" });
      const webAccessBlock = extractManagedBlock(result.systemPrompt, "jorgex:web-access");
      const playwrightBlock = extractManagedBlock(result.systemPrompt, "jorgex:playwright");

      assert.match(playwrightBlock, new RegExp(`Use Playwright at ${escapeRegExp(fixture.command)}`));
      assert.equal((playwrightBlock.match(/Use Playwright at /g) ?? []).length, 1);
      assert.match(webAccessBlock, /Use Web Access for web research/i);
      assert.equal(result.systemPrompt.includes("<!-- jorgex:browser -->"), false);
      assert.equal(result.systemPrompt.includes("<!-- jorgex:context7 -->"), false);
      assert.equal(result.systemPrompt.includes("jorgex:engram-protocol"), false, "provider-only Pi must never inject the retired JorgeX Engram marker");
      assert.equal(result.systemPrompt.includes("Legacy Engram"), false, "stale legacy Engram payload must not survive browser routing");
      assert.equal(playwrightBlock.includes("PI_CODING_AGENT_DIR"), false);
      assert.equal(playwrightBlock.includes("playwright.v1.json"), false);
    });
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Windows .cmd handoff uses an explicit quoted ComSpec invocation", { skip: process.platform === "win32" ? "the fixture uses POSIX temporary filenames to simulate Windows paths" : false }, async () => {
  const { resolvePlaywrightCapability } = await resolverModule();
  const fixture = createWindowsSandbox();
  const invocations = [];
  const previousCwd = process.cwd();
  try {
    process.chdir(fixture.root);
    writeHandoff(fixture, validHandoff(fixture.command));
    writeFileSync(fixture.command, "fixture");
    const capability = resolvePlaywrightCapability({
      agentDir: fixture.agentDir,
      platform: "win32",
      env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      execFileSync(command, args, options) {
        invocations.push({ command, args, windowsVerbatimArguments: options.windowsVerbatimArguments });
        return "playwright-cli 0.1.18\n";
      },
    });

    assert.equal(capability.status, "ready");
    assert.equal(capability.commandPath, fixture.command);
    assert.deepEqual(invocations, [{
      command: "C:\\Windows\\System32\\cmd.exe",
      windowsVerbatimArguments: true,
      args: ["/d", "/s", "/c", '""C:\\Program Files\\Playwright\\playwright-cli.cmd" --version"'],
    }]);
  } finally {
    process.chdir(previousCwd);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Windows handoff rejects control characters and shell metacharacters before invocation", { skip: process.platform === "win32" ? "the fixture uses POSIX temporary filenames to simulate Windows paths" : false }, async () => {
  const { resolvePlaywrightCapability } = await resolverModule();
  for (const command of ["C:\\tools\\playwright-cli\n.cmd", "C:\\tools\\playwright-cli&whoami.cmd"]) {
    const fixture = createWindowsSandbox();
    const invocations = [];
    const previousCwd = process.cwd();
    try {
      process.chdir(fixture.root);
      writeHandoff(fixture, validHandoff(command));
      const capability = resolvePlaywrightCapability({
        agentDir: fixture.agentDir,
        platform: "win32",
        env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
        execFileSync(...args) { invocations.push(args); return "playwright-cli 0.1.18\n"; },
      });

      assert.equal(capability.status, "hidden", command);
      assert.deepEqual(invocations, [], command);
    } finally {
      process.chdir(previousCwd);
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test("Stack-observed Playwright 0.1.21 handoff resolves ready on exact reported match", async () => {
  const { resolvePlaywrightCapability } = await resolverModule();
  const OBSERVED_VERSION = "0.1.21";
  for (const scenario of [
    { label: "latest stays rejected", version: "latest", reported: OBSERVED_VERSION },
    { label: "range stays rejected", version: "^0.1.21", reported: OBSERVED_VERSION },
    { label: "missing version stays rejected", version: undefined, reported: OBSERVED_VERSION },
    { label: "mismatched report stays rejected", version: OBSERVED_VERSION, reported: "0.1.18" },
    { label: "extra key stays rejected", version: OBSERVED_VERSION, reported: OBSERVED_VERSION, extra: true },
  ]) {
    const fixture = createSandbox(scenario.reported);
    try {
      writeHandoff(fixture, validHandoff(fixture.command, { version: scenario.version, ...(scenario.extra ? { extra: true } : {}) }));
      const capability = resolvePlaywrightCapability({ agentDir: fixture.agentDir });
      assert.equal(capability.status, "hidden", scenario.label);
      assert.equal(capability.commandPath, undefined, scenario.label);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
  for (const label of ["relative command stays rejected", "missing executable stays rejected"]) {
    const fixture = createSandbox(OBSERVED_VERSION);
    try {
      const command = label.startsWith("relative") ? "playwright-cli" : join(fixture.root, "missing-playwright-cli");
      writeHandoff(fixture, validHandoff(command, { version: OBSERVED_VERSION }));
      const capability = resolvePlaywrightCapability({ agentDir: fixture.agentDir });
      assert.equal(capability.status, "hidden", label);
      assert.equal(capability.commandPath, undefined, label);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
  const observed = createSandbox(OBSERVED_VERSION);
  try {
    writeHandoff(observed, validHandoff(observed.command, { version: OBSERVED_VERSION }));
    const capability = resolvePlaywrightCapability({ agentDir: observed.agentDir });
    assert.equal(capability.status, "ready", "observed 0.1.21 exact reported-vs-handoff match must resolve ready");
    assert.equal(capability.commandPath, observed.command);
  } finally {
    rmSync(observed.root, { recursive: true, force: true });
  }
});

function createPiHarness() {
  const lifecycleHandlers = new Map();
  const eventHandlers = new Map();
  const add = (map, name, handler) => map.set(name, [...(map.get(name) ?? []), handler]);
  const api = {
    on(name, handler) { add(lifecycleHandlers, name, handler); },
    events: {
      on(name, handler) { add(eventHandlers, name, handler); },
      emit() {},
    },
    registerTool() {},
    getActiveTools: () => [],
    setActiveTools() {},
  };
  return {
    api,
    async beforeAgentStart(event, context) {
      let result;
      for (const handler of lifecycleHandlers.get("before_agent_start") ?? []) {
        const current = await handler(event, context);
        if (current !== undefined) result = current;
      }
      return result;
    },
  };
}

function createWindowsSandbox() {
  const root = mkdtempSync(join(tmpdir(), "jorgex-pi-playwright-win-"));
  const agentDir = "C:\\jorgex\\pi-agent";
  const command = "C:\\Program Files\\Playwright\\playwright-cli.cmd";
  const handoffPath = win32.join(agentDir, "jorgex-pi", "playwright.v1.json");
  return { root, agentDir, command, handoffPath };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readSystemPromptAssets() {
  return Object.fromEntries([
    ["policy", "AGENTS.md"],
    ["context7", "context7.md"],
    ["playwright", "browser-playwright.md"],
    ["devtools", "browser-chrome-devtools.md"],
  ].map(([name, file]) => [name, readFileSync(new URL(`../assets/system-prompt/${file}`, import.meta.url), "utf8")]));
}

function extractManagedBlock(prompt, marker) {
  const opening = `<!-- ${marker} -->`;
  const closing = `<!-- /${marker} -->`;
  assert.equal((prompt.match(new RegExp(escapeRegExp(opening), "g")) ?? []).length, 1, `${marker} must have one opening marker`);
  assert.equal((prompt.match(new RegExp(escapeRegExp(closing), "g")) ?? []).length, 1, `${marker} must have one closing marker`);
  const start = prompt.indexOf(opening) + opening.length;
  const end = prompt.indexOf(closing, start);
  assert.ok(end >= start, `${marker} must close after its opening marker`);
  return prompt.slice(start, end);
}
