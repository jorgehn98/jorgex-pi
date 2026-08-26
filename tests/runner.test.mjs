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
const packageVersion = readJson(join(root, "package.json")).version;

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
  assert.ok(Array.isArray(schema.oneOf) && schema.oneOf.length >= 2, "schema must discriminate successful and error envelopes");
  assert.ok(schema.oneOf.some((branch) => branch.properties?.ok?.const === true), "schema must define the successful envelope");
  assert.ok(schema.oneOf.some((branch) => branch.properties?.ok?.const === false), "schema must require an error envelope when ok=false");
  assert.deepEqual(schema.$defs?.modelsResult?.required, ["mode", "primary", "tiers"]);
  assert.equal(schema.$defs?.modelsResult?.additionalProperties, false);
  assert.equal(schema.$defs?.primaryModel?.additionalProperties, false);
  assert.deepEqual(schema.$defs?.lifecycleResult?.required, ["changed", "actions"]);
  assert.equal(schema.$defs?.lifecycleResult?.additionalProperties, false);
  assert.equal(schema.$defs?.lifecycleResult?.properties?.actions?.maxItems, 9);
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
    assert.doesNotMatch(JSON.stringify(models.json.result), /fallback/i);

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
  const source = `npm:jorgex-pi@${packageVersion}`;
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

