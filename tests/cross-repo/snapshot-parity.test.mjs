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
  const modes = rawSourceModes(stackDir, trackedSourcePaths(parity));
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

  assertCopyProjection(stackDir, modes, parity.policy, expected.policy, "system policy");
  assertCopyProjection(stackDir, modes, parity.engramProtocol, expected.engramProtocol, "Engram protocol");
  assert.deepEqual(parity.exclusions, expected.exclusions, "parity v2 must retain every deliberate exclusion");
  for (const exclusion of parity.exclusions.filter(({ kind }) => kind === "runtime-specific-overlay")) {
    assert.equal(modes.get(exclusion.sourcePath), "100644", `${exclusion.sourcePath} must remain an explicit regular-file exclusion`);
  }

  assert.ok(Array.isArray(parity.commands), "parity commands must be an array");
  assert.equal(parity.commands.length, expected.commands.length, "parity commands must be complete");
  for (const [index, command] of parity.commands.entries()) {
    const commandExpected = expected.commands[index];
    assert.equal(command.name, commandExpected.name);
    assert.equal(command.sourcePath, commandExpected.sourcePath);
    assert.equal(command.targetPath, commandExpected.targetPath);
    const source = rawGitBlob(stackDir, command.sourcePath);
    const output = translatePromptArguments(source);
    assert.equal(modes.get(command.sourcePath), "100644", `${command.sourcePath} must be a regular non-executable source file`);
    assert.equal(command.sourceSha256, sha256(source), `${command.sourcePath} source hash must match the raw pinned object`);
    assert.equal(command.outputSha256, sha256(output), `${command.targetPath} output hash must describe Pi argument syntax`);
    assert.deepEqual(readFileSync(join(root, command.targetPath)), output, `${command.targetPath} must translate {{input}} to $ARGUMENTS`);
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
    const replacementCommit = createAdversarialReplacementCommit(replacementStack);
    assert.equal(
      execFileSync("git", ["-C", replacementStack, "ls-tree", "-r", "--name-only", replacementCommit], { encoding: "utf8" }).trim(),
      "",
      "the adversarial replacement commit must omit every Stack asset",
    );
    execFileSync("git", ["-C", replacementStack, "replace", expected.sourceCommit, replacementCommit], { stdio: "pipe" });
    assert.notEqual(replaceRefs(replacementStack), "", "the isolated clone must contain the adversarial replacement ref");
    assert.throws(
      () => execFileSync("git", ["-C", replacementStack, "show", `${expected.sourceCommit}:stack/agents`], { stdio: "pipe" }),
      "ordinary Git object access must follow the adversarial replacement ref",
    );

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
    join(packageRoot, expected.policy.targetPath),
    join(packageRoot, expected.engramProtocol.targetPath),
    ...expected.commands.map(({ targetPath }) => join(packageRoot, targetPath)),
    join(packageRoot, expected.parityPath),
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

function rawSourceModes(stackDir, sourcePaths) {
  const output = execFileSync(
    "git",
    ["--no-replace-objects", "-C", stackDir, "ls-tree", "-r", "-z", expected.sourceCommit, "--", ...sourcePaths],
  ).toString("utf8");
  const modes = new Map();
  for (const record of output.split("\0").filter(Boolean)) {
    const match = /^(\d+)\s+\w+\s+[a-f0-9]+\t(.+)$/.exec(record);
    assert.ok(match, `unexpected git ls-tree record: ${record}`);
    modes.set(match[2], match[1]);
  }
  return modes;
}

function trackedSourcePaths(parity) {
  return [
    ...parity.agents.map(({ sourcePath }) => sourcePath),
    ...parity.skills.map(({ sourcePath }) => sourcePath),
    parity.policy.sourcePath,
    parity.engramProtocol.sourcePath,
    ...parity.commands.map(({ sourcePath }) => sourcePath),
    ...parity.exclusions.filter(({ kind }) => kind === "runtime-specific-overlay").map(({ sourcePath }) => sourcePath),
  ];
}

function assertCopyProjection(stackDir, modes, projection, projectionExpected, label) {
  assert.equal(projection.sourcePath, projectionExpected.sourcePath);
  assert.equal(projection.targetPath, projectionExpected.targetPath);
  const source = rawGitBlob(stackDir, projection.sourcePath);
  assert.equal(modes.get(projection.sourcePath), "100644", `${projection.sourcePath} must be a regular non-executable source file`);
  assert.equal(projection.sourceSha256, sha256(source), `${projection.sourcePath} source hash must match the raw pinned object`);
  assert.equal(projection.outputSha256, sha256(source), `${projection.targetPath} output hash must describe byte-exact source`);
  assert.deepEqual(readFileSync(join(root, projection.targetPath)), source, `${label} fallback must remain byte-exact`);
}

function createAdversarialReplacementCommit(stackDir) {
  const emptyTree = execFileSync("git", ["-C", stackDir, "mktree"], { encoding: "utf8", input: "" }).trim();
  return execFileSync("git", ["-C", stackDir, "commit-tree", emptyTree, "-m", "Adversarial empty replacement"], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "JorgeX Pi test",
      GIT_AUTHOR_EMAIL: "parity-test@example.invalid",
      GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
      GIT_COMMITTER_NAME: "JorgeX Pi test",
      GIT_COMMITTER_EMAIL: "parity-test@example.invalid",
      GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
    },
  }).trim();
}

function replaceRefs(stackDir) {
  return execFileSync("git", ["-C", stackDir, "for-each-ref", "--format=%(refname) %(objectname)", "refs/replace"], { encoding: "utf8" }).trim();
}

function normalizeLf(bytes) {
  return Buffer.from(bytes.toString("utf8").replace(/\r\n?/g, "\n"), "utf8");
}

function translatePromptArguments(source) {
  const text = source.toString("utf8");
  assert.match(text, /\{\{input\}\}/, "canonical command must declare its portable input placeholder");
  return Buffer.from(text.replaceAll("{{input}}", "$ARGUMENTS"), "utf8");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
