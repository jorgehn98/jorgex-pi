import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { commitRuntimeAgents } from "./runtime-agents-transaction.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stage = mkdtempSync(join(root, ".runtime-agents-build-"));
let generationError;
let preserveStage = false;
const dependency = {
  name: "pi-subagents",
  version: "0.54.0",
  integrity: "sha512-U0RYNQQjtjOKtsMuZXXX+tOxbz+FNdMim0c4HHgGzXgplQqQhTiXzd1EVYdPY98cWfowHGHvf2kQxMLwKcCtww==",
  bundledClosure: [
    { name: "acorn", version: "8.18.0", integrity: "sha512-lGq+9yr1/GuAWaVYIHRjvvySG5/4VfKIvC8EWxStPdcDh/Ka7FG3twP6v4d5BkravUilhIAsG4Qj83t02LWUPQ==" },
    { name: "jiti", version: "2.7.0", integrity: "sha512-AC/7JofJvZGrrneWNaEnJeOLUx+JlGt7tNa0wZiRPT4MY1wmfKjt2+6O2p2uz2+skll8OZZmJMNqeke7kKbNgQ==" },
    { name: "pi-subagents", version: "0.54.0", integrity: "sha512-U0RYNQQjtjOKtsMuZXXX+tOxbz+FNdMim0c4HHgGzXgplQqQhTiXzd1EVYdPY98cWfowHGHvf2kQxMLwKcCtww==" },
    { name: "typebox", version: "1.1.38", integrity: "sha512-pZ0aQPmMmXoUvSbeuWf/Hzsc+avNw/Zd6VeE8CFgkVGWyuHPJvqeJJDeJqLve+K70LvjYIoleGcoJHPT17cWoA==" },
    { name: "yaml", version: "2.8.3", integrity: "sha512-AvbaCLOO2Otw/lW5bmh9d/WEdcDFdQp2Z2ZUH3pX9U2ihyUY0nvLv7J6TrWowklRGPYbB/IuIMfYgxaCPg5Bpg==" },
  ],
};
const skills = [
  "agent-delegation", "deploy-to-vercel", "diagnose", "find-skills", "lean-code", "mcp-builder", "orchestrator", "react-doctor",
  "skill-creator", "supabase", "supabase-postgres-best-practices", "tdd", "to-issues", "to-prd", "work-audit", "work-lifecycle", "xreview",
];
const engramTools = [
  "mem_search", "mem_context", "mem_get_observation", "mem_suggest_topic_key", "mem_current_project", "mem_doctor",
];

try {
  const names = readdirSync(join(root, "snapshot", "agents"))
    .filter((name) => name.endsWith(".md"))
    .map((name) => name.slice(0, -3))
    .sort();
  const translated = names.map(translateAgent);
  const primary = translated.find(({ source }) => source.mode === "primary");
  const agents = translated.filter(({ source }) => source.mode === "subagent");
  if (!primary || primary.source.name !== "orchestrator" || agents.length !== 14) throw new Error("runtime translation requires one orchestrator primary and fourteen subagents");

  for (const agent of translated) writeRuntimeAgent(agent);
  mkdirSync(join(stage, "deferred", "agents"), { recursive: true });
  writeJson(join(stage, "contract", "runtime-agents.v1.json"), {
    schemaVersion: 1,
    dependency,
    primary: contractEntry(primary),
    agents: agents.map(contractEntry),
    skills,
  });

  commitRuntimeAgents({ root, stage });
} catch (error) {
  generationError = error;
  preserveStage = error?.preserveRuntimeAgentsStage === true;
  throw error;
} finally {
  if (preserveStage) process.stderr.write(`Runtime agent recovery data preserved at ${stage}\n`);
  else {
    try {
      rmSync(stage, { recursive: true, force: true });
    } catch (cleanupError) {
      if (!generationError) throw cleanupError;
    }
  }
}