test("doctor requires both exact package registration and a ready Engram binary", () => {
  const sandbox = createSandbox("doctor-installation");
  const engramBin = join(sandbox.root, process.platform === "win32" ? "engram.exe" : "engram");
  createFakeExecutable(engramBin);
  try {
    const doctor = runRunner("doctor", { ...sandbox.env, ENGRAM_BIN: engramBin }, sandbox.project, ["--json"]);
    assert.equal(doctor.status, expected.exitCodes.unhealthy, "unregistered package must remain unhealthy even when Engram is ready");
    assert.equal(doctor.json.ok, false);
    assert.equal(doctor.json.result.checks.find(({ id }) => id === "package")?.status, "error");
  } finally {
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});

test("every invalid Pi settings shape retains a schema-valid stable diagnosis", async (t) => {
  const exactSource = `npm:jorgex-pi@${packageVersion}`;
  const cases = [
    ["invalid-json", "{invalid json\n"],
    ["root-array", "[]\n"],
    ["packages-non-array", '{"packages":{}}\n'],
    ["duplicate-exact", `${JSON.stringify({ packages: [exactSource, exactSource] })}\n`],
  ];
  for (const [label, bytes] of cases) {
    await t.test(label, () => {
      const sandbox = createSandbox(`invalid-settings-${label}`);
      const settingsPath = join(sandbox.agentDir, "settings.json");
      writeFileSync(settingsPath, bytes);
      try {
        const first = runRunner("status", sandbox.env, sandbox.project, ["--json"]);
        const second = runRunner("status", sandbox.env, sandbox.project, ["--json"]);
        for (const status of [first, second]) {
          assert.equal(status.status, expected.exitCodes.unhealthy, label);
          assert.equal(typeof status.json.error?.message, "string", `${label} must emit schema-required error.message`);
          assertEnvelope(status, "status");
          assert.equal(status.json.result.installation.state, "invalid", label);
          assert.equal(status.json.result.installation.path, settingsPath, label);
          assert.equal(typeof status.json.result.installation.reason, "string", label);
          assert.ok(status.json.result.installation.reason.length > 0, label);
          assert.equal(status.json.error.message, status.json.result.installation.reason, label);
          assert.match(status.json.error.remedy, /settings/i, label);
          assert.equal(status.json.error.remedy.includes(settingsPath), true, label);
        }
        assert.deepEqual(second.json, first.json, `${label} diagnosis must be stable across repeated reads`);
      } finally {
        rmSync(sandbox.root, { recursive: true, force: true });
      }
    });
  }
});

test("an unreadable package manifest still returns one JSON internal-error record", () => {
  const sandbox = createSandbox("bad-package-manifest");
  const packageRoot = join(sandbox.root, "package");
  mkdirSync(join(packageRoot, "bin"), { recursive: true });
  copyFileSync(runnerEntry, join(packageRoot, "bin", "jorgex-pi.mjs"));
  writeFileSync(join(packageRoot, "package.json"), "{invalid json\n");
  try {
    const result = spawnSync(process.execPath, [join(packageRoot, "bin", "jorgex-pi.mjs"), "status", "--json"], {
      cwd: sandbox.project,
      env: sandbox.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    });
    assert.equal(result.status, expected.exitCodes.internal);
    assertSingleJsonRecord(result);
    const json = JSON.parse(result.stdout);
    assert.equal(json.ok, false);
    assert.equal(json.error?.phase, "runner");
    assert.equal(json.error?.code, "INTERNAL");
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

test("Sol lifecycle sync and cleanup preserve field-level ownership at the runner boundary", async (t) => {
  await t.test("fresh sync writes exact Sol defaults once, preserves siblings, and cleanup removes its exact leaves", () => {
    const sandbox = createSandbox("sol-fresh");
    const settingsPath = join(sandbox.agentDir, "settings.json");
    const modelsPath = join(sandbox.agentDir, "models.json");
    const foreignSettings = { packages: ["npm:foreign@1.0.0"], foreign: { keep: true } };
    const foreignModels = {
      providers: {
        "openai-codex": {
          userOwned: { keep: true },
          modelOverrides: { "foreign-model": { contextWindow: 32_000 } },
        },
        foreign: { keep: true },
      },
      aliases: { keep: "foreign-model" },
    };
    writeJson(settingsPath, foreignSettings);
    writeJson(modelsPath, foreignModels);
    try {
      const first = runRunner("sync", sandbox.env, sandbox.project);
      assert.equal(first.status, expected.exitCodes.success);
      assertEnvelope(first, "sync");
      assert.equal(first.json.result.changed, true);

      const settingsAfterSync = readJson(settingsPath);
      const modelsAfterSync = readJson(modelsPath);
      assert.deepEqual(settingsAfterSync.foreign, foreignSettings.foreign, "sync must preserve foreign settings fields");
      assert.deepEqual(settingsAfterSync.packages, foreignSettings.packages, "sync must preserve foreign settings siblings");
      assert.equal(settingsAfterSync.defaultProvider, "openai-codex");
      assert.equal(settingsAfterSync.defaultModel, "gpt-5.6-sol");
      assert.deepEqual(modelsAfterSync.providers.foreign, foreignModels.providers.foreign, "sync must preserve foreign model providers");
      assert.deepEqual(modelsAfterSync.providers["openai-codex"].userOwned, foreignModels.providers["openai-codex"].userOwned);
      assert.deepEqual(
        modelsAfterSync.providers["openai-codex"].modelOverrides["foreign-model"],
        foreignModels.providers["openai-codex"].modelOverrides["foreign-model"],
      );
      assert.equal(modelsAfterSync.providers["openai-codex"].modelOverrides["gpt-5.6-sol"].contextWindow, 872_000);
      assert.equal("maxTokens" in modelsAfterSync.providers["openai-codex"].modelOverrides["gpt-5.6-sol"], false);

      const receiptPath = findReceiptPath(sandbox.agentDir);
      const afterFirstSync = digestRoots([sandbox.agentDir]);
      const second = runRunner("sync", sandbox.env, sandbox.project);
      assert.equal(second.status, expected.exitCodes.success);
      assertEnvelope(second, "sync");
      assert.equal(second.json.result.changed, false, "repeated sync must report no write");
      assert.equal(digestRoots([sandbox.agentDir]), afterFirstSync, "repeated sync must leave config and receipt byte-identical");

      const cleanup = runRunner("cleanup", sandbox.env, sandbox.project);
      assert.equal(cleanup.status, expected.exitCodes.success);
      assertEnvelope(cleanup, "cleanup");
      assert.equal(cleanup.json.result.changed, true);
      assert.deepEqual(readJson(settingsPath), foreignSettings, "cleanup must remove only settings leaves it created");
      assert.deepEqual(readJson(modelsPath), foreignModels, "cleanup must prune only empty containers it created");
      assert.equal(existsSync(receiptPath), false, "cleanup must remove an empty ownership receipt");

      const afterCleanup = digestRoots([sandbox.agentDir]);
      const repeatedCleanup = runRunner("cleanup", sandbox.env, sandbox.project);
      assert.equal(repeatedCleanup.status, expected.exitCodes.success);
      assertEnvelope(repeatedCleanup, "cleanup");
      assert.equal(repeatedCleanup.json.result.changed, false, "repeated cleanup must report no write");
      assert.equal(digestRoots([sandbox.agentDir]), afterCleanup, "repeated cleanup must be byte-idempotent");
    } finally {
      rmSync(sandbox.root, { recursive: true, force: true });
    }
  });

  await t.test("preexisting identical defaults remain unowned and survive cleanup", () => {
    const sandbox = createSandbox("sol-preexisting");
    const settingsPath = join(sandbox.agentDir, "settings.json");
    const modelsPath = join(sandbox.agentDir, "models.json");
    writeJson(settingsPath, {
      defaultProvider: "openai-codex",
      defaultModel: "gpt-5.6-sol",
      foreign: { keep: true },
    });
    writeJson(modelsPath, {
      providers: {
        "openai-codex": {
          modelOverrides: { "gpt-5.6-sol": { contextWindow: 872_000, maxTokens: 128_000 } },
          foreign: { keep: true },
        },
      },
    });
    const before = digestRoots([sandbox.agentDir]);
    try {
      const sync = runRunner("sync", sandbox.env, sandbox.project);
      assert.equal(sync.status, expected.exitCodes.success);
      assertEnvelope(sync, "sync");
      assert.equal(sync.json.result.changed, false, "sync must not claim preexisting identical leaves");
      assert.equal(receiptPaths(sandbox.agentDir).length, 0, "preexisting identical leaves must not create a receipt");

      const cleanup = runRunner("cleanup", sandbox.env, sandbox.project);
      assert.equal(cleanup.status, expected.exitCodes.success);
      assertEnvelope(cleanup, "cleanup");
      assert.equal(cleanup.json.result.changed, false, "cleanup must not remove unowned identical leaves");
      assert.equal(digestRoots([sandbox.agentDir]), before, "preexisting user config must remain byte-identical");
    } finally {
      rmSync(sandbox.root, { recursive: true, force: true });
    }
  });

  await t.test("provider and model defaults are managed as one compatible pair", async (t) => {
    await t.test("a foreign half prevents creating the incompatible Sol half", () => {
      for (const settings of [
        { defaultProvider: "foreign-provider" },
        { defaultModel: "foreign-model" },
      ]) {
        const sandbox = createSandbox("sol-foreign-half");
        const settingsPath = join(sandbox.agentDir, "settings.json");
        const modelsPath = join(sandbox.agentDir, "models.json");
        writeJson(settingsPath, settings);
        const before = digestRoots([sandbox.agentDir]);
        try {
          const sync = runRunner("sync", sandbox.env, sandbox.project);
          assert.equal(sync.status, expected.exitCodes.success);
          assertEnvelope(sync, "sync");
          assert.equal(sync.json.result.changed, false, "sync must not create a mismatched default half");
          assert.equal(digestRoots([sandbox.agentDir]), before, "foreign default halves and the absent models config must remain untouched");
          assert.equal(existsSync(modelsPath), false);
          assert.equal(receiptPaths(sandbox.agentDir).length, 0, "a skipped foreign pair must not leave an ownership receipt");
        } finally {
          rmSync(sandbox.root, { recursive: true, force: true });
        }
      }
    });

    await t.test("a matching Sol half is completed before its model override", () => {
      for (const settings of [
        { defaultProvider: "openai-codex" },
        { defaultModel: "gpt-5.6-sol" },
      ]) {
        const sandbox = createSandbox("sol-matching-half");
        const settingsPath = join(sandbox.agentDir, "settings.json");
        const modelsPath = join(sandbox.agentDir, "models.json");
        writeJson(settingsPath, settings);
        try {
          const sync = runRunner("sync", sandbox.env, sandbox.project);
          assert.equal(sync.status, expected.exitCodes.success);
          assertEnvelope(sync, "sync");
          assert.equal(sync.json.result.changed, true, "sync must complete a matching partial Sol pair");
          assert.deepEqual(readJson(settingsPath), {
            ...settings,
            defaultProvider: "openai-codex",
            defaultModel: "gpt-5.6-sol",
          });
          assert.equal(readJson(modelsPath).providers["openai-codex"].modelOverrides["gpt-5.6-sol"].contextWindow, 872_000);
        } finally {
          rmSync(sandbox.root, { recursive: true, force: true });
        }
      }
    });
  });

  await t.test("cleanup preserves user replacements while removing other still-owned leaves", () => {
    const sandbox = createSandbox("sol-user-replacement");
    const settingsPath = join(sandbox.agentDir, "settings.json");
    const modelsPath = join(sandbox.agentDir, "models.json");
    writeJson(settingsPath, { foreign: { keep: true } });
    writeJson(modelsPath, { providers: { foreign: { keep: true } } });
    try {
      const sync = runRunner("sync", sandbox.env, sandbox.project);
      assert.equal(sync.status, expected.exitCodes.success);
      assertEnvelope(sync, "sync");
      assert.equal(sync.json.result.changed, true);

      const settings = readJson(settingsPath);
      settings.defaultModel = "user-selected-model";
      writeJson(settingsPath, settings);
      const models = readJson(modelsPath);
      models.providers["openai-codex"].modelOverrides["gpt-5.6-sol"].contextWindow = 64_000;
      writeJson(modelsPath, models);
      const receiptPath = findReceiptPath(sandbox.agentDir);

      const cleanup = runRunner("cleanup", sandbox.env, sandbox.project);
      assert.equal(cleanup.status, expected.exitCodes.success);
      assertEnvelope(cleanup, "cleanup");
      assert.equal(cleanup.json.result.changed, true);
      const settingsAfterCleanup = readJson(settingsPath);
      const modelsAfterCleanup = readJson(modelsPath);
      assert.equal("defaultProvider" in settingsAfterCleanup, false, "cleanup must remove a still-owned exact leaf");
      assert.equal(settingsAfterCleanup.defaultModel, "user-selected-model", "cleanup must preserve a user replacement");
      assert.deepEqual(settingsAfterCleanup.foreign, { keep: true });
      assert.equal(
        modelsAfterCleanup.providers["openai-codex"].modelOverrides["gpt-5.6-sol"].contextWindow,
        64_000,
        "cleanup must preserve a user context override",
      );
      assert.deepEqual(modelsAfterCleanup.providers.foreign, { keep: true });
      assert.equal(existsSync(receiptPath), false, "released field ownership must remove an empty receipt");
    } finally {
      rmSync(sandbox.root, { recursive: true, force: true });
    }
  });

  await t.test("an active Pi settings lock fails closed without changing configuration", () => {
    const sandbox = createSandbox("sol-active-lock");
    const settingsPath = join(sandbox.agentDir, "settings.json");
    const lockPath = `${settingsPath}.lock`;
    writeJson(settingsPath, { foreign: { keep: true } });
    mkdirSync(lockPath);
    const before = digestRoots([sandbox.agentDir]);
    try {
      const sync = runRunner("sync", sandbox.env, sandbox.project);
      assert.equal(sync.status, expected.exitCodes.unhealthy);
      assertEnvelope(sync, "sync");
      assert.equal(sync.json.error.code, "CONFIG_LOCKED");
      assert.equal(digestRoots([sandbox.agentDir]), before, "a locked settings file must remain byte-identical");
      assert.equal(receiptPaths(sandbox.agentDir).length, 0);
    } finally {
      rmSync(sandbox.root, { recursive: true, force: true });
    }
  });

  await t.test("cleanup without an agent directory remains a true no-op", () => {
    const sandbox = createSandbox("sol-cleanup-absent");
    rmSync(sandbox.agentDir, { recursive: true });
    try {
      const cleanup = runRunner("cleanup", sandbox.env, sandbox.project);
      assert.equal(cleanup.status, expected.exitCodes.success);
      assertEnvelope(cleanup, "cleanup");
      assert.deepEqual(cleanup.json.result, { changed: false, actions: [] });
      assert.equal(existsSync(sandbox.agentDir), false, "cleanup must not create an absent Pi agent directory");
    } finally {
      rmSync(sandbox.root, { recursive: true, force: true });
    }
  });

  await t.test("malformed configuration or receipt fails closed with a stable error envelope", async (t) => {
    await t.test("malformed models JSON leaves all files untouched", () => {
      const sandbox = createSandbox("sol-malformed-models");
      const modelsPath = join(sandbox.agentDir, "models.json");
      writeFileSync(modelsPath, "{not-json\n");
      const before = digestRoots([sandbox.agentDir]);
      try {
        const first = runRunner("sync", sandbox.env, sandbox.project);
        const second = runRunner("sync", sandbox.env, sandbox.project);
        for (const result of [first, second]) {
          assert.equal(result.status, expected.exitCodes.unhealthy);
          assertEnvelope(result, "sync");
          assert.equal(result.json.ok, false);
        }
        assert.deepEqual(second.json, first.json, "malformed config diagnosis must be stable");
        assert.equal(digestRoots([sandbox.agentDir]), before, "sync must fail before mutating malformed config");
      } finally {
        rmSync(sandbox.root, { recursive: true, force: true });
      }
    });

    await t.test("valid models JSON with an incompatible parent fails closed before any write or receipt", () => {
      const sandbox = createSandbox("sol-incompatible-models-parent");
      const modelsPath = join(sandbox.agentDir, "models.json");
      const incompatibleModels = { providers: [] };
      writeJson(modelsPath, incompatibleModels);
      const before = digestRoots([sandbox.agentDir]);
      try {
        const sync = runRunner("sync", sandbox.env, sandbox.project);
        assert.equal(sync.status, expected.exitCodes.unhealthy);
        assertEnvelope(sync, "sync");
        assert.equal(sync.json.ok, false);
        assert.equal(digestRoots([sandbox.agentDir]), before, "a valid but incompatible models shape must not partially write settings or a receipt");
        assert.deepEqual(readJson(modelsPath), incompatibleModels);
        assert.equal(receiptPaths(sandbox.agentDir).length, 0, "a failed merge must not create ownership state");
      } finally {
        rmSync(sandbox.root, { recursive: true, force: true });
      }
    });

    await t.test("malformed receipt leaves owned config untouched", () => {
      const sandbox = createSandbox("sol-malformed-receipt");
      try {
        const sync = runRunner("sync", sandbox.env, sandbox.project);
        assert.equal(sync.status, expected.exitCodes.success);
        assertEnvelope(sync, "sync");
        const receiptPath = findReceiptPath(sandbox.agentDir);
        writeFileSync(receiptPath, "{not-json\n");
        const before = digestRoots([sandbox.agentDir]);

        const first = runRunner("cleanup", sandbox.env, sandbox.project);
        const second = runRunner("cleanup", sandbox.env, sandbox.project);
        for (const result of [first, second]) {
          assert.equal(result.status, expected.exitCodes.unhealthy);
          assertEnvelope(result, "cleanup");
          assert.equal(result.json.ok, false);
        }
        assert.deepEqual(second.json, first.json, "malformed receipt diagnosis must be stable");
        assert.equal(digestRoots([sandbox.agentDir]), before, "cleanup must fail before mutating config or receipt");
      } finally {
        rmSync(sandbox.root, { recursive: true, force: true });
      }
    });
  });

  await t.test("an empty agent directory receives canonical files that cleanup fully removes", () => {
    const sandbox = createSandbox("sol-empty-agent-dir");
    const settingsPath = join(sandbox.agentDir, "settings.json");
    const modelsPath = join(sandbox.agentDir, "models.json");
    try {
      assert.deepEqual(readdirSync(sandbox.agentDir), []);

      const sync = runRunner("sync", sandbox.env, sandbox.project);
      assert.equal(sync.status, expected.exitCodes.success);
      assertEnvelope(sync, "sync");
      assert.deepEqual(readJson(settingsPath), {
        defaultProvider: "openai-codex",
        defaultModel: "gpt-5.6-sol",
      });
      assert.deepEqual(readJson(modelsPath), {
        providers: {
          "openai-codex": {
            modelOverrides: {
              "gpt-5.6-sol": { contextWindow: 872_000 },
            },
          },
        },
      });
      assert.deepEqual(readJson(findReceiptPath(sandbox.agentDir)), {
        schemaVersion: 1,
        fields: {
          "settings.defaultProvider": "openai-codex",
          "settings.defaultModel": "gpt-5.6-sol",
          "models.providers.openai-codex.modelOverrides.gpt-5.6-sol.contextWindow": 872_000,
        },
        containers: {
          "models.providers": true,
          "models.providers.openai-codex": true,
          "models.providers.openai-codex.modelOverrides": true,
          "models.providers.openai-codex.modelOverrides.gpt-5.6-sol": true,
        },
        files: { models: true, settings: true },
      });

      const cleanup = runRunner("cleanup", sandbox.env, sandbox.project);
      assert.equal(cleanup.status, expected.exitCodes.success);
      assertEnvelope(cleanup, "cleanup");
      assert.equal(cleanup.json.result.changed, true);
      assert.deepEqual(readdirSync(sandbox.agentDir), [], "cleanup must remove all files and the empty receipt directory it created");
    } finally {
      rmSync(sandbox.root, { recursive: true, force: true });
    }
  });
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
  assert.equal(json.package?.version, packageVersion);
  assert.equal(typeof json.package?.root, "string");
  assert.ok(json.result && typeof json.result === "object" && !Array.isArray(json.result));
  assert.equal(json.ok ? json.error === undefined : typeof json.error === "object", true, "ok must discriminate success from error envelopes");
  if (!json.ok) {
    for (const field of ["phase", "code", "message"]) {
      assert.equal(typeof json.error[field], "string", `schema-required error.${field} must be a string`);
      assert.ok(json.error[field].length > 0, `schema-required error.${field} must not be empty`);
    }
  }
  if (command === "status") assert.deepEqual(Object.keys(json.result).sort(), ["engram", "installation"]);
  if (command === "doctor") {
    assert.equal(typeof json.result.healthy, "boolean");
    assert.ok(Array.isArray(json.result.checks));
  }
  if (command === "models") assert.deepEqual(Object.keys(json.result).sort(), ["mode", "primary", "tiers"]);
  if (["sync", "cleanup"].includes(command)) {
    assert.deepEqual(Object.keys(json.result).sort(), ["actions", "changed"]);
    assertLifecycleActionsUseSchemaEnum(json.result.actions);
  }
}

function assertLifecycleActionsUseSchemaEnum(actions) {
  const schema = readJson(join(root, "contract", "schemas", "runner-response.v1.schema.json"));
  const declaredActions = schema.$defs?.lifecycleAction?.enum;
  assert.ok(Array.isArray(declaredActions), "the runner response schema must declare lifecycle actions");
  for (const action of actions) {
    assert.ok(declaredActions.includes(action), `runner action ${action} must be listed in the response schema enum`);
  }
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

function receiptPaths(agentDir) {
  const receiptDir = join(agentDir, "jorgex-pi");
  if (!existsSync(receiptDir)) return [];
  return readdirSync(receiptDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => join(receiptDir, name));
}

function findReceiptPath(agentDir) {
  const paths = receiptPaths(agentDir);
  assert.equal(paths.length, 1, "sync must store exactly one dedicated ownership receipt under PI_CODING_AGENT_DIR/jorgex-pi");
  return paths[0];
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

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
