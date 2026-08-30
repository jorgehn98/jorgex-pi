import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(testDir, "..");

test("snapshot parity v1-to-v2 migration rolls back every owned root and retains v1 when capability schema publication fails", async () => {
  const { commitSnapshot } = await import("../scripts/snapshot-transaction.mjs");
  assert.equal(typeof commitSnapshot, "function", "snapshot transaction seam must export commitSnapshot");

  const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-snapshot-transaction-"));
  const packageRoot = join(sandbox, "package");
  const stage = join(sandbox, "stage");
  const previous = {
    "snapshot/agents/original.md": "original agent\n",
    "skills/original/SKILL.md": "original skill\n",
    "contract/parity.v1.json": "{\"schemaVersion\":1,\"generation\":\"original\"}\n",
    "contract/schemas/quality-capabilities.v1.schema.json": "original quality capabilities schema\n",
  };
  const replacement = {
    "snapshot/agents/replacement.md": "replacement agent\n",
    "skills/replacement/SKILL.md": "replacement skill\n",
    "assets/system-prompt/AGENTS.md": "replacement policy\n",
    "assets/system-prompt/engram-protocol.md": "replacement protocol\n",
    "prompts/lean-audit.md": "replacement prompt\n",
    "contract/parity.v2.json": "{\"schemaVersion\":2,\"generation\":\"replacement\"}\n",
    "contract/schemas/quality-capabilities.v1.schema.json": "replacement quality capabilities schema\n",
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
          if (!failedOnce && target === join(packageRoot, "contract", "schemas", "quality-capabilities.v1.schema.json")) {
            failedOnce = true;
            throw injected;
          }
          renameSync(source, target);
        },
      });
    } catch (error) {
      caught = error;
    }

    assert.equal(failedOnce, true, "the test must reach a mid-v2-publication failure while publishing the quality capabilities schema");
    assert.ok(caught, "the transaction must reject when publication fails");
    assert.ok(errorChain(caught).includes(injected), "the injected publication error must remain observable as the error or its cause");
    assert.deepEqual(readTree(packageRoot), before, "a failed v1-to-v2 migration must restore every prior byte, including parity v1 and the prior quality capabilities schema");
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("snapshot parity v1-to-v2 migration publishes every v2 root and removes the legacy v1 contract", async () => {
  const { commitSnapshot } = await import("../scripts/snapshot-transaction.mjs");
  const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-snapshot-transaction-success-"));
  const packageRoot = join(sandbox, "package");
  const stage = join(sandbox, "stage");
  const previous = {
    "snapshot/agents/original.md": "original agent\n",
    "skills/original/SKILL.md": "original skill\n",
    "contract/parity.v1.json": "{\"schemaVersion\":1,\"generation\":\"original\"}\n",
    "contract/schemas/quality-capabilities.v1.schema.json": "original quality capabilities schema\n",
  };
  const replacement = {
    "snapshot/agents/replacement.md": "replacement agent\n",
    "skills/replacement/SKILL.md": "replacement skill\n",
    "assets/system-prompt/AGENTS.md": "replacement policy\n",
    "assets/system-prompt/engram-protocol.md": "replacement protocol\n",
    "prompts/lean-audit.md": "replacement prompt\n",
    "contract/parity.v2.json": "{\"schemaVersion\":2,\"generation\":\"replacement\"}\n",
    "contract/schemas/quality-capabilities.v1.schema.json": "replacement quality capabilities schema\n",
  };
  writeTree(packageRoot, previous);
  writeTree(stage, replacement);

  try {
    await commitSnapshot({ root: packageRoot, stage });
    const expectedTree = Object.fromEntries(Object.entries(replacement).map(([path, bytes]) => [path, Buffer.from(bytes)]));
    assert.deepEqual(readTree(packageRoot), expectedTree, "a successful migration must publish every staged v2 root and remove parity.v1.json");
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
