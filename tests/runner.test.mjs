import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  copyFileSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(testDir, "..");
const expected = readJson(join(testDir, "fixtures", "runner.expected.json"));
const runnerEntry = join(root, expected.entrypoint);

test("the package exposes one versioned JSON-only runner contract", () => {
  const manifest = readJson(join(root, "package.json"));
  const packageContract = readJson(join(root, "contract", "jorgex-pi.v1.json"));
  const runnerContractPath = join(root, "contract", "runner.v1.json");
  const responseSchemaPath = join(root, "contract", "schemas", "runner-response.v1.schema.json");

  assert.deepEqual(manifest.bin, { [expected.binName]: `./${expected.entrypoint}` });
  assert.ok(manifest.files.includes("bin"), "the published package must include its runner entrypoint");
  assert.ok(existsSync(runnerEntry), "the package-local runner entrypoint must exist");
  assert.ok(existsSync(runnerContractPath), "the public runner contract must be packaged");
  assert.ok(existsSync(responseSchemaPath), "the versioned response schema must be packaged");

  const runnerContract = readJson(runnerContractPath);
  assert.equal(runnerContract.schemaVersion, expected.schemaVersion);
  assert.equal(runnerContract.protocolVersion, expected.schemaVersion);
  assert.equal(runnerContract.bin, expected.binName);
  assert.equal(runnerContract.entrypoint, expected.entrypoint);
  assert.deepEqual(runnerContract.commands, expected.commands);
  assert.deepEqual(runnerContract.exitCodes, expected.exitCodes);
  assert.deepEqual(runnerContract.stdout, {
    format: "json",
    records: 1,
    trailingNewline: true,
    maxBytes: expected.maxStdoutBytes,
  });
  assert.equal(runnerContract.responseSchema, "contract/schemas/runner-response.v1.schema.json");
  assert.equal(packageContract.runner?.contractPath, "contract/runner.v1.json");
  assert.equal(packageContract.schemas?.runnerResponse, runnerContract.responseSchema);

  const schema = readJson(responseSchemaPath);
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["schemaVersion", "command", "ok", "package", "result"]);
  assert.deepEqual(schema.properties?.command?.enum, [...expected.commands, expected.errorCommand]);
});

