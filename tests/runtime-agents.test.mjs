import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { parse as parseYaml } from "yaml";

const testDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(testDir, "..");
const expected = readJson(join(testDir, "fixtures", "runtime-agents.expected.json"), "runtime agent fixture");
const bootstrapExpected = readJson(join(testDir, "fixtures", "bootstrap.expected.json"), "bootstrap fixture");
const foundationExpected = readJson(join(testDir, "fixtures", "foundation-contract.expected.json"), "foundation contract fixture");
const webAccessExpected = readJson(join(testDir, "fixtures", "web-access.expected.json"), "web access fixture");
const mcpEngramExpected = readJson(join(testDir, "fixtures", "mcp-engram.expected.json"), "MCP Engram fixture");

test("pi-subagents is pinned with its audited bundled closure", () => {
  const manifest = readJson(join(root, "package.json"), "package manifest");
  const expectedDependencies = [...bootstrapExpected.companions, mcpEngramExpected.adapter];
  assert.deepEqual(
    manifest.dependencies,
    Object.fromEntries(expectedDependencies.map(({ name, version }) => [name, version]).sort(([left], [right]) => left.localeCompare(right))),
  );
  assert.deepEqual([...manifest.bundledDependencies].sort(), expectedDependencies.map(({ name }) => name).sort());
  assert.deepEqual(manifest["pi-subagents"], { agents: ["./agents"] }, "only the 14 runnable package agents may be discoverable by pi-subagents");
  const lock = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
  for (const dependency of expected.dependency.bundledClosure) assertLockIntegrity(lock, dependency);
});

test("the read-only Engram specialist exposes only non-mutating ProfileAgent tools", () => {
  const contract = readJson(join(root, expected.contractPath), "runtime agent contract");
  const expectedEngram = expected.agents.find(({ name }) => name === "engram");
  const actualEngram = contract.agents.find(({ name }) => name === "engram");
  assert.equal(actualEngram.status, "runnable");
  assert.equal(actualEngram.requiredCapability, "engram-runtime-tools-v1", "Engram availability must remain machine-readable when the runtime bridge is unhealthy");
  assert.deepEqual(actualEngram.tools, expectedEngram.tools);
  assert.deepEqual(actualEngram.tools, [
    "mem_search",
    "mem_context",
    "mem_get_observation",
    "mem_suggest_topic_key",
    "mem_current_project",
    "mem_doctor",
  ]);
  for (const mutatingTool of [
    "mem_save",
    "mem_session_summary",
    "mem_session_start",
    "mem_session_end",
    "mem_save_prompt",
    "mem_update",
    "mem_judge",
    "mem_compare",
    "mem_review",
    "mem_pin",
    "mem_unpin",
    "mem_capture_passive",
  ]) assert.equal(actualEngram.tools.includes(mutatingTool), false, `read-only Engram must not expose ${mutatingTool}`);
  assert.equal("deferredUntil" in actualEngram, false, "published contracts must not expose internal PR sequencing");
});

test("Engram agent instructions mention only tools present in its active profile", () => {
  const generated = readFileSync(join(root, "agents/engram.md"), "utf8");
  assert.doesNotMatch(generated, /\bmem_timeline\b/, "generated Engram instructions must not mention a tool excluded from the active profile");
  for (const operation of ["mem_context", "mem_search", "mem_get_observation"]) {
    assert.match(generated, new RegExp(`\\b${operation}\\b`), `generated Engram instructions must retain available operation ${operation}`);
  }
});

