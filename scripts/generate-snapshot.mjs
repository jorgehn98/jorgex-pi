import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_REPOSITORY = "https://github.com/jorgehn98/jorgex-stack";
const SOURCE_COMMIT = "6d2b98b1728e275bf97920f9712dd4b7928de6a7";
const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, "..");
const stackDir = process.env.JORGEX_STACK_DIR;

if (!stackDir || !isAbsolute(stackDir)) {
  throw new Error("JORGEX_STACK_DIR must be an absolute path to the reviewed JorgeX Stack checkout");
}

const resolvedCommit = gitText(["rev-parse", `${SOURCE_COMMIT}^{commit}`]).trim();
if (resolvedCommit !== SOURCE_COMMIT) {
  throw new Error(`JORGEX_STACK_DIR does not contain the pinned Stack commit ${SOURCE_COMMIT}`);
}

const stage = mkdtempSync(join(root, ".snapshot-build-"));
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
  replaceDirectory("snapshot");
  replaceDirectory("skills");
  mkdirSync(join(root, "contract"), { recursive: true });
  copyFileSync(join(stage, "contract", "parity.v1.json"), join(root, "contract", "parity.v1.json"));
} finally {
  rmSync(stage, { recursive: true, force: true });
}

function generateAgent(sourcePath) {
  const name = sourcePath.slice("stack/agents/".length, -".md".length);
  assertName(name, `agent path ${sourcePath}`);
  const targetPath = `snapshot/agents/${name}.md`;
  const bytes = gitBytes(sourcePath);
  writeBytes(join(stage, targetPath), bytes);
  return {
    name,
    sourcePath,
    targetPath,
    sourceSha256: sha256(bytes),
    outputSha256: sha256(bytes),
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
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function listGitFiles(prefix) {
  const output = execFileSync(
    "git",
    ["-C", stackDir, "ls-tree", "-r", "-z", "--name-only", SOURCE_COMMIT, "--", prefix],
  );
  return output.toString("utf8").split("\0").filter(Boolean).sort();
}

function gitBytes(path) {
  return execFileSync("git", ["-C", stackDir, "show", `${SOURCE_COMMIT}:${path}`]);
}

function gitText(args) {
  return execFileSync("git", ["-C", stackDir, ...args], { encoding: "utf8" });
}

function replaceDirectory(name) {
  const target = join(root, name);
  rmSync(target, { recursive: true, force: true });
  renameSync(join(stage, name), target);
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

function assertName(value, label) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) throw new Error(`${label} has an unsafe name`);
}

function assertSafeRelativePath(value, label) {
  const normalized = relative(".", value).replaceAll("\\", "/");
  if (!value || value.startsWith("/") || normalized !== value || value.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`${label} is not a safe normalized relative path`);
  }
}