test("status, models, doctor, and usage use the bounded machine envelope and stable exits", () => {
  assert.ok(existsSync(runnerEntry), "runner production is required before exercising its public process boundary");
  const sandbox = createSandbox("protocol");
  try {
    const status = runRunner("status", sandbox.env, sandbox.project, ["--json"]);
    assert.equal(status.status, expected.exitCodes.success);
    assertEnvelope(status, "status");
    assert.equal(status.json.result.installation.state, "unregistered");
    assert.equal(status.json.result.engram.state, "missing");
    assert.equal(status.json.result.engram.ownership, "user");

    const models = runRunner("models", sandbox.env, sandbox.project);
    assert.equal(models.status, expected.exitCodes.success);
    assertEnvelope(models, "models");
    assert.deepEqual(models.json.result, expected.models);
    assert.doesNotMatch(JSON.stringify(models.json.result), /provider|modelId|fallback/i);

    const doctor = runRunner("doctor", sandbox.env, sandbox.project);
    assert.equal(doctor.status, expected.exitCodes.unhealthy, "missing required Engram must be observable as unhealthy");
    assertEnvelope(doctor, "doctor");
    assert.equal(doctor.json.ok, false);
    assert.equal(doctor.json.result.healthy, false);
    const engramCheck = doctor.json.result.checks.find(({ id }) => id === "engram");
    assert.equal(engramCheck?.status, "error");

    const usage = runRunner("not-a-command", sandbox.env, sandbox.project);
    assert.equal(usage.status, expected.exitCodes.usage);
    assertEnvelope(usage, expected.errorCommand);
    assert.equal(usage.json.ok, false);
    assert.equal(usage.json.error?.code, "USAGE");
  } finally {
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});

test("status recognizes one exact Pi registration without mutating foreign settings", () => {
  assert.ok(existsSync(runnerEntry), "runner production is required before exercising install-state detection");
  const sandbox = createSandbox("registration");
  const settingsPath = join(sandbox.agentDir, "settings.json");
  const source = "npm:jorgex-pi@0.0.0-development";
  const bytes = `${JSON.stringify({ packages: ["npm:foreign@1.0.0", source], foreign: { keep: true } }, null, 2)}\n`;
  writeFileSync(settingsPath, bytes);
  try {
    const status = runRunner("status", sandbox.env, sandbox.project);
    assert.equal(status.status, expected.exitCodes.success);
    assertEnvelope(status, "status");
    assert.equal(status.json.result.installation.state, "registered");
    assert.equal(status.json.result.installation.matches, 1);
    assert.equal(readFileSync(settingsPath, "utf8"), bytes);
  } finally {
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});

test("status resolves an absolute ENGRAM_BIN before an isolated PATH fallback without spawning it", () => {
  assert.ok(existsSync(runnerEntry), "runner production is required before exercising Engram discovery");
  const sandbox = createSandbox("engram-resolution");
  const explicitBin = join(sandbox.root, process.platform === "win32" ? "explicit-engram.exe" : "explicit-engram");
  const pathBin = join(sandbox.env.PATH, process.platform === "win32" ? "engram.exe" : "engram");
  createFakeExecutable(explicitBin);
  createFakeExecutable(pathBin);
  try {
    const explicit = runRunner("status", { ...sandbox.env, ENGRAM_BIN: explicitBin }, sandbox.project, ["--json"]);
    assert.equal(explicit.status, expected.exitCodes.success);
    assertEnvelope(explicit, "status");
    assert.deepEqual(
      { state: explicit.json.result.engram.state, source: explicit.json.result.engram.source },
      { state: "ready", source: "environment" },
    );
    const fallback = runRunner("status", sandbox.env, sandbox.project, ["--json"]);
    assert.equal(fallback.status, expected.exitCodes.success);
    assertEnvelope(fallback, "status");
    assert.deepEqual(
      { state: fallback.json.result.engram.state, source: fallback.json.result.engram.source },
      { state: "ready", source: "path" },
    );
  } finally {
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});

test("sync and cleanup remain ownership-safe idempotent no-ops while no external writes are declared", () => {
  assert.ok(existsSync(runnerEntry), "runner production is required before exercising its mutation boundary");
  const assets = readJson(join(root, "contract", "assets.v1.json"));
  assert.deepEqual(assets.managedExternalWrites, [], "PR06 sync and cleanup have no owned external mutation target");
  const sandbox = createSandbox("ownership");
  const sentinels = [
    [join(sandbox.agentDir, "settings.json"), '{"packages":["npm:foreign@1.0.0"],"keep":true}\n'],
    [join(sandbox.agentDir, "mcp.json"), '{"mcpServers":{"foreign":{"command":"keep"}}}\n'],
    [join(sandbox.home, ".engram", "engram.db"), "user-memory-must-survive\n"],
    [join(sandbox.xdgConfig, "pi", "foreign.json"), '{"keep":true}\n'],
    [join(sandbox.project, ".pi", "foreign.json"), '{"keep":true}\n'],
  ];
  for (const [path, bytes] of sentinels) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  }
  const before = digestRoots([sandbox.agentDir, sandbox.home, sandbox.xdgConfig, sandbox.project]);
  try {
    for (const command of ["sync", "sync", "cleanup", "cleanup"]) {
      const result = runRunner(command, sandbox.env, sandbox.project);
      assert.equal(result.status, expected.exitCodes.success);
      assertEnvelope(result, command);
      assert.deepEqual(result.json.result, { changed: false, actions: [] });
      assert.equal(digestRoots([sandbox.agentDir, sandbox.home, sandbox.xdgConfig, sandbox.project]), before);
    }
  } finally {
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});

function runRunner(command, env, cwd, args = []) {
  const result = spawnSync(process.execPath, [runnerEntry, command, ...args], {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
  });
  assert.equal(result.error, undefined, `runner process setup failed: ${result.error?.message ?? "unknown"}`);
  const record = { status: result.status, stdout: result.stdout, stderr: result.stderr };
  assertSingleJsonRecord(record);
  return { ...record, json: JSON.parse(result.stdout) };
}

function createFakeExecutable(path) {
  try {
    linkSync(process.execPath, path);
  } catch {
    copyFileSync(process.execPath, path);
  }
}

function assertEnvelope(result, command) {
  assertSingleJsonRecord(result);
  const json = result.json ?? JSON.parse(result.stdout);
  assert.equal(json.schemaVersion, expected.schemaVersion);
  assert.equal(json.command, command);
  assert.equal(typeof json.ok, "boolean");
  assert.equal(json.package?.name, "jorgex-pi");
  assert.equal(json.package?.version, "0.0.0-development");
  assert.equal(typeof json.package?.root, "string");
  assert.ok(json.result && typeof json.result === "object" && !Array.isArray(json.result));
}

function assertSingleJsonRecord(result) {
  assert.equal(result.stderr, "", "machine commands must not leak banners or companion logs to stderr");
  assert.ok(Buffer.byteLength(result.stdout) <= expected.maxStdoutBytes, "stdout must remain bounded");
  assert.match(result.stdout, /^\{[^\n]*\}\n$/, "stdout must contain exactly one compact JSON object and one LF");
  assert.doesNotThrow(() => JSON.parse(result.stdout));
}

function createSandbox(label) {
  const rootDir = mkdtempSync(join(tmpdir(), `jorgex-pi-runner-${label}-`));
  const home = join(rootDir, "home");
  const agentDir = join(rootDir, "agent");
  const xdgConfig = join(rootDir, "xdg-config");
  const project = join(rootDir, "project");
  const isolatedBin = join(rootDir, "bin");
  for (const path of [home, agentDir, xdgConfig, project, isolatedBin]) mkdirSync(path, { recursive: true });
  return {
    root: rootDir,
    home,
    agentDir,
    xdgConfig,
    project,
    env: {
      ...allowedHostEnv(),
      PATH: isolatedBin,
      HOME: home,
      PI_CODING_AGENT_DIR: agentDir,
      XDG_CACHE_HOME: join(rootDir, "xdg-cache"),
      XDG_CONFIG_HOME: xdgConfig,
      XDG_DATA_HOME: join(rootDir, "xdg-data"),
      TEMP: join(rootDir, "tmp"),
      TMP: join(rootDir, "tmp"),
      TMPDIR: join(rootDir, "tmp"),
      NO_COLOR: "1",
    },
  };
}

function allowedHostEnv() {
  const env = {};
  for (const key of ["PATHEXT", "SYSTEMROOT", "SystemRoot", "COMSPEC", "ComSpec", "WINDIR", "windir"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

function digestRoots(roots) {
  const hash = createHash("sha256");
  for (const rootDir of roots) {
    hash.update(rootDir);
    visit(rootDir, rootDir, hash);
  }
  return hash.digest("hex");
}

function visit(rootDir, dir, hash) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    const rel = relative(rootDir, path).replaceAll("\\", "/");
    const stat = statSync(path);
    hash.update(rel);
    hash.update(stat.isDirectory() ? "dir" : readFileSync(path));
    if (stat.isDirectory()) visit(rootDir, path, hash);
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
