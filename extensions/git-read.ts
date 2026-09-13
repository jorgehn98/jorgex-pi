import { execFile as nodeExecFile } from "node:child_process";
import { devNull } from "node:os";
import { Type } from "typebox";

const blockedArguments = [
  "--config-env",
  "--exec-path",
  "--ext-diff",
  "--git-dir",
  "--no-index",
  "--output",
  "--paginate",
  "--show-signature",
  "--textconv",
  "--work-tree",
];

const parameters = Type.Object({
  action: Type.Union([Type.Literal("diff"), Type.Literal("log")]),
  args: Type.Optional(Type.Array(Type.String(), { maxItems: 128 })),
});

export function createGitReadExtension({ execFile = runGit, getPermissionsService: injectedLocator } = {}) {
  return async function gitReadExtension(pi) {
    const activeAgents = new Map();
    const sessionManagers = new Map();
    let currentSessionId;
    let registeredService;
    let disposeExtractor;
    const getPermissionsService = injectedLocator ?? await resolvePermissionsLocator();

    pi.on?.("session_start", (_event, ctx) => {
      currentSessionId = readSessionId(ctx);
      if (currentSessionId && ctx?.sessionManager) sessionManagers.set(currentSessionId, ctx.sessionManager);
    });
    pi.on?.("before_agent_start", (event, ctx) => {
      const sessionId = readSessionId(ctx) ?? currentSessionId;
      if (!sessionId) return;
      const agentName = readActiveAgentNameFromContext(ctx) ?? readActiveAgentName(event?.systemPrompt);
      if (agentName) activeAgents.set(sessionId, agentName);
    });
    pi.on?.("session_shutdown", (_event, ctx) => {
      const sessionId = readSessionId(ctx) ?? currentSessionId;
      const isCurrent = sessionId === currentSessionId;
      if (sessionId) activeAgents.delete(sessionId);
      if (sessionId) sessionManagers.delete(sessionId);
      if (isCurrent && disposeExtractor) disposeExtractor();
      if (isCurrent) {
        disposeExtractor = undefined;
        registeredService = undefined;
        currentSessionId = undefined;
      }
    });
    pi.events?.on?.("permissions:ready", (event) => {
      const sessionId = typeof event?.sessionId === "string" && event.sessionId ? event.sessionId : undefined;
      if (!sessionId || !getPermissionsService) return;
      const service = getPermissionsService(sessionId);
      if (!service || registeredService === service) return;
      disposeExtractor?.();
      disposeExtractor = service.registerToolAccessExtractor("git_read", (input) => {
        const agentName = readActiveAgentNameFromManager(sessionManagers.get(sessionId)) ?? activeAgents.get(sessionId);
        return selectMostRestrictivePath(input, service, agentName);
      });
      registeredService = service;
    });

    pi.registerTool({
      name: "git_read",
      label: "Git read",
      description: "Inspect repository history or changes with shell-free git diff/git log argv. This tool cannot write output files or compare arbitrary external paths.",
      parameters,
      async execute(_toolCallId, input, signal, _onUpdate, ctx) {
        if (!registeredService || !disposeExtractor) {
          throw new Error("git_read permission extractor is unavailable; refusing to execute without the native path gate.");
        }
        const action = validateAction(input?.action);
        const args = validateArguments(input?.args);
        const fixed = ["--no-pager", "-c", "core.fsmonitor=false", "-c", "log.showSignature=false", action, "--no-ext-diff", "--no-textconv"];
        const { stdout, stderr } = await execFile("git", [...fixed, ...args], {
          cwd: ctx.cwd,
          env: gitEnvironment(process.env),
          ...(signal ? { signal } : {}),
        });
        const output = [stdout, stderr].filter(Boolean).join(stderr && stdout ? "\n" : "") || "Git returned no output.";
        return { content: [{ type: "text", text: truncate(output) }], details: { action, args } };
      },
    });
  };
}

