// Native bootstrap: native Engram-only startup, provider/discovery diagnostics,
// project override handling and the managed-ownership guide policy.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RUNTIME_REGISTER_EVENT, resolveMcpEngramConfig } from "../extensions/mcp-engram.ts";
import {
  BUILTIN_MCP_COMMAND,
  BUILTIN_TOOL_SEARCH,
  DEFERRED_CONTEXT7_TOOL,
  DEFERRED_DEVTOOLS_TOOL,
  FOREIGN_CONTEXT7_TOOL,
  createGuideSandbox,
  createPiHarness,
  ownershipDto,
  runNativeGuideBootstrap,
  snapshotSandbox,
} from "./fixtures/native-guide-bootstrap.mjs";

const PI_SESSION = { hasUI: true, sessionId: "native-bootstrap-session" };

// --- Native Engram-only bootstrap --------------------------------------------
// Pi's own loader reads `<agentDir>/mcp.json` always and `<cwd>/.pi/mcp.json`
// only when the project is trusted, and a project entry replaces the global
// entry with the same name. The project fixture therefore really replaces the
// protected `engram` server, with a different real executable so a diagnosis can
// never be about a broken command.
const PROJECT_OVERRIDE_COMMAND = "/bin/sh";

function createNativeSandbox(t, { projectOverride = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "jorgex-pi-native-bootstrap-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify({ packages: ["npm:gentle-engram@0.1.16"] })}\n`);
  writeFileSync(
    join(agentDir, "mcp.json"),
    `${JSON.stringify(
      { mcpServers: { engram: { command: process.execPath, args: ["mcp", "--tools=agent"], exposure: "deferred" } } },
      null,
      2,
    )}\n`,
  );
  let projectDir;
  if (projectOverride) {
    projectDir = join(root, "project");
    mkdirSync(join(projectDir, ".pi"), { recursive: true });
    writeFileSync(
      join(projectDir, ".pi", "mcp.json"),
      `${JSON.stringify(
        { mcpServers: { engram: { command: PROJECT_OVERRIDE_COMMAND, args: ["mcp", "--tools=agent"], exposure: "deferred" } } },
        null,
        2,
      )}\n`,
    );
  }
  const env = { HOME: root, PI_CODING_AGENT_DIR: agentDir, XDG_CONFIG_HOME: join(root, "xdg") };
  return {
    root,
    agentDir,
    projectDir,
    resolve: (cwd = root) => resolveMcpEngramConfig({ env, platform: "linux", cwd }),
  };
}

function readProjectEngram(sandbox) {
  const file = join(sandbox.projectDir, ".pi", "mcp.json");
  return { file, entry: JSON.parse(readFileSync(file, "utf8")).mcpServers.engram };
}

async function runNativeBootstrap({ commands, tools, activeTools, sandbox, resolutionSink, projectDir, projectTrusted = false }) {
  const { createBootstrap } = await import("../extensions/bootstrap.ts");
  const cwd = projectDir ?? sandbox.root;
  const pi = createPiHarness({ commands, tools, activeTools });
  await createBootstrap({
    loadCompanion: async () => () => {},
    getPermissionsService: () => ({ ready: true }),
    readWebAccessConfig: () => ({}),
    resolvePlaywrightCapability: () => undefined,
    detectWebAccessConflict: () => undefined,
    detectGoalConflict: () => undefined,
    readGoalConfig: () => ({ kind: "loaded" }),
    resolveMcpEngram: async () => {
      const resolution = await sandbox.resolve(cwd);
      if (resolutionSink) resolutionSink.resolution = resolution;
      return resolution;
    },
  })(pi.api);
  // Real public context input: `cwd` plus `isProjectTrusted()` (SDK types).
  const ctx = pi.context({ cwd, isProjectTrusted: () => projectTrusted });
  await pi.emitLifecycle("session_start", {}, ctx);
  await pi.emitEvent("permissions:ready", { sessionId: PI_SESSION.sessionId });
  const agentStart = await pi.emitLifecycle("before_agent_start", { systemPrompt: "Existing Pi prompt." }, ctx);
  return { pi, prompt: agentStart?.systemPrompt ?? "" };
}

function matching(messages, pattern) {
  return messages.filter((message) => pattern.test(message));
}

test("native Engram-only bootstrap keeps provider, pending catalog and no legacy Context7/DevTools error", async (t) => {
  const sandbox = createNativeSandbox(t);
  const sink = {};
  // Premise: the real reader output for a native install. Capture it so the
  // assertions below protect the actual reader contract, not a stub shape.
  const { pi, prompt } = await runNativeBootstrap({
    // `/mcp` and `tool_search` come from the built-in provider; the initial
    // catalog is still pending (tool_search is registered, not active).
    commands: [BUILTIN_MCP_COMMAND],
    tools: [BUILTIN_TOOL_SEARCH],
    activeTools: [],
    sandbox,
    resolutionSink: sink,
  });

  assert.equal(sink.resolution?.state, "managed", "the native reader must resolve managed for this fixture");
  assert.equal(sink.resolution?.transport, "native", "the fixture must exercise the native transport");
  assert.equal(sink.resolution?.context7?.state, "available", "the Context7 channel is available in native");
  assert.equal(
    "context7" in (sink.resolution?.config?.mcpServers ?? {}),
    false,
    "native adds no ephemeral Context7 definition",
  );

  const messages = pi.notifications().map(({ message }) => message);
  // The native branch must not run the legacy Context7/DevTools registration
  // path: a native install never had a Context7 registration to fail.
  assert.deepEqual(
    matching(messages, /Context7|chrome-devtools|DevTools/i),
    [],
    `a healthy native Engram-only install must not report a legacy Context7/DevTools runtime error: ${messages.join(" | ")}`,
  );
  assert.deepEqual(
    matching(messages, /Engram bridge is unavailable/i),
    [],
    "a valid native Engram configuration is not a bridge failure",
  );
  assert.equal(
    pi.emittedEvents().some(({ name }) => name === RUNTIME_REGISTER_EVENT),
    false,
    "the native branch must not emit adapter runtime-register events",
  );
  assert.doesNotMatch(prompt, /jorgex:context7/, "no Context7 guide before the managed ownership contract is closed");
  assert.doesNotMatch(
    prompt,
    /jorgex:chrome-devtools/,
    "no DevTools guide before the managed ownership contract is closed",
  );
  assert.match(prompt, /jorgex:system-prompt/, "the native install still composes the canonical JorgeX policy");
});

test("native bootstrap diagnoses a substituted /mcp provider instead of reporting a healthy native install", async (t) => {
  const sandbox = createNativeSandbox(t);
  // A third-party extension owns `/mcp` (not `builtin:mcp`) and a foreign
  // `tool_search` is registered: the builtin provider is substituted.
  const { pi } = await runNativeBootstrap({
    commands: [
      {
        name: "mcp",
        description: "Show MCP server status",
        source: "extension",
        sourceInfo: { path: "/opt/foreign/mcp-adapter.ts", source: "local", scope: "temporary", origin: "top-level" },
      },
    ],
    tools: [
      {
        ...BUILTIN_TOOL_SEARCH,
        sourceInfo: { path: "/opt/foreign/tool-search.ts", source: "local", scope: "temporary", origin: "top-level" },
      },
    ],
    activeTools: [],
    sandbox,
  });

  const diagnostics = pi.notifications().filter(({ message }) => /mcp|builtin/i.test(message));
  // A replaced builtin must be reported, never presented as a healthy native
  // provider.
  assert.ok(
    diagnostics.length >= 1,
    "a substituted /mcp provider must be diagnosed explicitly instead of being reported as a healthy native install",
  );
  assert.ok(
    diagnostics.some(({ message }) => /builtin/i.test(message)),
    `the diagnostic must name the missing or replaced builtin provider: ${diagnostics.map(({ message }) => message).join(" | ")}`,
  );
});

test("native bootstrap diagnoses an absent builtin:tool-search discovery instead of reading an empty catalog as pending", async (t) => {
  const sandbox = createNativeSandbox(t);
  // The effective /mcp command is the Pi builtin, but the runtime exposes no
  // `tool_search` tool at all: deferred MCP tools can never be loaded, so the
  // bootstrap must diagnose the absent discovery. This is distinct from the
  // normal case above (`tool_search` registered, merely inactive) and from an
  // empty/pending deferred catalog: absence is observed on getAllTools(), the
  // discovery factory, never inferred from the getActiveTools() selection.
  const { pi } = await runNativeBootstrap({
    commands: [BUILTIN_MCP_COMMAND],
    tools: [],
    activeTools: [],
    sandbox,
  });

  const notifications = pi.notifications();
  const diagnostics = notifications.filter(({ message }) => /tool_search|tool-search/i.test(message));
  assert.ok(
    diagnostics.length >= 1,
    `an absent builtin:tool-search discovery must be diagnosed explicitly: ${notifications.map(({ message }) => message).join(" | ") || "no notification at all"}`,
  );
  assert.ok(
    diagnostics.some(({ message }) => /builtin/i.test(message)),
    `the diagnostic must name the missing builtin discovery: ${diagnostics.map(({ message }) => message).join(" | ")}`,
  );
});

test("native bootstrap diagnoses a trusted project override of the protected Engram server", async (t) => {
  const sandbox = createNativeSandbox(t, { projectOverride: true });
  const { entry } = readProjectEngram(sandbox);
  assert.equal(entry.command, PROJECT_OVERRIDE_COMMAND, "the project fixture must define the override");
  assert.ok(existsSync(entry.command), "the override must be a real executable, never a broken command");
  assert.notEqual(entry.command, process.execPath, "the project fixture must really replace the protected Engram server");
  const before = snapshotSandbox(sandbox);

  const { pi, prompt } = await runNativeBootstrap({
    commands: [BUILTIN_MCP_COMMAND],
    tools: [BUILTIN_TOOL_SEARCH],
    activeTools: [],
    sandbox,
    projectDir: sandbox.projectDir,
    projectTrusted: true,
  });

  // Pi reads `<cwd>/.pi/mcp.json` for trusted projects and a project entry
  // replaces the global one with the same name, so `engram` is no longer the
  // server the native reader validated. The bootstrap cannot validate the
  // project entry, so it must diagnose it instead of presenting a valid managed
  // native configuration.
  const notifications = pi.notifications();
  const diagnostics = notifications.filter(({ message }) => /engram/i.test(message) && /project|override/i.test(message));
  assert.ok(
    diagnostics.length >= 1,
    `a trusted project override of the protected Engram server must be diagnosed explicitly: ${notifications.map(({ message }) => message).join(" | ") || "no notification at all"}`,
  );
  // The managed ownership contract is still open: no guide is advertised.
  assert.doesNotMatch(prompt, /jorgex:context7/, "no Context7 guide from project configuration");
  assert.doesNotMatch(prompt, /jorgex:chrome-devtools/, "no DevTools guide from project configuration");
  // Diagnosis only: no configuration, backup or trust state is written.
  assert.deepEqual(snapshotSandbox(sandbox), before, "the native branch must not write configuration or trust state");
});

test("an untrusted project Engram override is ignored and the global native install stays healthy", async (t) => {
  const sandbox = createNativeSandbox(t, { projectOverride: true });
  const sink = {};
  const { entry } = readProjectEngram(sandbox);
  assert.equal(entry.command, PROJECT_OVERRIDE_COMMAND, "the project fixture must define the override");
  assert.notEqual(entry.command, process.execPath, "the project fixture must really replace the protected Engram server");
  const before = snapshotSandbox(sandbox);

  const { pi } = await runNativeBootstrap({
    commands: [BUILTIN_MCP_COMMAND],
    tools: [BUILTIN_TOOL_SEARCH],
    activeTools: [],
    sandbox,
    resolutionSink: sink,
    projectDir: sandbox.projectDir,
    projectTrusted: false,
  });

  // Pi never reads `<cwd>/.pi/mcp.json` for untrusted projects, so the global
  // validated entry stays effective and the untrusted file is never claimed as
  // an effective override: no diagnostic and no legacy error either.
  assert.deepEqual(pi.notifications(), [], "an untrusted project override must neither be applied nor reported");
  assert.equal(sink.resolution?.state, "managed", "the global native configuration stays effective");
  assert.deepEqual(snapshotSandbox(sandbox), before, "the untrusted override must not be rewritten, normalized or backed up");
});

// --- Guide policy: an owned guide only when the checker reports
// managed/configured plus an observed catalog. --------------------------------
test("native bootstrap guides Context7 only from managed ownership plus observed catalog", async (t) => {
  await t.test("a managed/configured Context7 with an observed catalog exposes the owned guide", async (sub) => {
    const sandbox = createGuideSandbox(sub);
    const before = snapshotSandbox(sandbox);
    const { pi, prompt, resolved, inspectorCalls } = await runNativeGuideBootstrap({
      sandbox,
      inspector: ownershipDto({ context7State: "managed" }),
      // Builtin provider and discovery are demonstrated; the host is past the
      // catalog, so tool_search is active and the deferred Context7 tool is
      // registered but still inactive for the user.
      commands: [BUILTIN_MCP_COMMAND],
      tools: [BUILTIN_TOOL_SEARCH, DEFERRED_CONTEXT7_TOOL],
      activeTools: ["tool_search"],
    });

    assert.equal(resolved?.state, "managed", "the real reader must resolve this native install as managed");
    assert.equal(resolved?.transport, "native", "the fixture must exercise the native transport");
    assert.equal(
      prompt.includes("jorgex:context7"),
      true,
      "a managed Context7 server with an observed namespace catalog must expose the owned guide",
    );
    assert.equal(
      inspectorCalls.length > 0,
      true,
      "the injected ownership checker must be consulted for native sessions",
    );
    assert.equal(inspectorCalls[0]?.cwd, sandbox.root, "the checker receives the real ctx.cwd");
    assert.equal(inspectorCalls[0]?.projectTrusted, false, "project trust comes from ctx.isProjectTrusted(), never forced true");

    assert.equal(
      pi.emittedEvents().some(({ name }) => name === RUNTIME_REGISTER_EVENT),
      false,
      "the native branch never emits adapter runtime-register events",
    );
    assert.deepEqual(
      pi.activeToolSelections(),
      [],
      "registered-but-inactive discovery must not be activated and preferences are never re-imposed",
    );
    assert.deepEqual(snapshotSandbox(sandbox), before, "the bootstrap must not write configuration or trust state");
  });

  await t.test("the same configuration stays unguided while ownership is unowned", async (sub) => {
    const sandbox = createGuideSandbox(sub);
    const before = snapshotSandbox(sandbox);
    const { pi, prompt } = await runNativeGuideBootstrap({
      sandbox,
      inspector: ownershipDto({ context7State: "unowned" }),
      commands: [BUILTIN_MCP_COMMAND],
      tools: [BUILTIN_TOOL_SEARCH, DEFERRED_CONTEXT7_TOOL],
      activeTools: ["tool_search"],
    });

    assert.equal(
      prompt.includes("jorgex:context7"),
      false,
      "an unowned server keeps the guide absent even with the same url/config shape and an observed catalog",
    );
    assert.equal(
      pi.emittedEvents().some(({ name }) => name === RUNTIME_REGISTER_EVENT),
      false,
      "a suppressed guide never falls back to adapter registration",
    );
    assert.deepEqual(pi.activeToolSelections(), [], "no tool activation without ownership");
    assert.deepEqual(snapshotSandbox(sandbox), before, "the bootstrap must not write configuration or trust state");
  });

  await t.test("a pending namespace catalog keeps the guide absent even when ownership is managed", async (sub) => {
    const sandbox = createGuideSandbox(sub);
    const { pi, prompt } = await runNativeGuideBootstrap({
      sandbox,
      inspector: ownershipDto({ context7State: "managed" }),
      commands: [BUILTIN_MCP_COMMAND],
      // tool_search is registered but the Context7 namespace has not been
      // observed yet: the catalog is pending, not a connection failure.
      tools: [BUILTIN_TOOL_SEARCH],
      activeTools: ["tool_search"],
    });

    assert.equal(
      prompt.includes("jorgex:context7"),
      false,
      "a pending namespace catalog keeps the guide absent: registered or observed is not the same as catalogued",
    );
    assert.equal(
      pi.emittedEvents().some(({ name }) => name === RUNTIME_REGISTER_EVENT),
      false,
      "a pending catalog never falls back to adapter registration",
    );
    assert.deepEqual(pi.activeToolSelections(), [], "a pending catalog never activates deferred tools");
  });

  await t.test("a foreign tool reusing the namespace name never satisfies the catalog", async (sub) => {
    const sandbox = createGuideSandbox(sub);
    const { pi, prompt } = await runNativeGuideBootstrap({
      sandbox,
      inspector: ownershipDto({ context7State: "managed" }),
      commands: [BUILTIN_MCP_COMMAND],
      // The Context7 name is present but the tool is not provided by the
      // `builtin:mcp` factory: the logical prefix is not authority.
      tools: [BUILTIN_TOOL_SEARCH, FOREIGN_CONTEXT7_TOOL],
      activeTools: ["tool_search"],
    });

    assert.equal(
      prompt.includes("jorgex:context7"),
      false,
      "the namespace prefix alone must never satisfy the observed-catalog requirement",
    );
    assert.equal(
      pi.emittedEvents().some(({ name }) => name === RUNTIME_REGISTER_EVENT),
      false,
      "a foreign catalog entry never falls back to adapter registration",
    );
    assert.deepEqual(pi.activeToolSelections(), [], "a foreign catalog entry never activates tools");
  });

  await t.test("a later inspection that loses ownership withdraws the guide without a stale snapshot", async (sub) => {
    const sandbox = createGuideSandbox(sub);
    let context7State = "managed";
    const { prompts } = await runNativeGuideBootstrap({
      sandbox,
      // Fresh DTO per inspection, changed between agent starts exactly as an
      // external install would change the inspected world.
      inspector: () => ownershipDto({ context7State }),
      beforeAgentStart: (index) => {
        context7State = index === 0 ? "managed" : "unowned";
      },
      commands: [BUILTIN_MCP_COMMAND],
      tools: [BUILTIN_TOOL_SEARCH, DEFERRED_CONTEXT7_TOOL],
      activeTools: ["tool_search"],
      agentStarts: 2,
    });

    assert.equal(prompts.length, 2, "the fixture must run two agent starts to exercise the fresh re-read");
    assert.equal(
      prompts[0].includes("jorgex:context7"),
      true,
      "the first inspection owns the guide while ownership is managed",
    );
    assert.equal(
      prompts[1].includes("jorgex:context7"),
      false,
      "losing ownership between hooks must withdraw the guide: the prompt is recomposed from a fresh inspection",
    );
  });
});

// Chrome DevTools vertical: the same guide policy applied to the second native
// server. The guard chain itself (handoff stamp plus trusted v3 resolution) is
// proven by tests/mcp-native-authority; here only the public prompt policy is
// exercised through the abstracted DTO.
test("native bootstrap guides Chrome DevTools only from managed ownership plus observed catalog", async (t) => {
  await t.test("a managed/configured Chrome DevTools with an observed catalog exposes its guide", async (sub) => {
    const sandbox = createGuideSandbox(sub);
    const before = snapshotSandbox(sandbox);
    const { pi, prompt, resolved, inspectorCalls } = await runNativeGuideBootstrap({
      sandbox,
      inspector: ownershipDto({ context7State: "managed", devtoolsState: "managed" }),
      commands: [BUILTIN_MCP_COMMAND],
      tools: [BUILTIN_TOOL_SEARCH, DEFERRED_DEVTOOLS_TOOL],
      activeTools: ["tool_search"],
    });

    assert.equal(resolved?.state, "managed", "the real reader must resolve this native install as managed");
    assert.equal(resolved?.transport, "native", "the fixture must exercise the native transport");
    assert.equal(
      prompt.includes("jorgex:chrome-devtools"),
      true,
      "a managed Chrome DevTools server with an observed namespace catalog must expose the owned guide",
    );
    assert.equal(inspectorCalls.length > 0, true, "the checker must be consulted for the native session");
    assert.equal(inspectorCalls[0]?.cwd, sandbox.root, "the checker receives the real ctx.cwd");
    assert.equal(inspectorCalls[0]?.projectTrusted, false, "project trust comes from ctx.isProjectTrusted(), never forced true");
    assert.equal(
      pi.emittedEvents().some(({ name }) => name === RUNTIME_REGISTER_EVENT),
      false,
      "no adapter registration event is ever emitted for a native guide",
    );
    assert.deepEqual(pi.activeToolSelections(), [], "discovery is observed, never activated");
    assert.deepEqual(snapshotSandbox(sandbox), before, "the bootstrap must not write configuration or trust state");
  });

  await t.test("the same catalog stays unguided while Chrome DevTools is unowned", async (sub) => {
    const sandbox = createGuideSandbox(sub);
    const before = snapshotSandbox(sandbox);
    const { pi, prompt } = await runNativeGuideBootstrap({
      sandbox,
      inspector: ownershipDto({ context7State: "managed", devtoolsState: "unowned" }),
      commands: [BUILTIN_MCP_COMMAND],
      tools: [BUILTIN_TOOL_SEARCH, DEFERRED_DEVTOOLS_TOOL],
      activeTools: ["tool_search"],
    });

    assert.equal(
      prompt.includes("jorgex:chrome-devtools"),
      false,
      "an unowned Chrome DevTools keeps the guide absent even with the catalog observed",
    );
    assert.equal(pi.emittedEvents().some(({ name }) => name === RUNTIME_REGISTER_EVENT), false);
    assert.deepEqual(pi.activeToolSelections(), [], "no tool activation without ownership");
    assert.deepEqual(snapshotSandbox(sandbox), before, "the bootstrap must not write configuration or trust state");
  });

  await t.test("the same catalog stays unguided while Chrome DevTools is conflict", async (sub) => {
    const sandbox = createGuideSandbox(sub);
    const { pi, prompt } = await runNativeGuideBootstrap({
      sandbox,
      inspector: ownershipDto({ context7State: "managed", devtoolsState: "conflict" }),
      commands: [BUILTIN_MCP_COMMAND],
      tools: [BUILTIN_TOOL_SEARCH, DEFERRED_DEVTOOLS_TOOL],
      activeTools: ["tool_search"],
    });

    assert.equal(
      prompt.includes("jorgex:chrome-devtools"),
      false,
      "a conflicting Chrome DevTools never satisfies the guide policy",
    );
    assert.equal(pi.emittedEvents().some(({ name }) => name === RUNTIME_REGISTER_EVENT), false);
    assert.deepEqual(pi.activeToolSelections(), [], "no tool activation from a conflict");
  });

  await t.test("losing DevTools ownership between hooks withdraws its guide", async (sub) => {
    const sandbox = createGuideSandbox(sub);
    let devtoolsState = "managed";
    const { pi, prompts } = await runNativeGuideBootstrap({
      sandbox,
      // Fresh DTO per inspection: managed on the first start, disabled after.
      inspector: () => ownershipDto({ context7State: "managed", devtoolsState }),
      beforeAgentStart: (index) => {
        devtoolsState = index === 0 ? "managed" : "disabled";
      },
      commands: [BUILTIN_MCP_COMMAND],
      tools: [BUILTIN_TOOL_SEARCH, DEFERRED_DEVTOOLS_TOOL],
      activeTools: ["tool_search"],
      agentStarts: 2,
    });

    assert.equal(prompts.length, 2, "the fixture must run two agent starts to exercise the fresh re-read");
    assert.equal(
      prompts[0].includes("jorgex:chrome-devtools"),
      true,
      "the first inspection owns the DevTools guide while the server is managed",
    );
    assert.equal(
      prompts[1].includes("jorgex:chrome-devtools"),
      false,
      "a disabled or unowned DevTools between hooks must withdraw the guide, never keep a stale section",
    );
    assert.equal(
      pi.emittedEvents().some(({ name }) => name === RUNTIME_REGISTER_EVENT),
      false,
      "withdrawing a guide never falls back to adapter registration",
    );
    assert.deepEqual(pi.activeToolSelections(), [], "discovery is observed, never activated");
  });
});

// Truthful-diagnostic helper: a guide that is actually present in the composed
// prompt must never be labelled unavailable by the ownership notice. The check
// stays wording-agnostic (no prose snapshot): it only rejects pairing a healthy
// guide's name with an unavailability claim in the same sentence.
function claimsGuideUnavailable(message, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${escaped}[^.;!?]*unavailable|unavailable[^.;!?]*${escaped}`, "i").test(message);
}

// Authority-diagnostic vertical: the bootstrap must surface a RETURNED conflict
// DTO, not only a thrown inspector. Spec 71 L51: it notifies `package.state:
// conflict` and managed-server conflicts through the existing channel with a
// fixed diagnostic/remedy; guides suppressed by broken authority are
// distinguished from a pending catalog or a legitimate unowned server, and the
// notice never blocks the builtin or a foreign MCP.
test("native bootstrap diagnoses a returned ownership conflict instead of swallowing it", async (t) => {
  await t.test("a returned package conflict produces one generic authority diagnostic and no guide", async (sub) => {
    const sandbox = createGuideSandbox(sub);
    const before = snapshotSandbox(sandbox);
    const { pi, prompt } = await runNativeGuideBootstrap({
      sandbox,
      inspector: ownershipDto({
        context7State: "conflict",
        devtoolsState: "conflict",
        packageState: "conflict",
        // Fixed placeholder: a negative case must never carry a real error.
        packageReason: "fixture package conflict",
      }),
      commands: [BUILTIN_MCP_COMMAND],
      tools: [BUILTIN_TOOL_SEARCH, DEFERRED_CONTEXT7_TOOL, DEFERRED_DEVTOOLS_TOOL],
      activeTools: ["tool_search"],
    });

    // Exactly one notice across session_start + before_agent_start: the same
    // returned conflict must not be reported twice for one session.
    assert.equal(
      pi.notifications().length,
      1,
      "a returned package conflict must notify once per session through the existing channel, not be swallowed",
    );
    const [notification] = pi.notifications();
    assert.match(notification.message, /(ownership|authority)/i, "the diagnostic names the broken ownership/authority");
    assert.match(notification.message, /(preserve|reload)/i, "the diagnostic carries a fixed preserve/reload remedy");
    assert.equal(notification.message.includes(sandbox.root), false, "the diagnostic must never echo a private path");
    assert.equal(/[{}]/.test(notification.message), false, "the diagnostic must never echo raw JSON");
    assert.equal(/[0-9a-f]{64}/.test(notification.message), false, "the diagnostic must never echo a guard hash");
    assert.equal(/\b(connected|connection)\b/i.test(notification.message), false, "the diagnostic is not a connectivity claim");
    assert.equal(prompt.includes("jorgex:context7"), false, "a broken package authority keeps the Context7 guide absent");
    assert.equal(prompt.includes("jorgex:chrome-devtools"), false, "a broken package authority keeps the DevTools guide absent");
    assert.deepEqual(snapshotSandbox(sandbox), before, "the bootstrap must not write configuration or trust state");
  });

  await t.test("a managed-server conflict with a verified package is diagnosed once and unguided", async (sub) => {
    const sandbox = createGuideSandbox(sub);
    const before = snapshotSandbox(sandbox);
    const { pi, prompt } = await runNativeGuideBootstrap({
      sandbox,
      // Package proof verified; the conflict is the managed Context7 server, and
      // the namespace catalog IS observed so the absence cannot be blamed on a
      // pending catalog.
      inspector: ownershipDto({ context7State: "conflict" }),
      commands: [BUILTIN_MCP_COMMAND],
      tools: [BUILTIN_TOOL_SEARCH, DEFERRED_CONTEXT7_TOOL],
      activeTools: ["tool_search"],
    });

    assert.equal(
      pi.notifications().length,
      1,
      "a conflict of a managed server must notify once per session even when the package proof is verified",
    );
    const [notification] = pi.notifications();
    assert.match(notification.message, /(ownership|authority)/i, "the diagnostic names the broken ownership/authority");
    assert.match(notification.message, /(preserve|reload)/i, "the diagnostic carries a fixed preserve/reload remedy");
    assert.equal(notification.message.includes(sandbox.root), false, "the diagnostic must never echo a private path");
    assert.equal(prompt.includes("jorgex:context7"), false, "a conflicting Context7 server keeps its guide absent");
    assert.equal(prompt.includes("jorgex:chrome-devtools"), false, "an absent DevTools keeps its guide absent");
    assert.deepEqual(snapshotSandbox(sandbox), before, "the bootstrap must not write configuration or trust state");
  });

  await t.test("a legitimate unowned or pending state stays silent and unguided", async (sub) => {
    const sandbox = createGuideSandbox(sub);
    const before = snapshotSandbox(sandbox);
    const { pi, prompt } = await runNativeGuideBootstrap({
      sandbox,
      // Legitimate absence, never broken authority: unowned server plus a
      // registered-but-inactive tool_search with the Context7 catalog pending.
      inspector: ownershipDto({ context7State: "unowned", devtoolsState: "absent" }),
      commands: [BUILTIN_MCP_COMMAND],
      tools: [BUILTIN_TOOL_SEARCH],
      activeTools: ["tool_search"],
    });

    assert.deepEqual(pi.notifications(), [], "a legitimate unowned/pending state must not raise an authority warning");
    assert.equal(prompt.includes("jorgex:context7"), false, "an unowned server keeps the guide absent");
    assert.equal(prompt.includes("jorgex:chrome-devtools"), false, "an absent DevTools keeps the guide absent");
    assert.deepEqual(snapshotSandbox(sandbox), before, "the bootstrap must not write configuration or trust state");
  });

  await t.test("a mixed state keeps the healthy guide and never claims it unavailable", async (sub) => {
    const sandbox = createGuideSandbox(sub);
    const before = snapshotSandbox(sandbox);
    const { pi, prompt } = await runNativeGuideBootstrap({
      sandbox,
      // Package verified and Context7 fully managed with its builtin namespace
      // catalog observed: the Context7 guide is genuinely available. Only Chrome
      // DevTools conflicts, so the shared notice must stay truthful about which
      // guides are affected instead of asserting both are unavailable.
      inspector: ownershipDto({ context7State: "managed", devtoolsState: "conflict" }),
      commands: [BUILTIN_MCP_COMMAND],
      tools: [BUILTIN_TOOL_SEARCH, DEFERRED_CONTEXT7_TOOL],
      activeTools: ["tool_search"],
    });

    assert.equal(
      prompt.includes("jorgex:context7"),
      true,
      "a managed/configured Context7 with an observed catalog keeps its guide in a mixed state",
    );
    assert.equal(
      prompt.includes("jorgex:chrome-devtools"),
      false,
      "the conflicting Chrome DevTools guide stays absent",
    );
    assert.equal(
      pi.notifications().length,
      1,
      "the single conflicting server must still raise one per-session authority notice",
    );
    const [notification] = pi.notifications();
    assert.match(notification.message, /(ownership|authority)/i, "the diagnostic names the broken ownership/authority");
    assert.match(notification.message, /(preserve|reload)/i, "the diagnostic carries a fixed preserve/reload remedy");
    // Wording-agnostic contract: a truthful message may name only the affected
    // server or stay generic ("affected managed native MCP guides"); the hard
    // rule is that it never labels the healthy Context7 guide as unavailable,
    // because the composed prompt proves that guide is present.
    assert.equal(
      claimsGuideUnavailable(notification.message, "context7"),
      false,
      `the diagnostic must not claim the healthy Context7 guide is unavailable: ${notification.message}`,
    );
    assert.deepEqual(snapshotSandbox(sandbox), before, "the bootstrap must not write configuration or trust state");
  });
});