test("pi-subagents 0.54.0 discovers all fourteen runnable package agents without diagnostics", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-agent-discovery-"));
  try {
    const agentDir = join(sandbox, "agent");
    const installedPackage = join(agentDir, "npm", "node_modules", "jorgex-pi");
    mkdirSync(installedPackage, { recursive: true });
    cpSync(join(root, "package.json"), join(installedPackage, "package.json"));
    cpSync(join(root, "agents"), join(installedPackage, "agents"), { recursive: true });
    cpSync(join(root, "extensions"), join(installedPackage, "extensions"), { recursive: true });
    cpSync(join(root, "skills"), join(installedPackage, "skills"), { recursive: true });
    const names = expected.agents.filter(({ status }) => status === "runnable").map(({ name }) => name);
    const env = {
      HOME: join(sandbox, "home"),
      USERPROFILE: join(sandbox, "userprofile"),
      PATH: process.env.PATH ?? "",
      PI_CODING_AGENT_DIR: agentDir,
      PI_SUBAGENTS_TEMP_ROOT: join(sandbox, "pi-subagents-temp"),
      TEMP: join(sandbox, "temp"),
      TMP: join(sandbox, "temp"),
      XDG_CACHE_HOME: join(sandbox, "xdg-cache"),
      XDG_CONFIG_HOME: join(sandbox, "xdg-config"),
      XDG_DATA_HOME: join(sandbox, "xdg-data"),
    };
    const output = execFileSync(process.execPath, [join(testDir, "fixtures", "discover-runtime-agents.mjs"), JSON.stringify(names)], {
      cwd: sandbox,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const results = JSON.parse(output);
    assert.equal(results.length, 14);
    assert.deepEqual(results.map(({ requestedName }) => requestedName), names);
    assert.deepEqual(
      results.filter(({ ok, discoveredName, requestedName }) => !ok || discoveredName !== requestedName),
      [],
      `pi-subagents discovery rejected package agents: ${results.filter(({ ok }) => !ok).map(({ message }) => message).join(" | ")}`,
    );
    for (const result of results) {
      const policy = expectedBashPolicy(result.requestedName);
      if (policy === "git-read") {
        assert.equal(result.configuredExtensions?.length, 1);
        assert.equal(resolve(result.configuredExtensions[0]), join(installedPackage, "extensions", "git-read.ts"));
        assert.equal(existsSync(result.configuredExtensions[0]), true, `${result.requestedName} child-only extension must exist in the installed package`);
      } else assert.deepEqual(result.configuredExtensions, []);
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("pi-subagents preflight resolves private defaults and a no-skills override in direct and managed package profiles", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-agent-preflight-"));
  const names = expected.skillSelections.map(({ name }) => name);
  assert.deepEqual(names, expected.agents.map(({ name }) => name), "skill selections must cover the runnable agents in their reviewed order");
  try {
    for (const profile of ["direct", "managed"]) {
      const profileRoot = join(sandbox, profile);
      const agentDir = join(profileRoot, "agent");
      const installedPackage = join(agentDir, "npm", "node_modules", "jorgex-pi");
      mkdirSync(installedPackage, { recursive: true });
      for (const path of ["agents", "extensions", "skills"]) cpSync(join(root, path), join(installedPackage, path), { recursive: true });
      const manifest = readJson(join(root, "package.json"), "package manifest");
      if (profile === "managed") manifest.pi = { ...manifest.pi, skills: [], prompts: [] };
      writeFileSync(join(installedPackage, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

      const results = preflightRuntimeAgents(names, profileRoot, agentDir);
      assert.deepEqual(results.map(({ requestedName }) => requestedName), names);
      for (const selection of expected.skillSelections) {
        const result = results.find(({ requestedName }) => requestedName === selection.name);
        const agent = expected.agents.find(({ name }) => name === selection.name);
        assert.ok(result?.ok, `${profile} preflight must resolve ${selection.name}: ${result?.message ?? "no result"}`);
        assert.equal(result.inheritSkills, false, `${profile} ${selection.name} must not inherit ambient skills`);
        assert.equal(result.model, undefined, `${profile} ${selection.name} must not select a model without an explicit input`);
        assert.deepEqual(result.modelCandidates, [], `${profile} ${selection.name} must not resolve model fallbacks without an explicit input`);
        assert.deepEqual(result.skills, {
          requested: selection.skills,
          resolved: selection.skills.map((name) => ({ name, path: join(installedPackage, "skills", name, "SKILL.md"), source: "unknown" })),
          missing: [],
        }, `${profile} ${selection.name} must resolve only its private default skills`);
        assert.deepEqual(result.effectiveAllowlist, agent.tools, `${profile} ${selection.name} must preserve its reviewed tool allowlist`);
        const extensions = expectedBashPolicy(selection.name) === "git-read"
          ? [join(installedPackage, "extensions", "git-read.ts")]
          : [];
        assert.deepEqual(result.configuredExtensions, extensions, `${profile} ${selection.name} must preserve its child extension boundary`);
      }

      const defaultImplementer = results.find(({ requestedName }) => requestedName === "implementer");
      const [withoutSkills] = preflightRuntimeAgents(["implementer"], profileRoot, agentDir, { skill: false });
      assert.ok(withoutSkills?.ok, `${profile} preflight must resolve implementer with skills disabled: ${withoutSkills?.message ?? "no result"}`);
      assert.deepEqual(withoutSkills.skills, { requested: [], resolved: [], missing: [] }, `${profile} skill:false must suppress implementer's private defaults`);
      assert.deepEqual(
        {
          model: withoutSkills.model,
          modelCandidates: withoutSkills.modelCandidates,
          inheritSkills: withoutSkills.inheritSkills,
          effectiveAllowlist: withoutSkills.effectiveAllowlist,
          configuredExtensions: withoutSkills.configuredExtensions,
        },
        {
          model: defaultImplementer.model,
          modelCandidates: defaultImplementer.modelCandidates,
          inheritSkills: defaultImplementer.inheritSkills,
          effectiveAllowlist: defaultImplementer.effectiveAllowlist,
          configuredExtensions: defaultImplementer.configuredExtensions,
        },
        `${profile} skill:false must not change implementer's model, inheritance, or tool contract`,
      );
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("the runtime contract translates one primary and fourteen canonical subagents without model policy", () => {
  const contract = readJson(join(root, expected.contractPath), "runtime agent contract");
  const manifest = readJson(join(root, "package.json"), "package manifest");
  const parity = readJson(join(root, "contract", "parity.v2.json"), "snapshot parity contract");
  const activeSnapshotSkills = parity.skills.map(({ name }) => name).filter((name) => name !== "playwright-cli");
  const packageSkills = manifest.pi.skills.map((path) => path.replace(/^\.\/skills\//, ""));
  assert.deepEqual(Object.keys(contract).sort(), ["agents", "dependency", "primary", "schemaVersion", "skillSelections", "skills"]);
  assert.equal(contract.schemaVersion, expected.schemaVersion);
  assert.deepEqual(contract.dependency, expected.dependency);
  assert.deepEqual(contract.primary, expected.primary);
  assert.deepEqual(contract.skillSelections, expected.skillSelections, "runtime contract must retain the reviewed private skill selection by role");
  assert.deepEqual(contract.skills, expected.skills, "runtime skill allowlist must match its reviewed fixture");
  assert.deepEqual(contract.skills, activeSnapshotSkills, "runtime skills must equal the canonical snapshot minus opt-in Playwright");
  assert.deepEqual(packageSkills, activeSnapshotSkills, "package activation must match the runtime skill contract");
  assert.equal(contract.skills.includes("playwright-cli"), false, "Playwright remains a separate opt-in integration");
  assert.equal(new Set(contract.skills).size, expected.skills.length, "runtime skill names must be unique");

  assert.equal(contract.agents.length, 14);
  assert.deepEqual(contract.agents.map(({ name }) => name), expected.agents.map(({ name }) => name));
  const expectedAgents = [...expected.agents, expected.primary];
  for (const agent of expectedAgents) {
    const sourcePath = agent.sourcePath ?? `snapshot/agents/${agent.name}.md`;
    const source = parseAgentDocument(readFileSync(join(root, sourcePath), "utf8"));
    assert.equal(source.frontmatter.bash, expectedBashPolicy(agent.name), `${sourcePath} must retain its reviewed canonical bash policy`);
  }
  assertAllBashPolicies(new Map(expectedAgents.map((agent) => {
    const targetPath = agent.targetPath ?? (agent.status === "deferred" ? `deferred/agents/${agent.name}.md` : `agents/${agent.name}.md`);
    return [agent.name, { path: targetPath, frontmatter: parseAgentDocument(readFileSync(join(root, targetPath), "utf8")).frontmatter }];
  })));
  for (const expectedAgent of expected.agents) {
    const sourcePath = `snapshot/agents/${expectedAgent.name}.md`;
    const targetPath = expectedAgent.status === "deferred" ? `deferred/agents/${expectedAgent.name}.md` : `agents/${expectedAgent.name}.md`;
    const expectedEntry = { ...expectedAgent, sourcePath, targetPath };
    assert.deepEqual(contract.agents.find(({ name }) => name === expectedAgent.name), expectedEntry);
    assertTranslatedAgent(sourcePath, targetPath, expectedAgent);
  }
  assert.equal(contract.agents.filter(({ status }) => status === "runnable").length, 14);
  assert.deepEqual(contract.agents.filter(({ status }) => status === "deferred"), []);
  assertTranslatedAgent(expected.primary.sourcePath, expected.primary.targetPath, expected.primary);

  const packageAgents = listFiles(join(root, "agents")).map((path) => relative(join(root, "agents"), path).replaceAll("\\", "/"));
  assert.deepEqual(packageAgents, expected.agents.filter(({ status }) => status === "runnable").map(({ name }) => `${name}.md`));
  const deferredRoot = join(root, "deferred");
  const deferredFiles = existsSync(deferredRoot) ? listFiles(deferredRoot) : [];
  assert.deepEqual(deferredFiles, [], "the zero-deferred contract must not require an empty directory on disk");
  assert.deepEqual(listFiles(join(root, "primary")).map((path) => relative(root, path).replaceAll("\\", "/")), ["primary/orchestrator.md"]);
  assert.equal([...packageAgents, ...deferredFiles, ...listFiles(join(root, "primary"))].some((path) => path.endsWith(".chain.md")), false);
});

test("the real translator is deterministic and writes only inside its package copy", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-runtime-agents-"));
  const externalRoot = join(sandbox, "external");
  const first = join(sandbox, "first");
  const second = join(sandbox, "second");
  try {
    for (const name of ["home", "xdg", "pi-agent"]) {
      mkdirSync(join(externalRoot, name), { recursive: true });
      writeFileSync(join(externalRoot, name, "foreign.txt"), `${name}\n`);
    }
    const externalBefore = hashTree(externalRoot);
    createGeneratorPackage(first);
    createGeneratorPackage(second);
    runGenerator(first, externalRoot);
    runGenerator(second, externalRoot);
    assert.deepEqual(generatedTree(first), generatedTree(root), "executed translator output must equal committed runtime assets");
    assert.deepEqual(generatedTree(second), generatedTree(first), "two isolated translations must produce identical bytes");
    assert.deepEqual(hashTree(externalRoot), externalBefore, "translation must not write user, Pi, XDG, or other external state");
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("the real tarball contains the closed runtime assets and audited dependency closure", () => {
  const packDir = mkdtempSync(join(tmpdir(), "jorgex-pi-runtime-pack-"));
  try {
    const packageManager = resolvePnpm();
    execFileSync(packageManager.command, [...packageManager.args, "pack", "--pack-destination", packDir], { cwd: root, stdio: "pipe" });
    const tarballs = readdirSync(packDir).filter((name) => name.endsWith(".tgz"));
    assert.equal(tarballs.length, 1);
    const archive = readTgz(join(packDir, tarballs[0]));
    const packedManifest = readPackedJson(archive, "package/package.json");
    const packedContract = readPackedJson(archive, `package/${expected.contractPath}`);
    assert.deepEqual(packedContract.dependency, expected.dependency);
    assert.deepEqual(packedManifest["pi-subagents"], { agents: ["./agents"] });
    assert.deepEqual(packedManifest.pi, {
      extensions: bootstrapExpected.extensions,
      skills: bootstrapExpected.skills,
      prompts: bootstrapExpected.prompts,
      themes: bootstrapExpected.themes,
    });

    const expectedRuntimeFiles = [
      ...expected.agents.filter(({ status }) => status === "runnable").map(({ name }) => `package/agents/${name}.md`),
      "package/primary/orchestrator.md",
    ].sort();
    const packedRuntimeFiles = [...archive.keys()].filter((path) => /^package\/(?:agents|deferred\/agents|primary)\/.+\.md$/.test(path)).sort();
    assert.deepEqual(packedRuntimeFiles, expectedRuntimeFiles, "tarball must expose all 14 runnable agents and retain the primary separately");
    for (const skill of new Set(expected.skillSelections.flatMap(({ skills }) => skills))) {
      assert.ok(archive.has(`package/skills/${skill}/SKILL.md`), `tarball must retain the private skill entry selected by a runtime agent: ${skill}`);
    }
    assert.ok(archive.has("package/extensions/git-read.ts"), "tarball must contain the child-only provider referenced by git-read agents");
    assertAllBashPolicies(new Map(packedRuntimeFiles.map((path) => {
      const name = path.slice(path.lastIndexOf("/") + 1, -".md".length);
      return [name, { path, frontmatter: parseAgentDocument(archive.get(path).toString("utf8")).frontmatter }];
    })));
    assert.equal([...archive.keys()].some((path) => path.endsWith(".chain.md")), false, "legacy chains must not ship");
    assert.equal(archive.has(`package/${expected.generatorPath}`), false, "translation tooling must stay outside the published artifact");

    const dependencyManifests = [...archive.entries()]
      .filter(([path]) => path.startsWith("package/node_modules/") && path.endsWith("/package.json"))
      .map(([, bytes]) => JSON.parse(bytes.toString("utf8")))
      .filter(({ name, version }) => typeof name === "string" && name.length > 0 && typeof version === "string" && version.length > 0);
    for (const { packageName, file } of mcpEngramExpected.portableKeyringBindings) {
      const bindingPath = `package/node_modules/${packageName}/${file}`;
      assert.equal(archive.has(bindingPath), true, `portable MCP bundle must contain regular native binding ${bindingPath}`);
    }
    assert.equal(
      [...archive.keys()].some((path) => path.includes("/node_modules/@napi-rs/keyring-freebsd-")),
      false,
      "the supported portability matrix must not silently expand to an unaudited FreeBSD binding",
    );
    const packedClosure = dependencyManifests
      .map(({ name, version }) => ({ name, version }))
      .sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
    assert.equal(packedClosure.length, webAccessExpected.packedClosure.count, "tarball bundled closure count must match the audited active-companion resolution");
    assert.equal(
      sha256(Buffer.from(packedClosure.map(({ name, version }) => `${name}@${version}`).join("\n"))),
      webAccessExpected.packedClosure.identitySha256,
      "tarball bundled package identities must match the audited active-companion resolution",
    );
    const upstreamManifest = dependencyManifests.find(({ name }) => name === "pi-subagents");
    assert.ok(upstreamManifest.pi?.skills?.length > 0 && upstreamManifest.pi?.prompts?.length > 0, "the audited upstream resources must be physically bundled");
    assert.equal(packedManifest.pi.skills.some((path) => path.includes("pi-subagents")), false, "upstream skills must remain inactive at the root");
    assert.equal((packedManifest.pi.prompts ?? []).some((path) => path.includes("pi-subagents")), false, "upstream prompts must remain inactive at the root");
    for (const companion of bootstrapExpected.companions) {
      assert.ok(
        [...archive.keys()].some((path) => path.includes(`/node_modules/${companion.name}/`) && path.endsWith(`/${companion.entryPath}`)),
        `tarball must contain audited entry ${companion.name}/${companion.entryPath}`,
      );
    }
    for (const suffix of bootstrapExpected.wasmSuffixes) {
      assert.ok([...archive.keys()].some((path) => path.startsWith("package/node_modules/") && path.endsWith(suffix)), `tarball must contain ${suffix}`);
    }

    const assets = readPackedJson(archive, "package/contract/assets.v1.json");
    assert.deepEqual(assets.managedExternalWrites, foundationExpected.foundationAssetManifest.managedExternalWrites);
    assert.deepEqual(assets.preservedExternalState, foundationExpected.foundationAssetManifest.preservedExternalState);
    for (const resource of expected.ownedResources) assert.ok(assets.resources.includes(resource), `ownership manifest must declare ${resource}`);
  } finally {
    rmSync(packDir, { recursive: true, force: true });
  }
});

function assertTranslatedAgent(sourcePath, targetPath, expectedAgent) {
  const source = parseAgentDocument(readFileSync(join(root, sourcePath), "utf8"));
  const target = parseAgentDocument(readFileSync(join(root, targetPath), "utf8"));
  assert.equal(target.frontmatter.name, source.frontmatter.name);
  assert.equal(target.frontmatter.description, source.frontmatter.description);
  assert.deepEqual(splitList(target.frontmatter.tools), expectedAgent.tools, `${targetPath} tools must match the reviewed Pi translation`);
  assert.equal(target.frontmatter.systemPromptMode, "replace");
  assert.equal(target.frontmatter.inheritProjectContext, true);
  assert.equal(target.frontmatter.inheritSkills, false);
  if (expectedAgent.status === "dormant" || expectedAgent.name === "engram") {
    for (const field of ["skills", "skillPath"]) {
      assert.equal(Object.hasOwn(target.frontmatter, field), false, `${targetPath} must not declare ${field}`);
    }
  }
  for (const forbidden of ["provider", "model", "fallbackModels", "thinking", "tier", "mode", "readonly", "bash", "spawn"]) {
    assert.equal(Object.hasOwn(target.frontmatter, forbidden), false, `${targetPath} must not hardcode ${forbidden}`);
  }
  if (expectedAgent.maxSubagentDepth === 0) assert.equal(target.frontmatter.maxSubagentDepth, 0, `${targetPath} must preserve spawn: false`);
  else assert.equal(Object.hasOwn(target.frontmatter, "maxSubagentDepth"), false, `${targetPath} must retain default delegation depth`);
  if (expectedAgent.name === "engram") {
    assert.doesNotMatch(target.body, /\bmem_timeline\b/, `${targetPath} must translate unavailable runtime-specific Engram operations`);
  } else {
    assert.equal(target.body, source.body, `${targetPath} must preserve the canonical persona byte-for-byte after LF normalization`);
  }
}

function createGeneratorPackage(target) {
  mkdirSync(target, { recursive: true });
  cpSync(join(root, "scripts"), join(target, "scripts"), { recursive: true });
  cpSync(join(root, "snapshot"), join(target, "snapshot"), { recursive: true });
  cpSync(join(root, "skills"), join(target, "skills"), { recursive: true });
}

function runGenerator(packageRoot, externalRoot) {
  const env = {
    HOME: join(externalRoot, "home"),
    XDG_CONFIG_HOME: join(externalRoot, "xdg"),
    PI_CODING_AGENT_DIR: join(externalRoot, "pi-agent"),
    PATH: process.env.PATH ?? "",
  };
  assert.equal(Object.hasOwn(env, "PI_PACKAGE_DIR"), false, "PI_PACKAGE_DIR is package resolution, not writable state isolation");
  execFileSync(process.execPath, [join(packageRoot, expected.generatorPath)], { cwd: packageRoot, env, stdio: "pipe" });
}

function preflightRuntimeAgents(names, cwd, agentDir, options) {
  const sandbox = dirname(cwd);
  const env = {
    HOME: join(sandbox, "home"),
    USERPROFILE: join(sandbox, "userprofile"),
    PATH: process.env.PATH ?? "",
    PI_CODING_AGENT_DIR: agentDir,
    PI_SUBAGENTS_TEMP_ROOT: join(sandbox, "pi-subagents-temp"),
    TEMP: join(sandbox, "temp"),
    TMP: join(sandbox, "temp"),
    XDG_CACHE_HOME: join(sandbox, "xdg-cache"),
    XDG_CONFIG_HOME: join(sandbox, "xdg-config"),
    XDG_DATA_HOME: join(sandbox, "xdg-data"),
  };
  const args = [join(testDir, "fixtures", "discover-runtime-agents.mjs"), JSON.stringify(names)];
  if (options !== undefined) args.push(JSON.stringify(options));
  const output = execFileSync(process.execPath, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(output);
}

function generatedTree(packageRoot) {
  const paths = [
    join(packageRoot, expected.contractPath),
    join(packageRoot, expected.primary.targetPath),
    ...expected.agents.map(({ name, status }) => join(packageRoot, status === "deferred" ? "deferred/agents" : "agents", `${name}.md`)),
  ];
  return Object.fromEntries(paths.map((path) => [relative(packageRoot, path).replaceAll("\\", "/"), sha256(readFileSync(path))]).sort(([a], [b]) => a.localeCompare(b)));
}

function parseAgentDocument(text) {
  const normalized = text.replace(/\r\n?/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);
  assert.ok(match, "agent markdown must contain closed YAML frontmatter");
  const frontmatter = parseYaml(match[1]);
  assert.ok(frontmatter && typeof frontmatter === "object" && !Array.isArray(frontmatter), "agent frontmatter must be a YAML mapping");
  return { frontmatter, body: match[2].trim() };
}

function splitList(value) {
  const entries = Array.isArray(value) ? value : (value ?? "").split(",");
  return entries.map((entry) => entry.trim()).filter(Boolean);
}

function expectedBashPolicy(name) {
  for (const [policy, names] of Object.entries(expected.bashPolicies.agents)) {
    if (names.includes(name)) return policy;
  }
  assert.fail(`runtime agent fixture does not declare a bash policy for ${name}`);
}

function assertAllBashPolicies(documents) {
  const declaredNames = Object.values(expected.bashPolicies.agents).flat().sort();
  assert.deepEqual([...documents.keys()].sort(), declaredNames, "bash policy fixture must cover every runtime agent exactly once");
  for (const policy of ["none", "full", "git-read"]) {
    for (const name of expected.bashPolicies.agents[policy]) {
      const document = documents.get(name);
      assertBashPolicy(document.frontmatter, name, document.path);
    }
  }
}

function assertBashPolicy(frontmatter, name, path) {
  const policy = expectedBashPolicy(name);
  const tools = splitList(frontmatter.tools);
  const bashPermission = frontmatter.permission?.bash;
  const childExtensions = splitList(frontmatter.subagentOnlyExtensions);
  if (policy === "none") {
    assert.equal(tools.includes("bash"), false, `${path} must not expose the bash tool`);
    assert.equal(tools.includes("git_read"), false, `${path} must not expose git_read`);
    assert.equal(bashPermission, undefined, `${path} must not add a bash permission map`);
    assert.deepEqual(childExtensions, [], `${path} must not load a child-only git extension`);
    return;
  }
  if (policy === "git-read") {
    assert.equal(tools.includes("bash"), false, `${path} must not expose unrestricted bash for git-read`);
    assert.equal(tools.includes("git_read"), true, `${path} must expose the dedicated git_read tool`);
    assert.equal(frontmatter.permission, undefined, `${path} must not declare unsupported permission.bash frontmatter`);
    assert.deepEqual(childExtensions, [expected.bashPolicies.gitReadExtension], `${path} must load only the reviewed child-only git extension`);
    return;
  }
  assert.equal(policy, "full", `${path} declares an unknown bash policy`);
  assert.equal(tools.includes("bash"), true, `${path} must expose bash for full access`);
  assert.equal(tools.includes("git_read"), false, `${path} must not add the constrained git tool to full access`);
  assert.equal(bashPermission, undefined, `${path} must not add a per-agent bash restriction for full access`);
  assert.deepEqual(childExtensions, [], `${path} must not load a child-only git extension for full access`);
}

function assertLockIntegrity(lock, dependency) {
  const escaped = `${dependency.name}@${dependency.version}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const block = new RegExp(`^  ['\"]?${escaped}['\"]?:\\n([\\s\\S]*?)(?=^  \\S|^snapshots:)`, "m").exec(lock)?.[1];
  assert.ok(block, `pnpm lock must contain ${dependency.name}@${dependency.version}`);
  assert.ok(block.includes(`integrity: ${dependency.integrity}`), `${dependency.name}@${dependency.version} lock integrity must match the audited registry artifact`);
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    assert.fail(`${label} is missing or invalid at ${relative(root, path)} (${error.code ?? error.message})`);
  }
}

function resolvePnpm() {
  const corepackEntry = join(dirname(process.execPath), "node_modules", "corepack", "dist", "corepack.js");
  return existsSync(corepackEntry)
    ? { command: process.execPath, args: [corepackEntry, "pnpm"] }
    : process.platform === "win32"
      ? { command: process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe", args: ["/d", "/s", "/c", "pnpm.cmd"] }
      : { command: "pnpm", args: [] };
}

function listFiles(base) {
  const files = [];
  const visit = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      assert.equal(stat.isSymbolicLink(), false, `runtime asset must not be a symlink: ${path}`);
      if (stat.isDirectory()) visit(path);
      else files.push(path);
    }
  };
  visit(base);
  return files;
}

function hashTree(base) {
  return Object.fromEntries(listFiles(base).map((path) => [relative(base, path).replaceAll("\\", "/"), sha256(readFileSync(path))]));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function byName(left, right) {
  return left.name.localeCompare(right.name);
}

function readPackedJson(archive, path) {
  const bytes = archive.get(path);
  assert.ok(bytes, `packed artifact is missing ${path}`);
  return JSON.parse(bytes.toString("utf8"));
}

function readTgz(path) {
  const tar = gunzipSync(readFileSync(path));
  const files = new Map();
  let offset = 0;
  let nextPath;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = Number.parseInt(readTarString(header, 124, 12).trim() || "0", 8);
    const type = String.fromCharCode(header[156] || 48);
    const body = tar.subarray(offset + 512, offset + 512 + size);
    const prefix = readTarString(header, 345, 155);
    const headerPath = [prefix, readTarString(header, 0, 100)].filter(Boolean).join("/");
    if (type === "x") nextPath = readPaxPath(body) ?? nextPath;
    else if (type === "L") nextPath = body.toString("utf8").replace(/\0.*$/s, "");
    else {
      const entryPath = nextPath ?? headerPath;
      nextPath = undefined;
      if (type === "0" || type === "\0") files.set(entryPath, Buffer.from(body));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

function readTarString(header, start, length) {
  return header.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
}

function readPaxPath(bytes) {
  for (const record of bytes.toString("utf8").match(/\d+ [^\n]*\n/g) ?? []) {
    const field = record.slice(record.indexOf(" ") + 1, -1);
    if (field.startsWith("path=")) return field.slice("path=".length);
  }
  return undefined;
}
