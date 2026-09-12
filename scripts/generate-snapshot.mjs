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
const DEFAULT_SOURCE_COMMIT = "64f15d9f4c7ce737fbf9f317c1080ee159142eb9";
const SOURCE_COMMIT = process.env.JORGEX_STACK_COMMIT?.trim() || DEFAULT_SOURCE_COMMIT;
const QUALITY_RECEIPT_SOURCE_PATH = "stack/contracts/quality-receipt.v1.schema.json";
const QUALITY_RECEIPT_TARGET_PATH = "contract/schemas/quality-receipt.v1.schema.json";
const QUALITY_CAPABILITIES_SOURCE_PATH = "stack/contracts/quality-capabilities.v1.schema.json";
const QUALITY_CAPABILITIES_TARGET_PATH = "contract/schemas/quality-capabilities.v1.schema.json";
const PERMISSIONS_SOURCE_PATH = "stack/config/defaults.json";
const PERMISSIONS_TARGET_PATH = "assets/permissions/defaults.json";
const POLICY_SOURCE_PATH = "stack/system-prompt/AGENTS.md";
const ENGRAM_PROTOCOL_SOURCE_PATH = "stack/system-prompt/engram-protocol.md";
const SYSTEM_PROMPT_MODULES = [
  { name: "context7", file: "context7.md" },
  { name: "playwright", file: "browser-playwright.md" },
  { name: "chrome-devtools", file: "browser-chrome-devtools.md" },
];
const COMMAND_SOURCES = [
  {
    name: "lean-audit",
    sourcePath: "stack/commands/lean-audit.md",
    targetPath: "prompts/lean-audit.md",
  },
];
const EXCLUSIONS = [
  { kind: "capability-integration", id: "post-pr-shell-hook-translation" },
  { kind: "capability-integration", id: "programmatic-mode-negotiation" },
  { kind: "runtime-specific-overlay", sourcePath: "stack/commands/claude-code/xreview.md" },
  { kind: "runtime-specific-overlay", sourcePath: "stack/commands/opencode/xreview.md" },
];
const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, "..");
const stackDir = process.env.JORGEX_STACK_DIR;
const gitArgs = ["--no-replace-objects", "-C", stackDir];

if (!stackDir || !isAbsolute(stackDir)) {
  throw new Error("JORGEX_STACK_DIR must be an absolute path to the reviewed JorgeX Stack checkout");
}
if (!/^[a-f0-9]{40}$/.test(SOURCE_COMMIT)) {
  throw new Error("JORGEX_STACK_COMMIT must be a full lowercase Stack commit SHA");
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
    schemaVersion: 2,
    source: { repository: SOURCE_REPOSITORY, commit: SOURCE_COMMIT },
    agents: agentSources.map(generateAgent),
    skills: generateSkills(skillSources),
    policy: generateCopyProjection(POLICY_SOURCE_PATH, "assets/system-prompt/AGENTS.md"),
    engramProtocol: generateCopyProjection(ENGRAM_PROTOCOL_SOURCE_PATH, "assets/system-prompt/engram-protocol.md"),
    systemPromptModules: SYSTEM_PROMPT_MODULES.map(({ name, file }) => ({
      name,
      ...generateCopyProjection(`stack/system-prompt/${file}`, `assets/system-prompt/${file}`),
    })),
    permissions: generatePermissionsProjection(),
    qualityReceipt: generateQualityReceiptProjection(),
    qualityCapabilities: generateQualityCapabilitiesProjection(),
    commands: COMMAND_SOURCES.map(generateCommand),
    exclusions: EXCLUSIONS,
  };

  writeJson(join(stage, "contract", "parity.v2.json"), parity);
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

