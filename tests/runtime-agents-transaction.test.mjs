import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";

test("runtime agent publication rolls back every owned destination and preserves the original failure", async () => {
  const { commitRuntimeAgents } = await import("../scripts/runtime-agents-transaction.mjs");
  assert.equal(typeof commitRuntimeAgents, "function", "runtime agent transaction seam must export commitRuntimeAgents");

  const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-runtime-agents-transaction-"));
  const packageRoot = join(sandbox, "package");
  const stage = join(sandbox, "stage");
  const previous = {
    "agents/original.md": "original runnable agent\n",
    "deferred/agents/engram.md": "original deferred agent\n",
    "primary/orchestrator.md": "original primary agent\n",
    "contract/runtime-agents.v1.json": "{\"generation\":\"original\"}\n",
  };
  const replacement = {
    "agents/replacement.md": "replacement runnable agent\n",
    "deferred/agents/engram.md": "replacement deferred agent\n",
    "primary/orchestrator.md": "replacement primary agent\n",
    "contract/runtime-agents.v1.json": "{\"generation\":\"replacement\"}\n",
  };
  writeTree(packageRoot, previous);
  writeTree(stage, replacement);
  const before = readTree(packageRoot);
  const injected = new Error("injected runtime agent publish failure");
  let failedOnce = false;

  try {
    let caught;
    try {
      await commitRuntimeAgents({
        root: packageRoot,
        stage,
        move(source, target) {
          if (!failedOnce && source === join(stage, "primary") && target === join(packageRoot, "primary")) {
            failedOnce = true;
            throw injected;
          }
          renameSync(source, target);
        },
      });
    } catch (error) {
      caught = error;
    }

    assert.equal(failedOnce, true, "the test must fail after runnable and deferred agents were partially published");
    assert.ok(caught, "the transaction must reject when publication fails");
    assert.ok(errorChain(caught).includes(injected), "the injected publication error must remain observable as the error or its cause");
    assert.deepEqual(readTree(packageRoot), before, "failed publication must restore every prior runtime agent and contract byte-for-byte");
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

function writeTree(base, files) {
  for (const [path, bytes] of Object.entries(files)) {
    const target = join(base, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
}

function readTree(base) {
  const result = {};
  const visit = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (lstatSync(path).isDirectory()) visit(path);
      else result[relative(base, path).replaceAll("\\", "/")] = readFileSync(path);
    }
  };
  visit(base);
  return result;
}

function errorChain(error) {
  const chain = [];
  for (let current = error; current && !chain.includes(current); current = current.cause) chain.push(current);
  return chain;
}
