import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(testDir, "..");

test("snapshot publication rolls back every owned root and preserves the original failure", async () => {
  const { commitSnapshot } = await import("../scripts/snapshot-transaction.mjs");
  assert.equal(typeof commitSnapshot, "function", "snapshot transaction seam must export commitSnapshot");

  const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-snapshot-transaction-"));
  const packageRoot = join(sandbox, "package");
  const stage = join(sandbox, "stage");
  const previous = {
    "snapshot/agents/original.md": "original agent\n",
    "skills/original/SKILL.md": "original skill\n",
    "contract/parity.v1.json": "{\"generation\":\"original\"}\n",
  };
  const replacement = {
    "snapshot/agents/replacement.md": "replacement agent\n",
    "skills/replacement/SKILL.md": "replacement skill\n",
    "contract/parity.v1.json": "{\"generation\":\"replacement\"}\n",
  };
  writeTree(packageRoot, previous);
  writeTree(stage, replacement);
  const before = readTree(packageRoot);
  const injected = new Error("injected snapshot publish failure");
  let failedOnce = false;

  try {
    let caught;
    try {
      await commitSnapshot({
        root: packageRoot,
        stage,
        move(source, target) {
          if (!failedOnce && target === join(packageRoot, "skills")) {
            failedOnce = true;
            throw injected;
          }
          renameSync(source, target);
        },
      });
    } catch (error) {
      caught = error;
    }

    assert.equal(failedOnce, true, "the test must reach a mid-publication failure after snapshot is considered");
    assert.ok(caught, "the transaction must reject when publication fails");
    assert.ok(errorChain(caught).includes(injected), "the injected publication error must remain observable as the error or its cause");
    assert.deepEqual(readTree(packageRoot), before, "a failed publication must preserve every prior snapshot, skill, and parity byte");
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
