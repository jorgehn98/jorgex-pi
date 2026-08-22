import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { commitSnapshot } from "./snapshot-transaction.mjs";

const SOURCE_REPOSITORY = "https://github.com/jorgehn98/jorgex-stack";
const SOURCE_COMMIT = "6d2b98b1728e275bf97920f9712dd4b7928de6a7";
const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, "..");
const stackDir = process.env.JORGEX_STACK_DIR;
const gitArgs = ["--no-replace-objects", "-C", stackDir];

if (!stackDir || !isAbsolute(stackDir)) {
  throw new Error("JORGEX_STACK_DIR must be an absolute path to the reviewed JorgeX Stack checkout");
}

const resolvedCommit = gitText(["rev-parse", `${SOURCE_COMMIT}^{commit}`]).trim();
if (resolvedCommit !== SOURCE_COMMIT) {
  throw new Error(`JORGEX_STACK_DIR does not contain the pinned Stack commit ${SOURCE_COMMIT}`);
}

const stage = mkdtempSync(join(root, ".snapshot-build-"));
let generationError;
let preserveStage = false;
try {
  const agentSources = listGitFiles("stack/agents").filter(
    (path) => path.endsWith(".md") && path !== "stack/agents/README.md",
  );
  const skillSources = listGitFiles("stack/skills");
  const parity = {
    schemaVersion: 1,
    source: { repository: SOURCE_REPOSITORY, commit: SOURCE_COMMIT },
    agents: agentSources.map(generateAgent),
    skills: generateSkills(skillSources),
  };

  writeJson(join(stage, "contract", "parity.v1.json"), parity);
  commitSnapshot({ root, stage });
} catch (error) {
  generationError = error;
  preserveStage = error?.preserveSnapshotStage === true;
  throw error;
} finally {
  if (preserveStage) process.stderr.write(`Snapshot recovery data preserved at ${stage}\n`);
  else {
    try {
      rmSync(stage, { recursive: true, force: true });
    } catch (cleanupError) {
      if (!generationError) throw cleanupError;
    }
  }
}

function generateAgent(sourcePath) {
  const name = sourcePath.slice("stack/agents/".length, -".md".length);
  assertName(name, `agent path ${sourcePath}`);
  const targetPath = `snapshot/agents/${name}.md`;
  const sourceBytes = gitBytes(sourcePath);
  const outputBytes = normalizeLf(sourceBytes);
  writeBytes(join(stage, targetPath), outputBytes);
  return {
    name,
    sourcePath,
    targetPath,
    sourceSha256: sha256(sourceBytes),
    outputSha256: sha256(outputBytes),
  };
}

function generateSkills(sourcePaths) {
  const byName = new Map();
  for (const sourcePath of sourcePaths) {
    const relativePath = sourcePath.slice("stack/skills/".length);
    assertSafeRelativePath(relativePath, `skill path ${sourcePath}`);
    const [name, ...segments] = relativePath.split("/");
    assertName(name, `skill path ${sourcePath}`);
    const filePath = segments.join("/");
    assertSafeRelativePath(filePath, `skill file ${sourcePath}`);
    const bytes = gitBytes(sourcePath);
    writeBytes(join(stage, "skills", name, filePath), bytes);
    const skill = byName.get(name) ?? {
      name,
      sourcePath: `stack/skills/${name}`,
      targetPath: `skills/${name}`,
      files: [],
    };
    skill.files.push({ path: filePath, sha256: sha256(bytes) });
    byName.set(name, skill);
  }
  return [...byName.values()].sort((a, b) => compareCodePoints(a.name, b.name));
}

function listGitFiles(prefix) {
  const output = execFileSync(
    "git",
    [...gitArgs, "ls-tree", "-r", "-z", "--name-only", SOURCE_COMMIT, "--", prefix],
  );
  return output.toString("utf8").split("\0").filter(Boolean).sort();
}

function gitBytes(path) {
  return execFileSync("git", [...gitArgs, "show", `${SOURCE_COMMIT}:${path}`]);
}

function gitText(args) {
  return execFileSync("git", [...gitArgs, ...args], { encoding: "utf8" });
}

function writeBytes(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

function writeJson(path, value) {
  writeBytes(path, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizeLf(bytes) {
  return Buffer.from(bytes.toString("utf8").replace(/\r\n?/g, "\n"), "utf8");
}

function compareCodePoints(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertName(value, label) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) throw new Error(`${label} has an unsafe name`);
}

function assertSafeRelativePath(value, label) {
  const normalized = relative(".", value).replaceAll("\\", "/");
  if (!value || value.startsWith("/") || normalized !== value || value.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`${label} is not a safe normalized relative path`);
  }
}
