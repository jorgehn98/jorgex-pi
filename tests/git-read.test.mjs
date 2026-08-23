import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { devNull } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("git_read uses shell-free fixed argv and rejects unsafe git options before execution", async () => {
  const { createGitReadExtension } = await import("../extensions/git-read.ts");
  const calls = [];
  const extension = createGitReadExtension({
    execFile: async (file, args, options) => {
      calls.push({ file, args, options });
      return { stdout: "reviewed output\n", stderr: "" };
    },
  });
  const registered = [];
  extension({ registerTool: (tool) => registered.push(tool) });
  assert.equal(registered.length, 1);
  const [tool] = registered;
  assert.equal(tool.name, "git_read");

  const signal = new AbortController().signal;
  const result = await tool.execute("diff-call", { action: "diff", args: ["--stat", "HEAD~1", "HEAD"] }, signal, undefined, { cwd: "/workspace" });
  assert.deepEqual(calls.shift(), {
    file: "git",
    args: ["--no-pager", "-c", "core.fsmonitor=false", "diff", "--no-ext-diff", "--no-textconv", "--stat", "HEAD~1", "HEAD"],
    options: {
      cwd: "/workspace",
      env: assertSafeGitEnv(),
      signal,
    },
  });
  assert.match(result.content?.[0]?.text ?? "", /reviewed output/);

  await tool.execute("log-call", { action: "log", args: ["-n", "5", "--oneline"] }, undefined, undefined, { cwd: "/workspace" });
  assert.deepEqual(calls.shift(), {
    file: "git",
    args: ["--no-pager", "-c", "core.fsmonitor=false", "log", "--no-ext-diff", "--no-textconv", "-n", "5", "--oneline"],
    options: { cwd: "/workspace", env: assertSafeGitEnv() },
  });

  for (const input of [
    { action: "status", args: [] },
    { action: "diff", args: ["--output=result.txt"] },
    { action: "diff", args: ["--output", "result.txt"] },
    { action: "diff", args: ["--out=result.txt"] },
    { action: "diff", args: ["--no-index", "left", "right"] },
    { action: "diff", args: ["--no-i", "left", "right"] },
    { action: "diff", args: ["--ext-diff"] },
    { action: "log", args: ["--textconv"] },
    { action: "log", args: ["--paginate"] },
    { action: "log", args: ["--show-signature"] },
    { action: "log", args: ["--format=%h %G?"] },
    { action: "log", args: ["--config-env=diff.external=PAYLOAD"] },
  ]) {
    await assert.rejects(tool.execute("blocked", input, undefined, undefined, { cwd: "/workspace" }), /not allowed|unsupported|invalid/i);
  }
  assert.deepEqual(calls, [], "rejected inputs must never reach execFile");
});

test("git_read ignores inherited Git redirection and never runs repository textconv helpers", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "jorgex-git-read-"));
  const workspace = join(sandbox, "workspace");
  const external = join(sandbox, "external");
  const helper = join(sandbox, "textconv.mjs");
  const marker = join(sandbox, "textconv-ran");
  const previous = Object.fromEntries(["GIT_DIR", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"].map((key) => [key, process.env[key]]));
  try {
    for (const directory of [workspace, external]) {
      mkdirSync(directory, { recursive: true });
      git(directory, ["init", "-q"]);
    }
    writeFileSync(helper, `import { readFileSync, writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "ran\\n");\nprocess.stdout.write(readFileSync(process.argv.at(-1), "utf8"));\n`);
    writeFileSync(join(workspace, ".gitattributes"), "*.txt diff=evil\n");
    writeFileSync(join(workspace, "note.txt"), "internal one\n");
    git(workspace, ["config", "diff.evil.textconv", `node ${JSON.stringify(helper)}`]);
    commitAll(workspace, "INTERNAL first");
    writeFileSync(join(workspace, "note.txt"), "internal two\n");
    commitAll(workspace, "INTERNAL second");
    writeFileSync(join(external, "note.txt"), "external\n");
    commitAll(external, "EXTERNAL");

    process.env.GIT_DIR = join(external, ".git");
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "core.pager";
    process.env.GIT_CONFIG_VALUE_0 = `node ${helper}`;

    const registered = [];
    const extension = await createDefaultExtension();
    extension({ registerTool: (tool) => registered.push(tool) });
    const tool = registered[0];
    const patchResult = await tool.execute("patch", { action: "log", args: ["-p", "-1", "--oneline"] }, undefined, undefined, { cwd: workspace });
    assert.equal(existsSync(marker), false, "--no-textconv must keep repository helpers inert");
    assert.match(patchResult.content[0].text, /INTERNAL second/);
    assert.doesNotMatch(patchResult.content[0].text, /EXTERNAL/);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(sandbox, { recursive: true, force: true });
  }
});

async function createDefaultExtension() {
  return (await import(`../extensions/git-read.ts?real=${Date.now()}`)).default;
}

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function commitAll(cwd, message) {
  git(cwd, ["add", "."]);
  git(cwd, ["-c", "user.name=JorgeX Test", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", message]);
}

function assertSafeGitEnv() {
  return {
    ...Object.fromEntries(["PATH", "PATHEXT", "SYSTEMROOT", "SystemRoot", "COMSPEC", "ComSpec", "WINDIR", "windir", "HOME", "USERPROFILE", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE"]
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]])),
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    PAGER: "cat",
  };
}
