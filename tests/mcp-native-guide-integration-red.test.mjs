// T70 bootstrap native guide integration (Spec 71 L35).
//
// The readonly ownership checker is integrated into the native bootstrap hooks
// through an OWN test injection seam (`inspectNativeMcpOwnership`, same pattern
// as the existing injected resolvers; never an upstream API and never a
// packageRoot parameter). The Context7 guide must appear only when the checker
// reports that server managed/configured AND the builtin provider/discovery is
// demonstrated AND the public Context7 namespace catalog has been observed.
//
// The persistent Context7 definition is identical in every case, so a
// suppressed guide can never be explained by configuration shape. No adapter
// events, no ephemeral MCP registration, no tool activation, no connection claim
// and no real HOME.
import assert from "node:assert/strict";
import test from "node:test";
import { RUNTIME_REGISTER_EVENT } from "../extensions/mcp-engram.mjs";
import {
  BUILTIN_MCP_COMMAND,
  BUILTIN_TOOL_SEARCH,
  createGuideSandbox,
  DEFERRED_CONTEXT7_TOOL,
  DEFERRED_DEVTOOLS_TOOL,
  FOREIGN_CONTEXT7_TOOL,
  ownershipDto,
  runNativeGuideBootstrap,
  snapshotSandbox,
} from "./fixtures/native-guide-bootstrap.mjs";

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
// already proven by tests/mcp-native-devtools-ownership-red; here only the
// public prompt policy is exercised through the abstracted DTO.
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
