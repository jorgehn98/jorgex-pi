import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(testDir, "..", "..");
const expected = JSON.parse(readFileSync(join(root, "tests", "fixtures", "snapshot-parity.expected.json"), "utf8"));

test("generated outputs match raw pinned objects with the documented byte policy", () => {
  const stackDir = requireStackDir();
  execFileSync("git", ["-C", stackDir, "cat-file", "-e", `${expected.sourceCommit}^{commit}`], { stdio: "pipe" });
  const parity = JSON.parse(readFileSync(join(root, expected.parityPath), "utf8"));
  const modes = rawSourceModes(stackDir);
  assert.deepEqual(parity.source, { repository: expected.sourceRepository, commit: expected.sourceCommit });

  for (const agent of parity.agents) {
    const source = rawGitBlob(stackDir, agent.sourcePath);
    const normalized = normalizeLf(source);
    assert.equal(modes.get(agent.sourcePath), "100644", `${agent.sourcePath} must be a regular non-executable source file`);
    assert.equal(agent.sourceSha256, sha256(source), `${agent.sourcePath} source hash must match the raw pinned object`);
    assert.equal(agent.outputSha256, sha256(normalized), `${agent.targetPath} output hash must describe LF-normalized source`);
    assert.deepEqual(readFileSync(join(root, agent.targetPath)), normalized, `${agent.targetPath} must equal LF-normalized pinned source`);
  }

  for (const skill of parity.skills) {
    for (const file of skill.files) {
      const sourcePath = `${skill.sourcePath}/${file.path}`;
      const source = rawGitBlob(stackDir, sourcePath);
      assert.equal(modes.get(sourcePath), "100644", `${sourcePath} must be a regular non-executable source file`);
      assert.equal(file.sha256, sha256(source), `${sourcePath} hash must match the raw pinned object`);
      assert.deepEqual(readFileSync(join(root, skill.targetPath, file.path)), source, `${skill.targetPath}/${file.path} must remain byte-exact`);
    }
  }
});

test("the real generator is deterministic in isolated package copies", () => {
  const stackDir = requireStackDir();
  const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-generator-determinism-"));
  try {
    const first = createPackageCopy(join(sandbox, "first"));
    const second = createPackageCopy(join(sandbox, "second"));
    runGenerator(first, stackDir);
    runGenerator(second, stackDir);
    const expectedTree = generatedTree(root);
    assert.deepEqual(generatedTree(first), expectedTree, "executed generator output must equal the committed package snapshot");
    assert.deepEqual(generatedTree(second), expectedTree, "a second isolated execution must produce identical bytes");
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("replacement refs cannot redirect generation away from raw pinned objects", () => {
  const stackDir = requireStackDir();
  const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-replace-ref-"));
  const replacementStack = join(sandbox, "stack");
  const packageRoot = createPackageCopy(join(sandbox, "package"));
  const realReplaceRefsBefore = replaceRefs(stackDir);
  try {
    execFileSync("git", ["clone", "--shared", "--no-checkout", stackDir, replacementStack], { stdio: "pipe" });
    const replacementCommit = findDifferentAssetCommit(replacementStack);
    assert.ok(replacementCommit, "Stack history must provide a different reviewed asset commit for the replace-ref regression");
    execFileSync("git", ["-C", replacementStack, "replace", expected.sourceCommit, replacementCommit], { stdio: "pipe" });
    assert.notEqual(replaceRefs(replacementStack), "", "the isolated clone must contain the adversarial replacement ref");

    runGenerator(packageRoot, replacementStack);
    assert.deepEqual(generatedTree(packageRoot), generatedTree(root), "generation must read the pinned commit's raw objects, ignoring replacement refs");
  } finally {
    assert.equal(replaceRefs(stackDir), realReplaceRefsBefore, "the regression test must never modify replacement refs in the real Stack checkout");
    rmSync(sandbox, { recursive: true, force: true });
  }
});

function requireStackDir() {
  const stackDir = process.env.JORGEX_STACK_DIR;
  assert.ok(stackDir && resolve(stackDir) === stackDir, "set JORGEX_STACK_DIR to an absolute Stack checkout for this explicit cross-repo check");
  return stackDir;
}

function createPackageCopy(target) {
  mkdirSync(join(target, "scripts"), { recursive: true });
  for (const script of ["generate-snapshot.mjs", "snapshot-transaction.mjs"]) {
    cpSync(join(root, "scripts", script), join(target, "scripts", script));
  }
  return target;
}

function runGenerator(packageRoot, stackDir) {
  execFileSync(process.execPath, [join(packageRoot, "scripts", "generate-snapshot.mjs")], {
    env: { ...process.env, JORGEX_STACK_DIR: stackDir },
    stdio: "pipe",
  });
}

function generatedTree(packageRoot) {
  const files = [
    ...listFiles(join(packageRoot, "snapshot")),
    ...listFiles(join(packageRoot, "skills")),
    join(packageRoot, "contract", "parity.v1.json"),
  ];
  return Object.fromEntries(
    files
      .map((path) => [relative(packageRoot, path).replaceAll("\\", "/"), sha256(readFileSync(path))])
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

function listFiles(base) {
  const files = [];
  const visit = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (lstatSync(path).isDirectory()) visit(path);
      else files.push(path);
    }
  };
  visit(base);
  return files;
}

function rawGitBlob(stackDir, sourcePath) {
  return execFileSync("git", ["--no-replace-objects", "-C", stackDir, "show", `${expected.sourceCommit}:${sourcePath}`]);
}

function rawSourceModes(stackDir) {
  const output = execFileSync(
    "git",
    ["--no-replace-objects", "-C", stackDir, "ls-tree", "-r", "-z", expected.sourceCommit, "--", "stack/agents", "stack/skills"],
  ).toString("utf8");
  const modes = new Map();
  for (const record of output.split("\0").filter(Boolean)) {
    const match = /^(\d+)\s+\w+\s+[a-f0-9]+\t(.+)$/.exec(record);
    assert.ok(match, `unexpected git ls-tree record: ${record}`);
    modes.set(match[2], match[1]);
  }
  return modes;
}

function findDifferentAssetCommit(stackDir) {
  const pinnedTrees = assetTrees(stackDir, expected.sourceCommit);
  const commits = execFileSync("git", ["--no-replace-objects", "-C", stackDir, "rev-list", "--all"], { encoding: "utf8" }).trim().split(/\r?\n/);
  for (const commit of commits) {
    if (!commit || commit === expected.sourceCommit) continue;
    try {
      const trees = assetTrees(stackDir, commit);
      if (trees.agents !== pinnedTrees.agents || trees.skills !== pinnedTrees.skills) return commit;
    } catch {
      // Older commits that predate either owned tree are not usable replacement fixtures.
    }
  }
  return undefined;
}

function assetTrees(stackDir, commit) {
  return {
    agents: execFileSync("git", ["--no-replace-objects", "-C", stackDir, "rev-parse", `${commit}:stack/agents`], { encoding: "utf8" }).trim(),
    skills: execFileSync("git", ["--no-replace-objects", "-C", stackDir, "rev-parse", `${commit}:stack/skills`], { encoding: "utf8" }).trim(),
  };
}

function replaceRefs(stackDir) {
  return execFileSync("git", ["-C", stackDir, "for-each-ref", "--format=%(refname) %(objectname)", "refs/replace"], { encoding: "utf8" }).trim();
}

function normalizeLf(bytes) {
  return Buffer.from(bytes.toString("utf8").replace(/\r\n?/g, "\n"), "utf8");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
