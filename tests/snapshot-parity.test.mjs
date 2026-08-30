import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(testDir, "..");
const expected = readJson(join(testDir, "fixtures", "snapshot-parity.expected.json"), "snapshot parity fixture");
const bootstrapExpected = readJson(join(testDir, "fixtures", "bootstrap.expected.json"), "bootstrap fixture");
const capabilitiesExpected = readJson(join(testDir, "fixtures", "quality-capabilities.expected.json"), "quality capabilities fixture");

test("the Stack snapshot stays complete and deterministic after runtime activation", () => {
  const packageManifest = readJson(join(root, "package.json"), "package manifest");
  assert.deepEqual(packageManifest.pi?.prompts, bootstrapExpected.prompts, "only the reviewed portable prompt projection may activate");
  assert.deepEqual(packageManifest.pi?.themes, bootstrapExpected.themes, "the package-owned JorgeX theme is outside the inert Stack snapshot");
  for (const field of ["optionalDependencies", "peerDependencies"]) {
    assert.deepEqual(packageManifest[field] ?? {}, {}, `snapshot S1 must not activate ${field}`);
  }

  const parity = readJson(join(root, expected.parityPath), "snapshot parity manifest");
  assert.equal(parity.schemaVersion, expected.schemaVersion);
  assert.deepEqual(parity.source, { repository: expected.sourceRepository, commit: expected.sourceCommit });
  assert.deepEqual(
    Object.keys(parity).sort(),
    ["agents", "commands", "engramProtocol", "exclusions", "policy", "qualityCapabilities", "qualityReceipt", "schemaVersion", "skills", "source"],
    "parity v2 must expose every canonical source type explicitly",
  );
  assertAgentParity(parity.agents);
  assertSkillParity(parity.skills);
  assertSharedProjectionParity(parity);
  assert.deepEqual(parity.exclusions, expected.exclusions, "parity v2 must retain every deliberate exclusion");
});

function assertAgentParity(agents) {
  assert.ok(Array.isArray(agents), "parity agents must be an array");
  assert.equal(agents.length, expected.agentCount);
  assert.deepEqual(agents.map(({ name }) => name), expected.agentNames, "agent entries must be complete, unique, and sorted");
  const targetPaths = [];
  for (const agent of agents) {
    assert.deepEqual(Object.keys(agent).sort(), ["name", "outputSha256", "sourcePath", "sourceSha256", "targetPath"]);
    assert.equal(agent.sourcePath, `stack/agents/${agent.name}.md`);
    assert.equal(agent.targetPath, `snapshot/agents/${agent.name}.md`);
    assertSha256(agent.sourceSha256, `${agent.name} source hash`);
    assert.equal(agent.outputSha256, hashFile(join(root, agent.targetPath)), `${agent.name} output hash must match packaged bytes`);
    targetPaths.push(agent.targetPath);
  }
  assert.deepEqual(listFiles(join(root, "snapshot", "agents")), targetPaths, "snapshot/agents must contain exactly the parity targets");
}

function assertSkillParity(skills) {
  assert.ok(Array.isArray(skills), "parity skills must be an array");
  assert.equal(skills.length, expected.skillCount);
  assert.deepEqual(skills.map(({ name }) => name), expected.skillNames, "skill entries must be complete, unique, and sorted");
  const targetFiles = [];
  for (const skill of skills) {
    assert.deepEqual(Object.keys(skill).sort(), ["files", "name", "sourcePath", "targetPath"]);
    assert.equal(skill.sourcePath, `stack/skills/${skill.name}`);
    assert.equal(skill.targetPath, `skills/${skill.name}`);
    assert.ok(Array.isArray(skill.files) && skill.files.length > 0, `${skill.name} must contain files`);
    assert.deepEqual(
      skill.files.map(({ path }) => path),
      [...skill.files.map(({ path }) => path)].sort(),
      `${skill.name} file entries must be sorted`,
    );
    for (const file of skill.files) {
      assert.deepEqual(Object.keys(file).sort(), ["path", "sha256"]);
      assertSafeRelativePath(file.path, `${skill.name} file path`);
      const targetPath = `${skill.targetPath}/${file.path}`;
      assert.equal(file.sha256, hashFile(join(root, targetPath)), `${targetPath} hash must match packaged bytes`);
      targetFiles.push(targetPath);
    }
  }
  assert.equal(targetFiles.length, expected.skillFileCount);
  assert.equal(new Set(targetFiles).size, expected.skillFileCount, "skill target paths must be unique");
  assert.deepEqual(listFiles(join(root, "skills")), targetFiles.sort(), "skills must contain exactly the parity targets");
}

