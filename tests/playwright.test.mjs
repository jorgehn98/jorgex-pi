import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
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
        detectMcpAdapterConflict: () => undefined,
        readGoalConfig: () => ({ kind: "loaded" }),
        installMcpEngram: async () => ({ state: "managed" }),
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
    ["engramProtocol", "engram-protocol.md"],
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
