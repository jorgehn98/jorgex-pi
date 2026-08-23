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

export function createGitReadExtension({ execFile = runGit } = {}) {
  return function gitReadExtension(pi) {
    pi.registerTool({
      name: "git_read",
      label: "Git read",
      description: "Inspect repository history or changes with shell-free git diff/git log argv. This tool cannot write output files or compare arbitrary external paths.",
      parameters,
      async execute(_toolCallId, input, signal, _onUpdate, ctx) {
        const action = validateAction(input?.action);
        const args = validateArguments(input?.args);
        const fixed = ["--no-pager", "-c", "core.fsmonitor=false", action, "--no-ext-diff", "--no-textconv"];
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
    GIT_CONFIG_GLOBAL: devNull,
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