function translateAgent(name) {
  const sourcePath = `snapshot/agents/${name}.md`;
  const source = parseAgent(readFileSync(join(root, sourcePath), "utf8"), sourcePath);
  if (source.name !== name) throw new Error(`${sourcePath} name does not match its file name`);
  const status = source.mode === "primary" ? "dormant" : "runnable";
  const targetPath = source.mode === "primary" ? `primary/${name}.md` : `agents/${name}.md`;
  if (name === "engram") {
    const body = source.body
      .replace("use `mem_timeline` or `mem_get_observation` selectively", "use `mem_get_observation` selectively")
      .replace("call `mem_timeline(observation_id)`", "use `mem_search` with a narrower time-oriented query");
    return {
      source: { ...source, body },
      sourcePath,
      targetPath,
      status,
      requiredCapability: "engram-runtime-tools-v1",
      tools: engramTools,
    };
  }
  const tools = ["read", "grep", "find", "ls"];
  if (source.bash === "git-read") tools.push("git_read");
  if (source.bash === "full") tools.push("bash");
  if (source.readonly === "false") tools.push("edit", "write");
  if (source.mode === "subagent" && name !== "engram") tools.push("contact_supervisor");
  return { source, sourcePath, targetPath, status, tools };
}

function parseAgent(text, sourcePath) {
  const normalized = text.replace(/\r\n?/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);
  if (!match) throw new Error(`${sourcePath} must contain closed frontmatter`);
  const fields = {};
  for (const line of match[1].split("\n")) {
    const separator = line.indexOf(":");
    if (separator < 1) throw new Error(`${sourcePath} frontmatter must contain scalar fields only`);
    fields[line.slice(0, separator)] = line.slice(separator + 1).trim();
  }
  for (const field of ["name", "description", "mode", "tier", "readonly", "bash"]) {
    if (!fields[field]) throw new Error(`${sourcePath} is missing ${field}`);
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(fields.name)) throw new Error(`${sourcePath} has an unsafe name`);
  if (!["primary", "subagent"].includes(fields.mode)) throw new Error(`${sourcePath} has unsupported mode ${fields.mode}`);
  if (!["strong", "standard", "cheap"].includes(fields.tier)) throw new Error(`${sourcePath} has unsupported tier ${fields.tier}`);
  if (!["true", "false"].includes(fields.readonly)) throw new Error(`${sourcePath} has invalid readonly`);
  if (!["none", "git-read", "full"].includes(fields.bash)) throw new Error(`${sourcePath} has unsupported bash policy ${fields.bash}`);
  if (fields.spawn !== undefined && fields.spawn !== "false") throw new Error(`${sourcePath} has unsupported spawn value`);
  return { ...fields, body: match[2] };
}

function writeRuntimeAgent(agent) {
  const lines = [
    "---",
    `name: ${agent.source.name}`,
    `description: ${agent.source.description}`,
    `tools: ${agent.tools.join(", ")}`,
    "systemPromptMode: replace",
    "inheritProjectContext: true",
    "inheritSkills: false",
  ];
  if (agent.source.bash === "git-read") lines.push("subagentOnlyExtensions: ../extensions/git-read.ts");
  if (agent.source.spawn === "false") lines.push("maxSubagentDepth: 0");
  lines.push("---", agent.source.body);
  writeText(join(stage, agent.targetPath), `${lines.join("\n").replace(/\n*$/, "")}\n`);
}

function contractEntry(agent) {
  return {
    name: agent.source.name,
    sourcePath: agent.sourcePath,
    targetPath: agent.targetPath,
    tier: agent.source.tier,
    status: agent.status,
    ...(agent.requiredCapability ? { requiredCapability: agent.requiredCapability } : {}),
    ...(agent.source.spawn === "false" ? { maxSubagentDepth: 0 } : {}),
    ...(agent.source.bash === "git-read" ? { subagentOnlyExtensions: ["../extensions/git-read.ts"] } : {}),
    tools: agent.tools,
  };
}

function writeJson(path, value) {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}