function assertSharedProjectionParity(parity) {
  assertCopyProjection(parity.policy, expected.policy, "system policy");
  assertCopyProjection(parity.engramProtocol, expected.engramProtocol, "Engram protocol");
  assertQualityReceiptProjection(parity.qualityReceipt, expected.qualityReceipt);
  assertQualityCapabilitiesProjection(parity[capabilitiesExpected.parityField], capabilitiesExpected);

  assert.ok(Array.isArray(parity.commands), "parity commands must be an array");
  assert.equal(parity.commands.length, expected.commands.length, "parity commands must be complete");
  for (const [index, command] of parity.commands.entries()) {
    const commandExpected = expected.commands[index];
    assert.deepEqual(
      Object.keys(command).sort(),
      ["name", "outputSha256", "sourcePath", "sourceSha256", "targetPath"],
      `${commandExpected.name} command projection must record source and generated bytes`,
    );
    assert.equal(command.name, commandExpected.name);
    assert.equal(command.sourcePath, commandExpected.sourcePath);
    assert.equal(command.targetPath, commandExpected.targetPath);
    assertSha256(command.sourceSha256, `${command.name} source hash`);
    assert.equal(command.outputSha256, hashFile(join(root, command.targetPath)), `${command.name} output hash must match packaged bytes`);
  }

  assert.deepEqual(
    listFiles(join(root, "assets", "system-prompt")),
    [parity.policy.targetPath, parity.engramProtocol.targetPath].sort(),
    "the bundled policy directory must contain only tracked canonical fallbacks",
  );
  assert.deepEqual(
    listFiles(join(root, "prompts")),
    parity.commands.map(({ targetPath }) => targetPath).sort(),
    "the bundled prompt directory must contain only tracked canonical projections",
  );
}

function assertQualityReceiptProjection(projection, projectionExpected) {
  assert.deepEqual(
    Object.keys(projection).sort(),
    ["namespace", "version", "sourcePath", "targetPath", "sourceSha256", "outputSha256"].sort(),
    "quality receipt projection must record its versioned schema metadata",
  );
  assert.deepEqual(projection, projectionExpected, "quality receipt projection must match the candidate fixture");
  assert.equal(projection.namespace, "jorgex.quality.receipt");
  assert.equal(projection.version, 1);
  assertSha256(projection.sourceSha256, "quality receipt source hash");
  assert.equal(projection.outputSha256, hashFile(join(root, projection.targetPath)), "quality receipt output hash must match the projected schema");
}

