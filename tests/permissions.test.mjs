import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(testDir, "..");
const runnerEntry = join(root, "bin", "jorgex-pi.mjs");
const permissionConfigRelativePath = join("extensions", "pi-permission-system", "config.json");
const permissionReceiptRelativePath = join("jorgex-pi", "permissions-lifecycle.v1.json");

test("permission lifecycle seeds only an absent config and never reseeds after user ownership changes", () => {
  const sandbox = createSandbox("permission-absent-only");
  const permissionPath = join(sandbox.agentDir, permissionConfigRelativePath);
  const receiptPath = join(sandbox.agentDir, permissionReceiptRelativePath);
  try {
    const first = runRunner("sync", sandbox);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(existsSync(permissionPath), true, "sync must seed the managed permission policy when its file is absent");
    assert.equal(existsSync(receiptPath), true, "sync must persist a private permission lifecycle receipt");

    const firstConfig = readFileSync(permissionPath, "utf8");
    const firstReceipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    const firstPolicy = JSON.parse(firstConfig);
    assert.equal(firstReceipt.schemaVersion, 1);
    assert.equal(firstReceipt.initialized, true);
    assert.equal(firstPolicy.permission["*"], "ask", "the generated Pi policy must retain the conservative fallback");
    assert.equal(firstPolicy.permission.path["*.env"], "deny", "the generated Pi policy must protect env files through the transversal path gate");
    assert.equal(firstPolicy.permission.git_read, "allow", "the dedicated validated Git reader must be allowed at its tool gate");
    assert.doesNotMatch(firstConfig, /(?:sk-[A-Za-z0-9]|ghp_[A-Za-z0-9]|BEGIN (?:RSA|OPENSSH) PRIVATE KEY)/, "permission config must not contain credentials");

    const second = runRunner("sync", sandbox);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(readFileSync(permissionPath, "utf8"), firstConfig, "repeated sync must be byte-idempotent");
    assert.equal(readFileSync(receiptPath, "utf8"), JSON.stringify(firstReceipt, null, 2) + "\n", "repeated sync must not rewrite ownership state");

    const userConfig = JSON.parse(firstConfig);
    userConfig.permission["*"] = "deny";
    const userBytes = `${JSON.stringify(userConfig, null, 2)}\n`;
    writeFileSync(permissionPath, userBytes);
    const afterUserChange = runRunner("sync", sandbox);
    assert.equal(afterUserChange.status, 0, afterUserChange.stderr);
    assert.equal(readFileSync(permissionPath, "utf8"), userBytes, "sync must release ownership instead of reimposing a user-edited policy");

    rmSync(permissionPath);
    const afterUserDelete = runRunner("sync", sandbox);
    assert.equal(afterUserDelete.status, 0, afterUserDelete.stderr);
    assert.equal(existsSync(permissionPath), false, "a receipt must prevent reseeding after the user deletes a previously managed policy");
  } finally {
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});

test("an uninitialized permission receipt fails closed without reseeding or rewriting state", () => {
  const sandbox = createSandbox("permission-uninitialized-receipt");
  const permissionPath = join(sandbox.agentDir, permissionConfigRelativePath);
  const receiptPath = join(sandbox.agentDir, permissionReceiptRelativePath);
  const receiptBytes = JSON.stringify({ schemaVersion: 1, initialized: false }, null, 2) + "\n";
  mkdirSync(dirname(receiptPath), { recursive: true });
  writeFileSync(receiptPath, receiptBytes);
  try {
    const result = runRunner("sync", sandbox);
    assert.notEqual(result.status, 0, "an uninitialized permission receipt must fail closed");
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false);
    assert.equal(existsSync(permissionPath), false, "a rejected receipt must not trigger default permission seeding");
    assert.equal(readFileSync(receiptPath, "utf8"), receiptBytes, "a rejected receipt must remain byte-identical");
  } finally {
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});

test("preexisting empty permission config remains untouched while initialization is recorded", () => {
  const sandbox = createSandbox("permission-empty-preexisting");
  const permissionPath = join(sandbox.agentDir, permissionConfigRelativePath);
  const receiptPath = join(sandbox.agentDir, permissionReceiptRelativePath);
  const bytes = "{}\n";
  mkdirSync(dirname(permissionPath), { recursive: true });
  writeFileSync(permissionPath, bytes);
  try {
    const result = runRunner("sync", sandbox);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(permissionPath, "utf8"), bytes, "an empty preexisting file is user state and must not be rewritten");
    assert.equal(existsSync(receiptPath), true, "the lifecycle must remember that the preexisting file was observed");
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    assert.equal(receipt.schemaVersion, 1);
    assert.equal(receipt.initialized, true);
    assert.deepEqual(receipt.owned ?? receipt.files ?? {}, {}, "preexisting empty config must not be claimed as owned");
  } finally {
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});

test("permission cleanup removes only an owned fresh config and keeps foreign files beside it", () => {
  const sandbox = createSandbox("permission-cleanup-owned");
  const permissionPath = join(sandbox.agentDir, permissionConfigRelativePath);
  const receiptPath = join(sandbox.agentDir, permissionReceiptRelativePath);
  const foreignPath = join(dirname(permissionPath), "user-note.json");
  try {
    const sync = runRunner("sync", sandbox);
    assert.equal(sync.status, 0, sync.stderr);
    assert.equal(existsSync(permissionPath), true);
    assert.equal(existsSync(receiptPath), true);
    const foreignBytes = "{\"owner\":\"user\",\"keep\":true}\n";
    writeFileSync(foreignPath, foreignBytes);

    const cleanup = runRunner("cleanup", sandbox);
    assert.equal(cleanup.status, 0, cleanup.stderr);
    assert.equal(existsSync(permissionPath), false, "cleanup must remove the fresh config owned by JorgeX");
    assert.equal(existsSync(receiptPath), false, "cleanup must remove its empty lifecycle receipt");
    assert.equal(readFileSync(foreignPath, "utf8"), foreignBytes, "cleanup must preserve an unrelated sibling file");
  } finally {
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});

test("permission cleanup preserves a preexisting policy and an invalid policy fails closed", () => {
  const preserved = createSandbox("permission-cleanup-preexisting");
  const preservedPath = join(preserved.agentDir, permissionConfigRelativePath);
  const preservedBytes = `${JSON.stringify({ permission: { "*": "deny" }, foreign: { keep: true } }, null, 2)}\n`;
  mkdirSync(dirname(preservedPath), { recursive: true });
  writeFileSync(preservedPath, preservedBytes);
  try {
    const sync = runRunner("sync", preserved);
    assert.equal(sync.status, 0, sync.stderr);
    assert.equal(readFileSync(preservedPath, "utf8"), preservedBytes, "sync must not merge into a preexisting permission policy");
    const cleanup = runRunner("cleanup", preserved);
    assert.equal(cleanup.status, 0, cleanup.stderr);
    assert.equal(readFileSync(preservedPath, "utf8"), preservedBytes, "cleanup must preserve a policy it did not create");
  } finally {
    rmSync(preserved.root, { recursive: true, force: true });
  }

  const invalid = createSandbox("permission-invalid");
  const invalidPath = join(invalid.agentDir, permissionConfigRelativePath);
  const invalidReceiptPath = join(invalid.agentDir, permissionReceiptRelativePath);
  const invalidBytes = "{invalid json\n";
  mkdirSync(dirname(invalidPath), { recursive: true });
  writeFileSync(invalidPath, invalidBytes);
  try {
    const sync = runRunner("sync", invalid);
    assert.equal(sync.status, 0, sync.stderr);
    assert.equal(readFileSync(invalidPath, "utf8"), invalidBytes, "invalid user policy must remain byte-identical");
    assert.equal(existsSync(invalidReceiptPath), true, "an invalid first visit must still record initialization to prevent later reseeding");
    const invalidReceipt = readJson(invalidReceiptPath);
    assert.equal(invalidReceipt.initialized, true);
    assert.equal(invalidReceipt.owned, undefined, "an invalid preexisting config must never be claimed");
    for (const command of ["status", "doctor"]) {
      const diagnosis = runRunner(command, invalid);
      assert.notEqual(diagnosis.status, 0, `${command} must diagnose the invalid permission config`);
      const json = JSON.parse(diagnosis.stdout);
      assert.equal(json.ok, false);
      if (command === "status") assert.equal(json.error.phase, "permissions");
      else assert.equal(json.result.checks.find(({ id }) => id === "permissions")?.status, "error");
    }
    rmSync(invalidPath);
    const afterDelete = runRunner("sync", invalid);
    assert.equal(afterDelete.status, 0, afterDelete.stderr);
    assert.equal(existsSync(invalidPath), false, "deleting an invalid preexisting file must not trigger a later default reseed");
  } finally {
    rmSync(invalid.root, { recursive: true, force: true });
  }
});

test("permission sync fails closed when the config path is occupied by a directory", () => {
  const sandbox = createSandbox("permission-config-collision");
  const permissionPath = join(sandbox.agentDir, permissionConfigRelativePath);
  mkdirSync(permissionPath, { recursive: true });
  const marker = join(permissionPath, "user-owned.json");
  const markerBytes = "{\"keep\":true}\n";
  writeFileSync(marker, markerBytes);
  try {
    const result = runRunner("sync", sandbox);
    assert.notEqual(result.status, 0, "a non-file collision must fail closed instead of replacing user state");
    assert.equal(existsSync(permissionPath), true);
    assert.equal(readFileSync(marker, "utf8"), markerBytes, "a config path collision must preserve its contents");
  } finally {
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});

test("permission cleanup fails closed when an owned parent is replaced by an external symlink", {
  skip: process.platform === "win32" ? "native symlink support is not reliable in the Windows fixture" : false,
}, async (t) => {
  for (const [label, parentName] of [
    ["config-parent", "extensions"],
    ["receipt-parent", "jorgex-pi"],
  ]) {
    await t.test(label, () => {
      const sandbox = createSandbox("permission-external-symlink-" + label);
      const parentPath = join(sandbox.agentDir, parentName);
      const permissionPath = join(sandbox.agentDir, permissionConfigRelativePath);
      const receiptPath = join(sandbox.agentDir, permissionReceiptRelativePath);
      const externalRoot = join(sandbox.root, "external-" + label);
      try {
        const sync = runRunner("sync", sandbox);
        assert.equal(sync.status, 0, sync.stderr);
        const configBytes = readFileSync(permissionPath);
        const receiptBytes = readFileSync(receiptPath, "utf8");

        renameSync(parentPath, externalRoot);
        symlinkSync(externalRoot, parentPath);

        const preservedConfigPath = parentName === "extensions"
          ? join(externalRoot, "pi-permission-system", "config.json")
          : permissionPath;
        const preservedReceiptPath = parentName === "jorgex-pi"
          ? join(externalRoot, "permissions-lifecycle.v1.json")
          : receiptPath;
        const cleanup = runRunner("cleanup", sandbox);
        assert.notEqual(cleanup.status, 0, "cleanup must fail closed instead of deleting through an external symlink");
        const output = JSON.parse(cleanup.stdout);
        assert.equal(output.ok, false);
        assert.equal(readFileSync(preservedConfigPath).equals(configBytes), true, "cleanup must preserve the config bytes");
        assert.equal(readFileSync(preservedReceiptPath, "utf8"), receiptBytes, "cleanup must preserve the ownership receipt");
        assert.equal(lstatSync(parentPath).isSymbolicLink(), true, "cleanup must preserve the external symlink");
      } finally {
        rmSync(sandbox.root, { recursive: true, force: true });
      }
    });
  }
});

test("real Pi permission pipeline applies path policy to the nonstandard git_read input", () => {
  assert.equal(readJson(join(root, "node_modules", "@earendil-works", "pi-coding-agent", "package.json")).version, "0.84.2", "the local native pipeline fixture must use the exact supported Pi 0.84.2 SDK");
  const sandbox = createSandbox("permission-pipeline");
  const configPath = join(sandbox.agentDir, permissionConfigRelativePath);
  const projectConfigPath = join(sandbox.cwd, ".pi", "extensions", "pi-permission-system", "config.json");
  const agentPolicyPath = join(sandbox.agentDir, "agents", "restricted-agent.md");
  mkdirSync(dirname(configPath), { recursive: true });
  mkdirSync(dirname(projectConfigPath), { recursive: true });
  mkdirSync(dirname(agentPolicyPath), { recursive: true });
  writeJson(configPath, {
    permission: {
      "*": "ask",
      git_read: "allow",
      read: "allow",
      known_tool: "allow",
      mcp: {
        "*": "ask",
        "context7_*": "allow",
        "context7:*": "allow",
      },
      bash: {
        "*": "ask",
        "echo *": "allow",
        "printf *": "ask",
        "rm *": "deny",
      },
      path: {
        "*": "allow",
        "*.env": "deny",
        "*.env.*": "deny",
        "*.env.example": "allow",
      },
    },
  });
  writeJson(projectConfigPath, { permission: { path: { "docs/*": "ask" } } });
  writeFileSync(agentPolicyPath, "---\npermission:\n  path:\n    src/*: deny\n---\n");
  try {
    const output = runPermissionFixture(sandbox);
    assert.deepEqual(output.toolNames, ["bash", "edit", "git_read", "known_tool", "mcp", "read", "unclassified_tool"]);
    assert.equal(output.toolPermission, "allow");
    assert.equal(output.serviceCheck.state, "deny", "the real public service must see the transversal env-file deny");
    assert.equal(output.calls.knownTool?.block, undefined, "an explicitly allowed known tool must pass the native tool gate");
    assert.equal(output.calls.unknownPolicyTool?.block, true, "an unclassified registered tool must use the conservative ask fallback");
    assert.equal(output.calls.mcpKnown?.block, undefined, "a registered Context7 MCP target must pass its explicit namespace rule");
    assert.equal(output.calls.mcpUnknown?.block, true, "an unknown MCP target must remain ask-gated");
    assert.equal(output.calls.bashOrdinary?.block, undefined, "ordinary Bash must be allowed");
    assert.equal(output.calls.bashAsk?.block, true, "a Bash command covered by ask must remain subject to approval");
    assert.equal(output.calls.bashDeny?.block, true, "a Bash command covered by deny must be blocked");
    assert.equal(output.calls.bashCompound?.block, true, "a compound Bash command must retain its restrictive unit");
    assert.equal(output.calls.ordinary?.block, undefined, "an ordinary repository path must pass the native permission pipeline");
    assert.equal(output.calls.secret?.block, true, "git_read must not bypass a path deny because its path lives in args");
    assert.equal(output.calls.multiple?.block, true, "one protected path must dominate a multi-argument git_read request");
    assert.equal(output.calls.example?.block, undefined, ".env.example remains the explicit non-secret exception");
    assert.equal(output.calls.askPath?.block, true, "a project path ask must remain an approval boundary for git_read");
    assert.equal(output.agentOverride?.block, true, "an active agent frontmatter deny must override the global path allow");
    assert.equal(output.projectOverride?.block, true, "a trusted project path ask must remain an approval boundary");
    assert.ok(output.decisions.some((event) => event.surface === "path" && event.result === "deny"), "the denial must be emitted by the native path gate");
    assert.ok(
      output.decisions.some((event) => event.surface === "path" && event.value === "src/index.ts" && event.agentName === "restricted-agent" && event.resolution === "policy_deny"),
      "multi-path extraction must evaluate the most restrictive path with the active agent policy",
    );
    assert.ok(
      output.decisions.some((event) => event.surface === "path" && event.value === "docs/guide.md" && event.resolution === "confirmation_unavailable"),
      "a git_read path ask must reach the native approval path instead of being silently allowed",
    );
    assert.ok(output.decisions.some((event) => event.surface === "bash" && event.result === "deny"), "Bash policy decisions must be emitted by the native gate");
  } finally {
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});

test("sync-seeded permission asset is enforced by the same native pipeline", () => {
  assert.equal(readJson(join(root, "node_modules", "@earendil-works", "pi-coding-agent", "package.json")).version, "0.84.2", "the canonical asset fixture must use the exact supported Pi 0.84.2 SDK");
  const sandbox = createSandbox("permission-canonical-asset");
  const permissionPath = join(sandbox.agentDir, permissionConfigRelativePath);
  try {
    const sync = runRunner("sync", sandbox);
    assert.equal(sync.status, 0, sync.stderr);
    assert.equal(existsSync(permissionPath), true, "sync must materialize the permission asset before the native pipeline loads it");
    const seededPolicy = readJson(permissionPath);
    assert.equal(seededPolicy.permission.bash["*"], "allow");
    assert.equal(seededPolicy.permission.mcp["engram_*"], "allow");

    const output = runPermissionFixture(sandbox, undefined, { canonical: true });
    assert.deepEqual(output.toolNames, ["bash", "edit", "git_read", "known_tool", "mcp", "read", "unclassified_tool"]);
    assert.equal(output.canonicalCalls.bashOrdinary?.block, undefined, "the seeded policy must allow ordinary Bash");
    for (const name of ["bashRemove", "bashReset", "bashForcePush", "bashSudo"]) {
      assert.equal(output.canonicalCalls[name]?.block, true, `${name} must remain ask-gated by the seeded policy`);
    }
    for (const name of ["bashSecret", "bashMkfs", "bashDd"]) {
      assert.equal(output.canonicalCalls[name]?.block, true, `${name} must be denied by the seeded policy`);
    }
    assert.equal(output.canonicalCalls.readInside?.block, undefined, "the seeded policy must allow ordinary reads");
    assert.equal(output.canonicalCalls.readOutside?.block, undefined, "the seeded policy must allow ordinary external reads");
    assert.equal(output.canonicalCalls.editInside?.block, undefined, "the seeded policy must allow ordinary edits");
    assert.equal(output.canonicalCalls.mcpEngram?.block, undefined, "the seeded policy must allow known Engram MCP targets");
    assert.equal(output.canonicalCalls.mcpContext7?.block, undefined, "the seeded policy must allow known Context7 MCP targets");
    assert.equal(output.canonicalCalls.mcpUnknown?.block, true, "the seeded policy must ask for unknown MCP targets");

    const denyDecisions = output.decisions.filter((event) => event.result === "deny");
    assert.ok(denyDecisions.some((event) => event.surface === "bash" && event.resolution === "confirmation_unavailable"), "seeded ask rules must retain the native approval path");
    assert.ok(denyDecisions.some((event) => event.surface === "bash" && event.resolution === "policy_deny"), "seeded deny rules must remain hard denials");
  } finally {
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});

const configuredPi085SdkRoot = process.env.JORGEX_PI_SDK_ROOT?.trim();
test("the same permission pipeline runs on the exact Pi 0.85.1 SDK", { skip: configuredPi085SdkRoot ? false : "set JORGEX_PI_SDK_ROOT to the exact Pi 0.85.1 package root" }, () => {
  const sandbox = createSandbox("permission-pipeline-pi085");
  const configPath = join(sandbox.agentDir, permissionConfigRelativePath);
  mkdirSync(dirname(configPath), { recursive: true });
  writeJson(configPath, {
    permission: {
      "*": "ask",
      git_read: "allow",
      path: { "*": "allow", "*.env": "deny", "*.env.*": "deny", "*.env.example": "allow" },
    },
  });
  try {
    const manifest = readJson(join(configuredPi085SdkRoot, "package.json"));
    assert.equal(manifest.version, "0.85.1", "the compatibility fixture must use the exact supported Pi 0.85.1 SDK");
    const output = runPermissionFixture(sandbox, configuredPi085SdkRoot);
    assert.equal(output.serviceCheck.state, "deny");
    assert.equal(output.calls.secret?.block, true, "Pi 0.85.1 must retain the transversal path deny");
    assert.equal(output.calls.multiple?.block, true, "Pi 0.85.1 must retain the multi-argument path deny");
  } finally {
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});

test("git_read fails closed before invoking Git when the permission service is absent", () => {
  const sandbox = createSandbox("git-read-without-permission");
  const fakeBinDir = join(sandbox.root, "bin");
  const marker = join(sandbox.root, "git-invoked");
  mkdirSync(fakeBinDir, { recursive: true });
  const fakeGit = join(fakeBinDir, process.platform === "win32" ? "git.cmd" : "git");
  writeFileSync(fakeGit, process.platform === "win32"
    ? `@echo invoked>${marker}\r\n`
    : `#!/bin/sh\nprintf invoked > "$JORGEX_GIT_MARKER"\n`);
  if (process.platform !== "win32") {
    // The fixture only needs a deterministic executable ahead of the host PATH.
    chmodSync(fakeGit, 0o755);
  }
  const env = { ...sandbox.env, PATH: fakeBinDir, JORGEX_GIT_MARKER: marker };
  try {
    const result = spawnSync(process.execPath, [join(testDir, "fixtures", "load-git-read-without-permission.mjs"), root], {
      cwd: sandbox.cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const output = JSON.parse(result.stdout);
    assert.match(output.error ?? "", /permission|service|unavailable|fail-closed/i, "missing permission service must be diagnosed before Git execution");
    assert.equal(existsSync(marker), false, "git_read must not invoke Git before the permission service is available");
  } finally {
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});

function createSandbox(label) {
  const rootDir = mkdtempSync(join(tmpdir(), `jorgex-pi-${label}-`));
  const agentDir = join(rootDir, "agent");
  const home = join(rootDir, "home");
  const cwd = join(rootDir, "workspace");
  for (const path of [agentDir, home, cwd, join(rootDir, "xdg-config"), join(rootDir, "xdg-cache"), join(rootDir, "xdg-data")]) {
    mkdirSync(path, { recursive: true });
  }
  return {
    root: rootDir,
    agentDir,
    cwd,
    env: {
      ...allowedHostEnv(),
      HOME: home,
      USERPROFILE: home,
      PI_CODING_AGENT_DIR: agentDir,
      XDG_CONFIG_HOME: join(rootDir, "xdg-config"),
      XDG_CACHE_HOME: join(rootDir, "xdg-cache"),
      XDG_DATA_HOME: join(rootDir, "xdg-data"),
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
      NO_COLOR: "1",
    },
  };
}

function runRunner(command, sandbox) {
  return spawnSync(process.execPath, [runnerEntry, command, "--json"], {
    cwd: sandbox.cwd,
    env: sandbox.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
}

function runPermissionFixture(sandbox, sdkRoot, { canonical = false } = {}) {
  const result = spawnSync(process.execPath, [join(testDir, "fixtures", "load-permissions-with-pi.mjs"), root], {
    cwd: sandbox.cwd,
    env: {
      ...sandbox.env,
      ...(sdkRoot ? { JORGEX_PI_SDK_ROOT: sdkRoot } : {}),
      ...(canonical ? { JORGEX_PERMISSION_FIXTURE_CANONICAL: "1" } : {}),
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout);
}

function allowedHostEnv() {
  const result = {};
  for (const key of ["PATH", "PATHEXT", "SYSTEMROOT", "SystemRoot", "COMSPEC", "ComSpec", "WINDIR", "windir"]) {
    if (process.env[key] !== undefined) result[key] = process.env[key];
  }
  return result;
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
