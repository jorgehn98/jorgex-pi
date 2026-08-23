import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, ExtensionRunner } from "@earendil-works/pi-coding-agent";

const testDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(testDir, "..");

test("Pi 0.84.2 loads the package bootstrap before binding runtime actions and its guard starts fail-closed", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-loader-"));
  try {
    const loader = new DefaultResourceLoader({
      cwd: sandbox,
      agentDir: join(sandbox, "agent"),
      additionalExtensionPaths: [root],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });

    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, [], "the package bootstrap must not call runtime actions during Pi extension loading");
    assert.equal(loaded.extensions.length, 1, "the root package manifest must load exactly one bootstrap extension");

    let activeTools = [];
    const runner = new ExtensionRunner(
      loaded.extensions,
      loaded.runtime,
      sandbox,
      { getSessionId: () => "loader-session" },
      {},
    );
    runner.bindCore(
      {
        sendMessage() {},
        sendUserMessage() {},
        appendEntry() {},
        setSessionName() {},
        getSessionName: () => undefined,
        setLabel() {},
        getActiveTools: () => [...activeTools],
        getAllTools: () => [],
        setActiveTools: (names) => { activeTools = [...names]; },
        refreshTools() {},
        getCommands: () => [],
        setModel: async () => false,
        getThinkingLevel: () => undefined,
        setThinkingLevel() {},
      },
      {
        getModel: () => undefined,
        getScopedModels: () => [],
        isIdle: () => true,
        isProjectTrusted: () => true,
        getSignal: () => undefined,
        abort() {},
        hasPendingMessages: () => false,
        shutdown() {},
        getContextUsage: () => undefined,
        compact() {},
        getSystemPrompt: () => "",
      },
    );

    const result = await runner.emitToolCall({
      type: "tool_call",
      toolName: "bash",
      toolCallId: "pre-health",
      input: { command: "echo must-not-run" },
    });
    assert.equal(result?.block, true, "the real Pi runner must see the JorgeX guard before session health");
    assert.equal(result?.terminate, true, "the pre-health guard must terminate the blocked tool batch");
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});
