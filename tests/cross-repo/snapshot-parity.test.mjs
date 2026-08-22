import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(testDir, "..", "..");
const expected = JSON.parse(readFileSync(join(root, "tests", "fixtures", "snapshot-parity.expected.json"), "utf8"));

test("the generated parity hashes match the pinned Stack commit", () => {
  const stackDir = process.env.JORGEX_STACK_DIR;
  assert.ok(stackDir, "set JORGEX_STACK_DIR to run this explicit cross-repo check");
  execFileSync("git", ["-C", stackDir, "cat-file", "-e", `${expected.sourceCommit}^{commit}`], { stdio: "pipe" });
  const parity = JSON.parse(readFileSync(join(root, expected.parityPath), "utf8"));
  assert.deepEqual(parity.source, { repository: expected.sourceRepository, commit: expected.sourceCommit });
  for (const agent of parity.agents) {
    assert.equal(agent.sourceSha256, hashGitBlob(stackDir, agent.sourcePath), `${agent.sourcePath} hash must match pinned Stack`);
  }
  for (const skill of parity.skills) {
    for (const file of skill.files) {
      const sourcePath = `${skill.sourcePath}/${file.path}`;
      assert.equal(file.sha256, hashGitBlob(stackDir, sourcePath), `${sourcePath} hash must match pinned Stack`);
    }
  }
});

function hashGitBlob(stackDir, sourcePath) {
  const bytes = execFileSync("git", ["-C", stackDir, "show", `${expected.sourceCommit}:${sourcePath}`]);
  return createHash("sha256").update(bytes).digest("hex");
}
