import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(testDir, "..");
const expected = readJson(join(testDir, "fixtures", "snapshot-parity.expected.json"), "snapshot parity fixture");

test("the dormant Stack snapshot is complete, deterministic, and inactive", () => {
  const packageManifest = readJson(join(root, "package.json"), "package manifest");
  for (const kind of ["extensions", "skills", "prompts", "themes"]) {
    assert.deepEqual(packageManifest.pi?.[kind], [], `package.json pi.${kind} must remain inactive in snapshot S1`);
  }
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    assert.deepEqual(packageManifest[field] ?? {}, {}, `snapshot S1 must not activate ${field}`);
  }
  assert.deepEqual(packageManifest.bundledDependencies ?? [], [], "snapshot S1 must not bundle companion dependencies");

  const parity = readJson(join(root, expected.parityPath), "snapshot parity manifest");
  assert.equal(parity.schemaVersion, expected.schemaVersion);
  assert.deepEqual(parity.source, { repository: expected.sourceRepository, commit: expected.sourceCommit });
  assertAgentParity(parity.agents);
  assertSkillParity(parity.skills);
});

function assertAgentParity(agents) {
  assert.ok(Array.isArray(agents), "parity agents must be an array");
  assert.equal(agents.length, expected.agentCount);
  assert.deepEqual(agents.map(({ name }) => name), expected.agentNames, "agent entries must be complete, unique, and sorted");
  const targetPaths = [];
  for (const agent of agents) {
    assert.deepEqual(Object.keys(agent).sort(), ["name", "outputSha256", "sourcePath", "sourceSha256", "targetPath"]);
    assert.equal(agent.sourcePath, `stack/agents/${agent.name}.md`);
    assert.equal(agent.targetPath, `snapshot/agents/${agent.name}.md`);
    assertSha256(agent.sourceSha256, `${agent.name} source hash`);
    assert.equal(agent.outputSha256, hashFile(join(root, agent.targetPath)), `${agent.name} output hash must match packaged bytes`);
    targetPaths.push(agent.targetPath);
  }
  assert.deepEqual(listFiles(join(root, "snapshot", "agents")), targetPaths, "snapshot/agents must contain exactly the parity targets");
}

function assertSkillParity(skills) {
  assert.ok(Array.isArray(skills), "parity skills must be an array");
  assert.equal(skills.length, expected.skillCount);
  assert.deepEqual(skills.map(({ name }) => name), expected.skillNames, "skill entries must be complete, unique, and sorted");
  const targetFiles = [];
  for (const skill of skills) {
    assert.deepEqual(Object.keys(skill).sort(), ["files", "name", "sourcePath", "targetPath"]);
    assert.equal(skill.sourcePath, `stack/skills/${skill.name}`);
    assert.equal(skill.targetPath, `skills/${skill.name}`);
    assert.ok(Array.isArray(skill.files) && skill.files.length > 0, `${skill.name} must contain files`);
    assert.deepEqual(
      skill.files.map(({ path }) => path),
      [...skill.files.map(({ path }) => path)].sort(),
      `${skill.name} file entries must be sorted`,
    );
    for (const file of skill.files) {
      assert.deepEqual(Object.keys(file).sort(), ["path", "sha256"]);
      assertSafeRelativePath(file.path, `${skill.name} file path`);
      const targetPath = `${skill.targetPath}/${file.path}`;
      assert.equal(file.sha256, hashFile(join(root, targetPath)), `${targetPath} hash must match packaged bytes`);
      targetFiles.push(targetPath);
    }
  }
  assert.equal(targetFiles.length, expected.skillFileCount);
  assert.equal(new Set(targetFiles).size, expected.skillFileCount, "skill target paths must be unique");
  assert.deepEqual(listFiles(join(root, "skills")), targetFiles.sort(), "skills must contain exactly the parity targets");
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    assert.fail(`${label} is missing or invalid at ${relative(root, path)} (${error.code ?? error.message})`);
  }
}

function hashFile(path) {
  const stat = lstatSync(path);
  assert.equal(stat.isSymbolicLink(), false, `snapshot file must not be a symlink: ${relative(root, path)}`);
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function listFiles(rootDir) {
  const files = [];
  const resolvedRoot = `${resolve(rootDir)}${sep}`;
  const visit = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      assert.equal(stat.isSymbolicLink(), false, `snapshot tree must not contain symlinks: ${relative(root, path)}`);
      assert.ok(resolve(path).startsWith(resolvedRoot), `snapshot path escapes its root: ${relative(rootDir, path)}`);
      if (stat.isDirectory()) visit(path);
      else files.push(relative(root, path).replaceAll("\\", "/"));
    }
  };
  visit(rootDir);
  return files.sort();
}

function assertSafeRelativePath(path, label) {
  assert.equal(typeof path, "string", `${label} must be a string`);
  assert.ok(path.length > 0 && !path.startsWith("/") && !path.includes("\\"), `${label} must be normalized and relative`);
  const segments = path.split("/");
  assert.ok(segments.every((segment) => segment.length > 0 && segment !== "." && segment !== ".."), `${label} must not contain empty or dot segments`);
}

function assertSha256(value, label) {
  assert.match(value ?? "", /^[a-f0-9]{64}$/, `${label} must be lowercase sha256`);
}
