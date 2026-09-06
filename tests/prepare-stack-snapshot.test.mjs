import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { prepareStackSnapshot } from "../scripts/prepare-stack-snapshot.mjs";

const testDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(testDir, "..");

test("prepareStackSnapshot reports a pending content change without touching a clean Pi checkout in dry-run mode", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-prepare-stack-snapshot-dry-run-"));
  try {
    const { stackDir, root } = arrangeFixture(sandbox);
    const sourceCommit = commitStackContentChange(stackDir);
    const before = readTree(root);

    const result = prepareStackSnapshot({ root, stackDir, sourceCommit });

    assert.equal(result.status, "prepared");
    assert.equal(result.sourceCommit, sourceCommit);
    assert.ok(result.changedPaths.length > 0, "a consumed Stack change must report affected Pi paths");
    assert.deepEqual(readTree(root), before, "dry-run must leave every Pi byte untouched");
    assert.equal(git(root, ["status", "--porcelain"]), "", "dry-run must leave the worktree clean");
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("prepareStackSnapshot leaves provenance unchanged when a descendant Stack commit changes no consumed output", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-prepare-stack-snapshot-noop-"));
  try {
    const { stackDir, root } = arrangeFixture(sandbox);
    const sourceCommit = commitStackMetadataChange(stackDir);
    git(root, ["checkout", "-q", "--detach"]);
    const before = readTree(root);
    const parityBefore = readParity(root);

    const result = prepareStackSnapshot({ root, stackDir, sourceCommit, apply: true });

    assert.equal(result.status, "unchanged");
    assert.equal(result.sourceCommit, sourceCommit);
    assert.deepEqual(result.changedPaths, []);
    assert.deepEqual(readTree(root), before, "a metadata-only source commit must not update parity provenance");
    assert.equal(readParity(root).source.commit, parityBefore.source.commit);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("prepareStackSnapshot applies a content change once and is a clean no-op after that candidate is committed", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-prepare-stack-snapshot-apply-"));
  try {
    const { stackDir, root } = arrangeFixture(sandbox);
    const sourceCommit = commitStackContentChange(stackDir);
    const before = readTree(root);

    const applied = prepareStackSnapshot({ root, stackDir, sourceCommit, apply: true });

    assert.equal(applied.status, "prepared");
    assert.equal(applied.sourceCommit, sourceCommit);
    assert.ok(applied.changedPaths.length > 0);
    assert.notDeepEqual(readTree(root), before, "apply must publish the reviewed generator output");
    assert.equal(readParity(root).source.commit, sourceCommit, "apply may advance parity provenance only with generated output");

    commitAll(root, "prepared candidate");
    const afterCommit = readTree(root);
    const repeated = prepareStackSnapshot({ root, stackDir, sourceCommit, apply: true });

    assert.equal(repeated.status, "unchanged");
    assert.equal(repeated.sourceCommit, sourceCommit);
    assert.deepEqual(repeated.changedPaths, []);
    assert.deepEqual(readTree(root), afterCommit, "a second apply must not create a metadata-only diff");
    assert.equal(git(root, ["status", "--porcelain"]), "");
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("prepareStackSnapshot keeps the Pi root intact when the fixture's second real generator fails", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-prepare-stack-snapshot-second-generator-"));
  try {
    const { stackDir, root } = arrangeFixture(sandbox);
    const sourceCommit = commitStackContentChange(stackDir);
    writeFileSync(join(root, "scripts", "generate-runtime-agents.mjs"), "throw new Error('fixture second generator failure');\n");
    commitAll(root, "inject second generator boundary failure");
    const before = readTree(root);

    assert.throws(
      () => prepareStackSnapshot({ root, stackDir, sourceCommit, apply: true }),
      (error) => /fixture second generator failure/.test(errorText(error)),
    );
    assert.deepEqual(readTree(root), before, "a second-generator failure must never publish first-generator output");
    assert.equal(git(root, ["status", "--porcelain"]), "");
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("prepareStackSnapshot rejects an incompatible generated schema without touching the Pi root", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-prepare-stack-snapshot-contract-"));
  try {
    const { stackDir, root } = arrangeFixture(sandbox);
    const sourceCommit = commitStackSchemaChange(stackDir);
    const before = readTree(root);

    assert.throws(
      () => prepareStackSnapshot({ root, stackDir, sourceCommit, apply: true }),
      /incompat|schema|contract/i,
    );
    assert.deepEqual(readTree(root), before, "incompatible contract output must remain staged only");
    assert.equal(git(root, ["status", "--porcelain"]), "");
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("prepareStackSnapshot rejects an ignored extra inside a generated destination without removing it", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-prepare-stack-snapshot-ignored-extra-"));
  try {
    const { stackDir, root } = arrangeFixture(sandbox);
    const sourceCommit = commitStackContentChange(stackDir);
    const extra = join(root, "prompts", "ignored-extra.md");
    writeFileSync(join(root, ".git", "info", "exclude"), "prompts/ignored-extra.md\n", { flag: "a" });
    writeFileSync(extra, "ignored fixture extra\n");
    const before = readTree(root);

    assert.throws(
      () => prepareStackSnapshot({ root, stackDir, sourceCommit, apply: true }),
      /Generated destinations contain modified or extra ignored files/,
    );
    assert.deepEqual(readTree(root), before, "rejection must not remove ignored generated extras");
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("prepareStackSnapshot rejects a symlinked generated destination without replacing it", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-prepare-stack-snapshot-symlink-"));
  try {
    const { stackDir, root } = arrangeFixture(sandbox);
    const sourceCommit = commitStackContentChange(stackDir);
    const prompts = join(root, "prompts");
    const target = join(root, "fixture-prompts-target");
    renameSync(prompts, target);
    symlinkSync(target, prompts, "junction");
    commitAll(root, "fixture generated destination junction");
    assert.equal(git(root, ["status", "--porcelain"]), "", "fixture symlink must be committed so the production symlink guard is reached");
    assert.equal(lstatSync(prompts).isSymbolicLink(), true);

    assert.throws(
      () => prepareStackSnapshot({ root, stackDir, sourceCommit, apply: true }),
      /Unsafe generated destination/,
    );
    assert.equal(lstatSync(prompts).isSymbolicLink(), true, "rejection must preserve the generated destination symlink");
    assert.equal(git(root, ["status", "--porcelain"]), "");
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("prepareStackSnapshot rejects a source downgrade, main, and a dirty worktree before changing files", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-prepare-stack-snapshot-preconditions-"));
  try {
    const { stackDir, root, baseCommit, fixtureSourceCommit } = arrangeFixture(sandbox, { contentBaseline: true });
    const beforeDowngrade = readTree(root);

    assert.throws(
      () => prepareStackSnapshot({ root, stackDir, sourceCommit: baseCommit, apply: true }),
      /ancestor|downgrade/i,
    );
    assert.deepEqual(readTree(root), beforeDowngrade);

    git(root, ["branch", "-m", "main"]);
    const beforeMain = readTree(root);
    assert.throws(
      () => prepareStackSnapshot({ root, stackDir, sourceCommit: fixtureSourceCommit, apply: true }),
      /main|branch|production/i,
    );
    assert.deepEqual(readTree(root), beforeMain);

    git(root, ["branch", "-m", "snapshot-test"]);
    writeFileSync(join(root, "local-note.txt"), "uncommitted fixture state\n");
    const beforeDirty = readTree(root);
    assert.throws(
      () => prepareStackSnapshot({ root, stackDir, sourceCommit: fixtureSourceCommit, apply: true }),
      /clean|dirty|worktree/i,
    );
    assert.deepEqual(readTree(root), beforeDirty);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

function arrangeFixture(sandbox, { contentBaseline = false } = {}) {
  const root = join(sandbox, "pi");
  archivePiFixture(root);
  const stackDir = createStackFixture(join(sandbox, "stack"), root);
  const baseCommit = git(stackDir, ["rev-parse", "HEAD"]);
  const fixtureSourceCommit = contentBaseline ? commitStackContentChange(stackDir) : baseCommit;
  setFixtureGeneratorIdentity(root, fixtureSourceCommit);
  runGenerators(root, stackDir, fixtureSourceCommit);
  git(root, ["init", "-q", "-b", "snapshot-test"]);
  commitAll(root, "fixture snapshot");
  return { stackDir, root, baseCommit, fixtureSourceCommit };
}

function archivePiFixture(root) {
  mkdirSync(root, { recursive: true });
  const archive = execFileSync("git", ["archive", "--format=tar", "HEAD"], {
    cwd: packageRoot,
    env: safeGitEnv(),
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });
  execFileSync("tar", ["-xf", "-", "-C", root], { input: archive, stdio: ["pipe", "pipe", "pipe"] });
}

function createStackFixture(root, piRoot) {
  const parity = readParity(piRoot);
  for (const agent of parity.agents) copyProjection(piRoot, root, agent.sourcePath, agent.targetPath);
  for (const skill of parity.skills) {
    for (const file of skill.files) copyProjection(piRoot, root, `${skill.sourcePath}/${file.path}`, `${skill.targetPath}/${file.path}`);
  }
  for (const projection of [parity.policy, parity.engramProtocol, parity.qualityReceipt, parity.qualityCapabilities]) {
    copyProjection(piRoot, root, projection.sourcePath, projection.targetPath);
  }
  for (const command of parity.commands) {
    const output = readFileSync(join(piRoot, command.targetPath), "utf8");
    writeFixtureFile(root, command.sourcePath, output.replaceAll("$ARGUMENTS", "{{input}}"));
  }
  for (const exclusion of parity.exclusions.filter(({ sourcePath }) => sourcePath)) {
    writeFixtureFile(root, exclusion.sourcePath, "fixture excluded source\n");
  }

  git(root, ["init", "-q", "-b", "main"]);
  commitAll(root, "fixture Stack base");
  git(root, ["remote", "add", "origin", "https://github.com/jorgehn98/jorgex-stack.git"]);
  updateOriginMain(root);
  return root;
}

function copyProjection(fromRoot, toRoot, sourcePath, targetPath) {
  writeFixtureFile(toRoot, sourcePath, readFileSync(join(fromRoot, targetPath)));
}

function commitStackContentChange(stackDir) {
  const path = join(stackDir, "stack", "agents", "tester.md");
  writeFileSync(path, `${readFileSync(path, "utf8")}fixture content change\n`);
  commitAll(stackDir, "fixture content change");
  updateOriginMain(stackDir);
  return git(stackDir, ["rev-parse", "HEAD"]);
}

function commitStackMetadataChange(stackDir) {
  writeFixtureFile(stackDir, "stack/README.md", "metadata not consumed by generators\n");
  commitAll(stackDir, "fixture metadata change");
  updateOriginMain(stackDir);
  return git(stackDir, ["rev-parse", "HEAD"]);
}

function commitStackSchemaChange(stackDir) {
  writeFixtureFile(stackDir, "stack/contracts/quality-capabilities.v1.schema.json", "{\"type\":\"string\"}\n");
  commitAll(stackDir, "fixture incompatible schema");
  updateOriginMain(stackDir);
  return git(stackDir, ["rev-parse", "HEAD"]);
}

function setFixtureGeneratorIdentity(root, sourceCommit) {
  const path = join(root, "scripts", "generate-snapshot.mjs");
  const source = readFileSync(path, "utf8");
  const updated = source.replace(
    /const DEFAULT_SOURCE_COMMIT = "[a-f0-9]{40}";/,
    `const DEFAULT_SOURCE_COMMIT = "${sourceCommit}";`,
  );
  assert.notEqual(updated, source, "fixture generator must expose a pinned default source commit");
  writeFileSync(path, updated);
  const fixturePath = join(root, "tests", "fixtures", "snapshot-parity.expected.json");
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
  writeFileSync(fixturePath, `${JSON.stringify({ ...fixture, sourceCommit }, null, 2)}\n`);
}

function runGenerators(root, stackDir, sourceCommit) {
  const env = { ...safeGitEnv(), JORGEX_STACK_DIR: stackDir, JORGEX_STACK_COMMIT: sourceCommit };
  execFileSync(process.execPath, [join(root, "scripts", "generate-snapshot.mjs")], { env, stdio: "pipe" });
  execFileSync(process.execPath, [join(root, "scripts", "generate-runtime-agents.mjs")], { env, stdio: "pipe" });
}

function writeFixtureFile(root, relativePath, content) {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function readParity(root) {
  return JSON.parse(readFileSync(join(root, "contract", "parity.v2.json"), "utf8"));
}

function readTree(root) {
  const files = {};
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      if (name === ".git") continue;
      const path = join(directory, name);
      const stat = lstatSync(path);
      assert.equal(stat.isSymbolicLink(), false, `fixture tree must not contain a symlink: ${relative(root, path)}`);
      if (stat.isDirectory()) visit(path);
      else files[relative(root, path).replaceAll("\\", "/")] = readFileSync(path, "utf8");
    }
  };
  visit(root);
  return files;
}

function updateOriginMain(root) {
  git(root, ["update-ref", "refs/remotes/origin/main", git(root, ["rev-parse", "HEAD"])]);
}

function errorText(error) {
  const pending = [error];
  const seen = new Set();
  const text = [];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    text.push(String(current.message ?? current), String(current.stderr ?? ""));
    if (current.cause) pending.push(current.cause);
    if (Array.isArray(current.errors)) pending.push(...current.errors);
  }
  return text.join("\n");
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, env: safeGitEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function commitAll(cwd, message) {
  git(cwd, ["add", "."]);
  git(cwd, ["-c", "user.name=JorgeX Test", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", message]);
}

function safeGitEnv() {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
  };
}