function assertQualityCapabilitiesProjection(projection, projectionExpected) {
  assert.ok(projection && typeof projection === "object" && !Array.isArray(projection), "parity v2 must expose qualityCapabilities as an object");
  assert.deepEqual(
    Object.keys(projection).sort(),
    [...projectionExpected.projectionKeys].sort(),
    "quality capabilities projection must record only its versioned schema metadata",
  );
  assert.deepEqual(
    {
      namespace: projection.namespace,
      version: projection.version,
      sourcePath: projection.sourcePath,
      targetPath: projection.targetPath,
    },
    {
      namespace: projectionExpected.namespace,
      version: projectionExpected.version,
      sourcePath: projectionExpected.sourcePath,
      targetPath: projectionExpected.targetPath,
    },
    "quality capabilities projection must match the approved canonical paths",
  );
  assert.match(projection.sourceSha256 ?? "", /^[a-f0-9]{64}$/, "quality capabilities source hash must be lowercase sha256");
  assert.match(projection.outputSha256 ?? "", /^[a-f0-9]{64}$/, "quality capabilities output hash must be lowercase sha256");

  const schema = readJson(join(root, projection.targetPath), "quality capabilities schema projection");
  assert.equal(schema.type, "object", "quality capabilities schema must describe an object report");
  assert.equal(schema.additionalProperties, false, "quality capabilities report must reject undeclared top-level fields");
  assert.deepEqual(Object.keys(schema.properties ?? {}).sort(), ["capabilities", "namespace", "runtime", "version"]);
  assert.equal(schema.properties?.namespace?.const, projectionExpected.namespace);
  assert.equal(schema.properties?.version?.const, projectionExpected.version);
  assert.deepEqual(schema.properties?.runtime?.enum, projectionExpected.runtimeValues);

  const capabilityItem = schema.properties?.capabilities?.items;
  assert.equal(capabilityItem?.type, "object", "capabilities.items must describe a capability object");
  assert.equal(capabilityItem?.additionalProperties, false, "capability entries must reject undeclared fields");
  assert.deepEqual(Object.keys(capabilityItem?.properties ?? {}).sort(), ["evidence", "id", "reason", "state"]);
  assert.deepEqual([...(capabilityItem?.required ?? [])].sort(), ["id", "reason", "state"], "evidence must remain optional");
  assert.deepEqual(capabilityItem?.properties?.id?.enum, projectionExpected.capabilityIds);
  const stateDefinition = capabilityItem?.properties?.state;
  const stateEnum = stateDefinition?.$ref === "#/$defs/localCapabilityState"
    ? schema.$defs?.localCapabilityState?.enum
    : stateDefinition?.enum;
  assert.deepEqual(
    [...(stateEnum ?? [])].sort(),
    [...projectionExpected.localStates].sort(),
    "local capability item.state must exclude enforced",
  );
  assert.deepEqual(
    [...(schema.$defs?.capabilityState?.enum ?? [])].sort(),
    [...projectionExpected.states].sort(),
    "the separate common vocabulary must retain all four capability states",
  );
  assert.deepEqual(
    [...(schema.$defs?.localCapabilityState?.enum ?? [])].sort(),
    [...projectionExpected.localStates].sort(),
  );
  assert.deepEqual(schema.$defs?.strictProfile?.enum, projectionExpected.strictProfiles);
  assert.ok(capabilityItem?.properties?.reason, "capability entries must expose a reason field");
  assert.ok(capabilityItem?.properties?.evidence, "capability entries must expose an optional evidence field");
  assert.equal(projection.outputSha256, hashFile(join(root, projection.targetPath)), "quality capabilities output hash must match the projected schema");
}
function assertCopyProjection(projection, projectionExpected, label) {
  assert.deepEqual(
    Object.keys(projection).sort(),
    ["outputSha256", "sourcePath", "sourceSha256", "targetPath"],
    `${label} projection must record source and generated bytes`,
  );
  assert.equal(projection.sourcePath, projectionExpected.sourcePath);
  assert.equal(projection.targetPath, projectionExpected.targetPath);
  assertSha256(projection.sourceSha256, `${label} source hash`);
  assert.equal(projection.outputSha256, hashFile(join(root, projection.targetPath)), `${label} output hash must match packaged bytes`);
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    assert.fail(`${label} is missing or invalid at ${relative(root, path)} (${error.code ?? error.message})`);
  }
}

function hashFile(path) {
  const stat = lstatSync(path);
  assert.equal(stat.isSymbolicLink(), false, `snapshot file must not be a symlink: ${relative(root, path)}`);
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function listFiles(rootDir) {
  const files = [];
  const resolvedRoot = `${resolve(rootDir)}${sep}`;
  const visit = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      assert.equal(stat.isSymbolicLink(), false, `snapshot tree must not contain symlinks: ${relative(root, path)}`);
      assert.ok(resolve(path).startsWith(resolvedRoot), `snapshot path escapes its root: ${relative(rootDir, path)}`);
      if (stat.isDirectory()) visit(path);
      else files.push(relative(root, path).replaceAll("\\", "/"));
    }
  };
  visit(rootDir);
  return files.sort();
}

function assertSafeRelativePath(path, label) {
  assert.equal(typeof path, "string", `${label} must be a string`);
  assert.ok(path.length > 0 && !path.startsWith("/") && !path.includes("\\"), `${label} must be normalized and relative`);
  const segments = path.split("/");
  assert.ok(segments.every((segment) => segment.length > 0 && segment !== "." && segment !== ".."), `${label} must not contain empty or dot segments`);
}

function assertSha256(value, label) {
  assert.match(value ?? "", /^[a-f0-9]{64}$/, `${label} must be lowercase sha256`);
}