async function resolvePermissionsLocator() {
  try {
    const module = await import("@gotgenes/pi-permission-system");
    return typeof module?.getPermissionsService === "function" ? module.getPermissionsService : undefined;
  } catch {
    return undefined;
  }
}

function selectMostRestrictivePath(input, service, agentName) {
  const args = Array.isArray(input?.args) ? input.args : [];
  let selected;
  let selectedState;
  for (const value of args) {
    if (typeof value !== "string" || value.length === 0) continue;
    const check = service.checkPermission("path", value, agentName);
    if (selected === undefined || rankPermissionState(check.state) < rankPermissionState(selectedState)) {
      selected = value;
      selectedState = check.state;
    }
    if (selectedState === "deny") break;
  }
  return selected;
}

function rankPermissionState(state) {
  return state === "deny" ? 0 : state === "ask" ? 1 : 2;
}

function readSessionId(ctx) {
  const value = ctx?.sessionId ?? ctx?.sessionManager?.getSessionId?.();
  return typeof value === "string" && value ? value : undefined;
}

function readActiveAgentName(systemPrompt) {
  if (typeof systemPrompt !== "string") return undefined;
  const match = /<active_agent\s+name=["']([^"']+)["'][^>]*>/i.exec(systemPrompt);
  const name = match?.[1]?.trim();
  return name || undefined;
}

function readActiveAgentNameFromContext(ctx) {
  const entries = ctx?.sessionManager?.getEntries?.();
  if (!Array.isArray(entries)) return undefined;
  for (const entry of entries.slice().reverse()) {
    if (entry?.type !== "custom" || entry.customType !== "active_agent") continue;
    const name = entry.data?.name;
    if (typeof name === "string" && name.trim()) return name.trim();
  }
  return undefined;
}

function readActiveAgentNameFromManager(sessionManager) {
  return readActiveAgentNameFromContext({ sessionManager });
}

function validateAction(action) {
  if (action !== "diff" && action !== "log") throw new Error("Unsupported git_read action; expected diff or log.");
  return action;
}

function validateArguments(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 128) throw new Error("Invalid git_read args; expected at most 128 argv strings.");
  return value.map((argument) => {
    if (typeof argument !== "string" || argument.length === 0 || argument.length > 4096 || /[\0\r\n]/.test(argument)) {
      throw new Error("Invalid git_read argument.");
    }
    const normalized = argument.toLowerCase();
    const flag = normalized.split("=", 1)[0];
    if (blockedArguments.some((blocked) => flag === blocked || (flag.length >= 5 && blocked.startsWith(flag)))) {
      throw new Error(`git_read argument is not allowed: ${argument}`);
    }
    if (argument.includes("%G")) throw new Error(`git_read signature formatter is not allowed: ${argument}`);
    if (argument.startsWith("/") || argument.startsWith("\\") || /^[a-z]:[\\/]/i.test(argument) || argument.split(/[\\/]/).includes("..")) {
      throw new Error(`git_read external path is not allowed: ${argument}`);
    }
    return argument;
  });
}

function gitEnvironment(source) {
  const environment = {};
  for (const key of ["PATH", "PATHEXT", "SYSTEMROOT", "SystemRoot", "COMSPEC", "ComSpec", "WINDIR", "windir", "HOME", "USERPROFILE", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE"]) {
    if (source[key] !== undefined) environment[key] = source[key];
  }
  return {
    ...environment,
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    PAGER: "cat",
  };
}

function runGit(file, args, options) {
  return new Promise((resolve, reject) => {
    nodeExecFile(file, args, { ...options, encoding: "utf8", maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout, stderr });
    });
  });
}

function truncate(value) {
  const limit = 50 * 1024;
  return Buffer.byteLength(value, "utf8") <= limit ? value : `${Buffer.from(value).subarray(0, limit).toString("utf8")}\n[output truncated]`;
}

export default createGitReadExtension();
