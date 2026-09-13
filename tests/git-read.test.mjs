import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { devNull } from "node:os";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

let extensionImportCounter = 0;
const testDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(testDir, "..");

test("git_read uses shell-free fixed argv and rejects unsafe git options before execution", async () => {
  const calls = [];
  const extractorRegistrations = [];
  const permissionService = {
    registerToolAccessExtractor(toolName, extractor) {
      extractorRegistrations.push({ toolName, extractor });
      return () => {};
    },
  };
  const permissionEvents = createPermissionEventHarness();
  const permissionApi = loadPermissionPublicApi();
  permissionApi.publishPermissionsService("unit-session", permissionService);
  const { createGitReadExtension } = loadGitReadModule();
  const extension = await createGitReadExtension({
    execFile: async (file, args, options) => {
      calls.push({ file, args, options });
      return { stdout: "reviewed output\n", stderr: "" };
    },
  });
  const registered = [];
  await extension({ registerTool: (tool) => registered.push(tool), events: permissionEvents });
  await permissionEvents.emit("permissions:ready", { sessionId: "unit-session" });
  assert.equal(registered.length, 1);
  const [tool] = registered;
  assert.equal(tool.name, "git_read");
  assert.deepEqual(extractorRegistrations.map(({ toolName }) => toolName), ["git_read"]);

  const signal = new AbortController().signal;
  const result = await tool.execute("diff-call", { action: "diff", args: ["--stat", "HEAD~1", "HEAD"] }, signal, undefined, { cwd: "/workspace" });
  assert.deepEqual(calls.shift(), {
    file: "git",
    args: ["--no-pager", "-c", "core.fsmonitor=false", "-c", "log.showSignature=false", "diff", "--no-ext-diff", "--no-textconv", "--stat", "HEAD~1", "HEAD"],
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
    args: ["--no-pager", "-c", "core.fsmonitor=false", "-c", "log.showSignature=false", "log", "--no-ext-diff", "--no-textconv", "-n", "5", "--oneline"],
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
  permissionApi.unpublishPermissionsService("unit-session", permissionService);
});

test("git_read ignores inherited Git redirection, signatures, and textconv helpers", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "jorgex-git-read-"));
  const workspace = join(sandbox, "workspace");
  const external = join(sandbox, "external");
  const helper = join(sandbox, "textconv.mjs");
  const marker = join(sandbox, "textconv-ran");
  const gpgMarker = join(sandbox, "gpg-ran");
  const fakeGpg = join(sandbox, process.platform === "win32" ? "gpg.cmd" : "gpg");
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
    const parent = gitOutput(workspace, ["rev-parse", "HEAD"]);
    writeFileSync(join(workspace, "note.txt"), "internal signed\n");
    git(workspace, ["add", "note.txt"]);
    const tree = gitOutput(workspace, ["write-tree"]);
    const signedCommit = gitObject(workspace, [
      "tree ${tree}",
      "parent ${parent}",
      "author JorgeX Test <test@example.invalid> 1700000000 +0000",
      "committer JorgeX Test <test@example.invalid> 1700000000 +0000",
      "gpgsig -----BEGIN PGP SIGNATURE-----",
      " fixture signature",
      " -----END PGP SIGNATURE-----",
      "",
      "SIGNED fixture",
      "",
    ].join("\n").replace("${tree}", tree).replace("${parent}", parent));
    git(workspace, ["checkout", "-q", "-B", "signed-fixture", signedCommit]);
    writeFileSync(fakeGpg, process.platform === "win32"
      ? `@echo invoked>${gpgMarker}\r\n`
      : `#!/bin/sh\nprintf invoked > ${JSON.stringify(gpgMarker)}\n`);
    if (process.platform !== "win32") chmodSync(fakeGpg, 0o755);
    git(workspace, ["config", "log.showSignature", "true"]);
    git(workspace, ["config", "gpg.program", fakeGpg]);
    const directGitEnv = { ...process.env };
    for (const key of ["GIT_DIR", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"]) delete directGitEnv[key];
    try {
      execFileSync("git", ["log", "-1", "--oneline"], { cwd: workspace, env: directGitEnv, stdio: "pipe" });
    } catch {
      // The fixture signature is intentionally synthetic; invocation is the contract under test.
    }
    assert.equal(existsSync(gpgMarker), true, "the local signature setting must exercise the fixture GPG program");
    rmSync(gpgMarker);
    writeFileSync(join(external, "note.txt"), "external\n");
    commitAll(external, "EXTERNAL");

    process.env.GIT_DIR = join(external, ".git");
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "core.pager";
    process.env.GIT_CONFIG_VALUE_0 = `node ${helper}`;

    const registered = [];
    const permissionService = { registerToolAccessExtractor() { return () => {}; } };
    const permissionApi = loadPermissionPublicApi();
    const sessionId = "git-read-real";
    permissionApi.publishPermissionsService(sessionId, permissionService);
    const permissionEvents = createPermissionEventHarness();
    const extension = await createDefaultExtension();
    await extension({ registerTool: (tool) => registered.push(tool), events: permissionEvents });
    await permissionEvents.emit("permissions:ready", { sessionId: "git-read-real" });
    const tool = registered[0];
    const patchResult = await tool.execute("patch", { action: "log", args: ["-p", "-1", "--oneline"] }, undefined, undefined, { cwd: workspace });
    assert.equal(existsSync(marker), false, "--no-textconv must keep repository helpers inert");
    assert.equal(existsSync(gpgMarker), false, "-c log.showSignature=false must keep local GPG helpers inert");
    assert.match(patchResult.content[0].text, /internal signed/i);
    assert.doesNotMatch(patchResult.content[0].text, /EXTERNAL/);
    permissionApi.unpublishPermissionsService(sessionId, permissionService);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(sandbox, { recursive: true, force: true });
  }
});

async function createDefaultExtension() {
  extensionImportCounter += 1;
  const module = loadGitReadModule(`?real=${Date.now()}-${extensionImportCounter}`);
  return module.createGitReadExtension();
}

function loadGitReadModule(suffix = "") {
  const jiti = createJiti(import.meta.url, { moduleCache: false });
  return jiti(`${join(root, "extensions", "git-read.ts")}${suffix}`);
}

function loadPermissionPublicApi() {
  const jiti = createJiti(import.meta.url, { moduleCache: false });
  return jiti("@gotgenes/pi-permission-system");
}

function createPermissionEventHarness() {
  const handlers = new Map();
  return {
    on(name, handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    async emit(name, payload) {
      for (const handler of handlers.get(name) ?? []) await handler(payload);
    },
  };
}

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function gitOutput(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
}

function gitObject(cwd, content) {
  return execFileSync("git", ["hash-object", "-t", "commit", "-w", "--stdin"], {
    cwd,
    input: content,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
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
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    PAGER: "cat",
  };
}