function generatePermissionsProjection() {
  const sourceBytes = gitBytes(PERMISSIONS_SOURCE_PATH);
  let source;
  try {
    source = JSON.parse(sourceBytes.toString("utf8"));
  } catch {
    throw new Error(`${PERMISSIONS_SOURCE_PATH} must contain valid JSON`);
  }
  const opencode = source?.opencode?.permission;
  if (!isRecord(opencode) || !isRecord(opencode.read) || !isRecord(opencode.bash)) {
    throw new Error(`${PERMISSIONS_SOURCE_PATH} must contain the reviewed OpenCode permission defaults`);
  }
  const pathRules = structuredClone(opencode.read);
  const policy = {
    "*": "ask",
    path: pathRules,
    read: "allow",
    write: "allow",
    edit: "allow",
    grep: "allow",
    find: "allow",
    ls: "allow",
    bash: structuredClone(opencode.bash),
    mcp: {
      "*": "ask",
      ...knownMcpTools("allow"),
    },
    skill: "allow",
    external_directory: "allow",
    git_read: "allow",
    ...knownCompanionTools("allow"),
  };
  const output = {
    "$schema": "https://raw.githubusercontent.com/gotgenes/pi-packages/main/packages/pi-permission-system/schemas/permissions.schema.json",
    permission: policy,
  };
  const outputBytes = Buffer.from(`${JSON.stringify(output, null, 2)}\n`, "utf8");
  writeBytes(join(stage, PERMISSIONS_TARGET_PATH), outputBytes);
  return {
    sourcePath: PERMISSIONS_SOURCE_PATH,
    targetPath: PERMISSIONS_TARGET_PATH,
    sourceSha256: sha256(sourceBytes),
    outputSha256: sha256(outputBytes),
  };
}

function knownMcpTools(action) {
  return Object.fromEntries([
    "mcp_status",
    "mcp_list",
    "mcp_search",
    "mcp_describe",
    "mcp_connect",
    "engram_*",
    "context7_*",
    "context7:*",
    "engram:*",
  ].map((name) => [name, action]));
}

function knownCompanionTools(action) {
  return Object.fromEntries([
    "ask_user_question",
    "subagent",
    "subagent_wait",
    "contact_supervisor",
    "web_search",
    "fetch_content",
    "get_search_content",
    "source_check",
    "goal_blocked",
    "goal_complete",
    "goal_wait",
    "mem_save",
    "mem_search",
    "mem_context",
    "mem_session_summary",
    "mem_session_start",
    "mem_session_end",
    "mem_get_observation",
    "mem_suggest_topic_key",
    "mem_save_prompt",
    "mem_update",
    "mem_current_project",
    "mem_judge",
    "mem_compare",
    "mem_doctor",
    "mem_review",
    "mem_pin",
    "mem_unpin",
  ].map((name) => [name, action]));
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

function generateCopyProjection(sourcePath, targetPath) {
  const bytes = gitBytes(sourcePath);
  writeBytes(join(stage, targetPath), bytes);
  return {
    sourcePath,
    targetPath,
    sourceSha256: sha256(bytes),
    outputSha256: sha256(bytes),
  };
}

function generateQualityReceiptProjection() {
  return {
    namespace: "jorgex.quality.receipt",
    version: 1,
    ...generateCopyProjection(QUALITY_RECEIPT_SOURCE_PATH, QUALITY_RECEIPT_TARGET_PATH),
  };
}

function generateQualityCapabilitiesProjection() {
  return {
    namespace: "jorgex.quality.capabilities",
    version: 1,
    ...generateCopyProjection(QUALITY_CAPABILITIES_SOURCE_PATH, QUALITY_CAPABILITIES_TARGET_PATH),
  };
}

function generateCommand({ name, sourcePath, targetPath }) {
  const sourceBytes = gitBytes(sourcePath);
  const outputBytes = translatePromptArguments(sourceBytes, sourcePath);
  writeBytes(join(stage, targetPath), outputBytes);
  return {
    name,
    sourcePath,
    targetPath,
    sourceSha256: sha256(sourceBytes),
    outputSha256: sha256(outputBytes),
  };
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

function translatePromptArguments(bytes, sourcePath) {
  const source = bytes.toString("utf8");
  if (!source.includes("{{input}}")) throw new Error(`${sourcePath} must declare the {{input}} placeholder`);
  return Buffer.from(source.replaceAll("{{input}}", "$ARGUMENTS"), "utf8");
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

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
