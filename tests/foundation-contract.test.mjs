import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const testDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(testDir, "..");
const expected = readJson(join(testDir, "fixtures", "foundation-contract.expected.json"), "foundation contract fixture");
const bootstrapExpected = readJson(join(testDir, "fixtures", "bootstrap.expected.json"), "bootstrap fixture");

test("package manifest exposes the activated JorgeX resources", () => {
  const manifest = readJson(join(root, "package.json"), "package manifest required by the published Pi package");
  assert.equal(manifest.name, expected.packageName);
  assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  assert.ok(manifest.pi && typeof manifest.pi === "object", "package.json must declare a pi manifest");
  const expectedResources = {
    extensions: bootstrapExpected.extensions,
    skills: bootstrapExpected.skills,
    prompts: bootstrapExpected.prompts,
    themes: bootstrapExpected.themes,
  };
  for (const kind of expected.requiredPiResourceKinds) {
    assert.ok(Array.isArray(manifest.pi[kind]), `package.json pi.${kind} must be an array`);
    assert.deepEqual(manifest.pi[kind], expectedResources[kind], `package.json pi.${kind} must match the T09 activation boundary`);
  }
  assert.ok(Array.isArray(manifest.files) && manifest.files.includes("contract"), "package.json files must publish the contract directory");
  assert.ok(manifest.files.includes("assets"), "package.json files must publish direct-install system-prompt assets");
  assert.ok(manifest.files.includes("prompts"), "package.json files must publish the active portable prompt");
});

test("parity v2 records the direct-install policy, Engram protocol, and portable lean-audit projection", () => {
  const parity = readJson(join(root, expected.parityV2.path), "versioned parity v2 contract");
  assert.equal(parity.schemaVersion, expected.parityV2.schemaVersion);
  assert.deepEqual(projectionShape(parity.policy), expected.parityV2.policy, "parity v2 must record the system policy projection");
  assert.deepEqual(projectionShape(parity.engramProtocol), expected.parityV2.engramProtocol, "parity v2 must record the Engram protocol projection");
  assert.deepEqual(
    parity.commands?.map((command) => ({ name: command.name, ...projectionShape(command) })),
    expected.parityV2.commands,
    "parity v2 must record the portable lean-audit projection",
  );
});

test("package prompt activation matches the parity command targets", () => {
  const manifest = readJson(join(root, "package.json"), "package manifest");
  const parity = readJson(join(root, expected.parityV2.path), "versioned parity v2 contract");

  assert.deepEqual(
    manifest.pi?.prompts,
    parity.commands.map(({ targetPath }) => `./${targetPath}`),
    "package.json pi.prompts must activate exactly the portable commands recorded by parity v2",
  );
});

test("contract v1 describes a pinned, closed compatibility boundary", () => {
  const packageManifest = readJson(join(root, "package.json"), "package manifest");
  const contract = readJson(join(root, expected.contractPath), "versioned jorgex-pi contract");
  assert.equal(contract.schemaVersion, expected.schemaVersion);
  assert.equal(contract.package?.name, expected.packageName);
  assert.equal(contract.package?.version, packageManifest.version);
  assert.equal(contract.package?.source, `${expected.sourcePrefix}${packageManifest.version}`);
  assert.ok(Array.isArray(contract.pi?.testedVersions), "contract.pi.testedVersions must be an array");
  assert.equal(contract.pi.testedVersions.length, 1, "contract.pi.testedVersions must contain one exact authority");
  const [testedVersion] = contract.pi.testedVersions;
  assert.match(testedVersion, /^\d+\.\d+\.\d+$/, "the tested Pi authority must be an exact semver");
  assert.equal(contract.pi.minimumVersion, testedVersion, "pi.minimumVersion must equal the tested Pi authority");
  assert.equal(contract.pi.maximumVersion, testedVersion, "pi.maximumVersion must equal the tested Pi authority");
  assert.equal(
    packageManifest.devDependencies?.["@earendil-works/pi-coding-agent"],
    testedVersion,
    "the local Pi development dependency must match the tested Pi authority exactly",
  );
  assert.deepEqual(contract.capabilities, expected.capabilities, "contract capabilities must enumerate the activated versioned boundary");
  assert.deepEqual(contract.snapshot, expected.snapshot, "root contract must link the versioned Stack snapshot it advertises");
  assert.deepEqual(contract.runtimeAgents, expected.runtimeAgents, "root contract must link the runtime-agent contract");
  assert.equal(contract.assets?.manifestVersion, expected.foundationAssetManifest.manifestVersion);
  assert.equal(contract.assets?.manifestPath, expected.assetManifestPath);
  assert.equal(contract.components?.inventoryPath, expected.componentInventoryPath);
  assert.deepEqual(
    contract.schemas,
    expected.foundationSchemas,
    "foundation must not publish schemas for commands that PR01 does not implement",
  );
});

test("foundation asset ownership is explicit and closed", () => {
  const assetManifest = readJson(join(root, expected.assetManifestPath), "foundation asset manifest");
  assert.deepEqual(
    assetManifest,
    expected.foundationAssetManifest,
    "contract/assets.v1.json must distinguish JorgeX-managed writes from preserved companion state",
  );
});

test("candidate quality receipt projection stays separate from install and lifecycle receipts", () => {
  const parity = readJson(join(root, expected.parityV2.path), "versioned parity v2 contract");
  const assetManifest = readJson(join(root, expected.assetManifestPath), "foundation asset manifest");

  const qualityReceipt = parity.qualityReceipt;
  assert.ok(
    qualityReceipt && typeof qualityReceipt === "object" && !Array.isArray(qualityReceipt),
    "parity v2 must expose qualityReceipt as an object",
  );
  assert.deepEqual(
    Object.keys(qualityReceipt).sort(),
    ["namespace", "version", "sourcePath", "targetPath", "sourceSha256", "outputSha256"].sort(),
    "qualityReceipt must expose only its versioned schema projection fields",
  );
  assert.deepEqual(qualityReceipt, expected.parityV2.qualityReceipt, "qualityReceipt must match the candidate parity fixture");
  assert.equal(qualityReceipt.namespace, "jorgex.quality.receipt");
  assert.equal(qualityReceipt.version, 1);
  assert.equal(qualityReceipt.sourcePath, "stack/contracts/quality-receipt.v1.schema.json");
  assert.equal(qualityReceipt.targetPath, "contract/schemas/quality-receipt.v1.schema.json");
  assert.match(qualityReceipt.sourceSha256, /^[a-f0-9]{64}$/, "qualityReceipt.sourceSha256 must be a SHA-256 without pinning the source value yet");
  assert.match(qualityReceipt.outputSha256, /^[a-f0-9]{64}$/, "qualityReceipt.outputSha256 must be a SHA-256");
  assert.doesNotMatch(
    JSON.stringify(qualityReceipt),
    /pi-receipt\.json|sol-lifecycle\.v1\.json/i,
    "qualityReceipt must not reference the Stack installation receipt or Pi lifecycle receipt",
  );

  const targetPath = join(root, qualityReceipt.targetPath);
  assert.equal(
    existsSync(targetPath),
    true,
    `qualityReceipt target must exist at ${relative(root, targetPath)}`,
  );
  assert.equal(
    createHash("sha256").update(readFileSync(targetPath)).digest("hex"),
    qualityReceipt.outputSha256,
    "qualityReceipt.outputSha256 must match the target schema bytes",
  );

  assert.doesNotMatch(
    JSON.stringify(assetManifest),
    /jorgex\.quality\.receipt|quality[._-]?receipt/i,
    "the package asset manifest must not turn the quality receipt into Pi-managed external state",
  );
  assert.deepEqual(
    assetManifest.managedExternalWrites?.map(({ relativePath }) => relativePath),
    ["settings.json", "models.json", "jorgex-pi/sol-lifecycle.v1.json"],
    "Pi lifecycle ownership must remain limited to its existing settings, models, and lifecycle receipt paths",
  );
});

test("component inventory activates only the T09 companions and preserves the audited roadmap", () => {
  const inventory = readJson(join(root, expected.componentInventoryPath), "core component inventory");
  assert.equal(inventory.schemaVersion, expected.schemaVersion);
  assert.ok(Array.isArray(inventory.components), "component inventory must contain components[]");
  const byName = new Map(inventory.components.map((component) => [component.name, component]));
  assert.equal(byName.size, inventory.components.length, "component inventory names must be unique");
  assert.deepEqual([...byName.keys()].sort(), [...expected.requiredComponents].sort(), "component inventory must contain exactly the approved core companions");
  for (const name of expected.requiredComponents) {
    const component = byName.get(name);
    const expectedStatus = expected.activeComponents.includes(name) ? "active" : "audited";
    assert.equal(component.status, expectedStatus, `${name} must match its T09 activation state`);
    assertAuditedComponent(component, name);
  }
});

test("the pnpm-packed artifact contains every contract and declared resource", () => {
  readJson(join(root, "package.json"), "package manifest required before pnpm pack");
  const packDir = mkdtempSync(join(tmpdir(), "jorgex-pi-pack-"));
  try {
    const packageManager = resolvePnpm();
    execFileSync(packageManager.command, [...packageManager.args, "pack", "--pack-destination", packDir], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const packedFiles = readdirSync(packDir).filter((name) => name.endsWith(".tgz"));
    assert.equal(packedFiles.length, 1, "pnpm pack must produce exactly one tarball");
    const tarball = join(packDir, packedFiles[0]);
    const archive = readTgz(tarball);
    const headers = readTgzHeaders(tarball);
    const entries = new Set(archive.keys());
    const packageManifest = readPackedJson(archive, "package/package.json");
    const contract = readPackedJson(archive, `package/${expected.contractPath}`);
    assert.equal(entries.has("package/contract/parity.v1.json"), false, "packed artifact must retire the legacy parity v1 contract");
    const parity = readPackedJson(archive, `package/${expected.parityV2.path}`);
    readPackedJson(archive, `package/${expected.componentInventoryPath}`);
    const requiredPaths = new Set([
      "package/package.json",
      `package/${expected.contractPath}`,
      `package/${expected.componentInventoryPath}`,
      `package/${expected.assetManifestPath}`,
      ...expected.parityV2.requiredPackagePaths.map((path) => `package/${normalizePackagePath(path)}`),
      ...expected.foundationAssetManifest.resources.map((path) => `package/${normalizePackagePath(path)}`),
      ...expected.requiredPiResourceKinds.flatMap((kind) =>
        (packageManifest.pi[kind] ?? []).map((path) => `package/${normalizePackagePath(path)}`),
      ),
    ]);
    for (const path of requiredPaths) assertTarPath(entries, path);
    assertPackedParityTargets(archive, entries, parity);
    for (const path of expected.forbiddenTarPaths) {
      assert.equal(entries.has(path), false, `packed artifact must exclude build-only path ${path}`);
    }
    const allowedRoots = new Set(["agents", "assets", "bin", "contract", "extensions", "node_modules", "primary", "prompts", "skills", "themes"]);
    const allowedFiles = new Set(["package.json", "DESIGN.md", "LICENSE", "README.md"]);
    for (const path of entries) {
      const relativePath = path.replace(/^package\//, "");
      const [topLevel, snapshotKind] = relativePath.split("/");
      assert.equal(
        allowedFiles.has(relativePath) || allowedRoots.has(topLevel) || (topLevel === "snapshot" && snapshotKind === "agents"),
        true,
        `packed artifact contains non-whitelisted path ${path}`,
      );
    }
    const binHeader = headers.find(({ path }) => path === "package/bin/jorgex-pi.mjs");
    assert.ok(binHeader, "packed artifact must contain the public jorgex-pi bin");
    assert.notEqual(binHeader.mode & 0o111, 0, "the packed jorgex-pi bin must remain executable");
    const digest = createHash("sha256").update(readFileSync(tarball)).digest("hex");
    assert.match(digest, /^[a-f0-9]{64}$/, "packed artifact must be hashable for release evidence");
  } finally {
    rmSync(packDir, { recursive: true, force: true });
  }
});

function readJson(path, label) {
  let bytes;
  try {
    bytes = readFileSync(path, "utf8");
  } catch (error) {
    assert.fail(`${label} is missing at ${relative(root, path)} (${error.code ?? error.message})`);
  }
  try {
    return JSON.parse(bytes);
  } catch (error) {
    assert.fail(`${label} is not valid JSON at ${relative(root, path)} (${error.message})`);
  }
}

function assertPackedParityTargets(archive, entries, parity) {
  const expectedTargets = new Map();
  for (const agent of parity.agents) expectedTargets.set(`package/${agent.targetPath}`, agent.outputSha256);
  for (const skill of parity.skills) {
    for (const file of skill.files) expectedTargets.set(`package/${skill.targetPath}/${file.path}`, file.sha256);
  }
  expectedTargets.set(`package/${parity.policy.targetPath}`, parity.policy.outputSha256);
  expectedTargets.set(`package/${parity.engramProtocol.targetPath}`, parity.engramProtocol.outputSha256);
  expectedTargets.set(`package/${parity.qualityReceipt.targetPath}`, parity.qualityReceipt.outputSha256);
  for (const command of parity.commands) expectedTargets.set(`package/${command.targetPath}`, command.outputSha256);
  assert.equal(expectedTargets.size, expected.parityV2.ownedTargetCount, "the packed snapshot must contain every parity v2 target");

  const actualOwnedFiles = [...entries]
    .filter((path) => !path.endsWith("/") && (
      path.startsWith("package/snapshot/agents/")
      || path.startsWith("package/skills/")
      || path.startsWith("package/assets/system-prompt/")
      || path.startsWith("package/prompts/")
      || path === `package/${parity.qualityReceipt.targetPath}`
    ))
    .sort();
  assert.deepEqual(actualOwnedFiles, [...expectedTargets.keys()].sort(), "packed owned roots must contain every parity target and no untracked extras");

  for (const [path, expectedHash] of expectedTargets) {
    const bytes = archive.get(path);
    assert.ok(bytes, `${path} must be present in the packed artifact`);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), expectedHash, `${path} packed bytes must match parity`);
  }
}

function readPackedJson(archive, path) {
  const bytes = archive.get(path);
  assert.ok(bytes, `packed artifact is missing ${path}`);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    assert.fail(`${path} in packed artifact is not valid JSON (${error.message})`);
  }
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

function readTgzHeaders(path) {
  const tar = gunzipSync(readFileSync(path));
  const entries = [];
  let offset = 0;
  let nextPath;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = Number.parseInt(readTarString(header, 124, 12).trim() || "0", 8);
    const mode = Number.parseInt(readTarString(header, 100, 8).trim() || "0", 8);
    const type = String.fromCharCode(header[156] || 48);
    const body = tar.subarray(offset + 512, offset + 512 + size);
    const prefix = readTarString(header, 345, 155);
    const headerPath = [prefix, readTarString(header, 0, 100)].filter(Boolean).join("/");
    if (type === "x") nextPath = readPaxPath(body) ?? nextPath;
    else if (type === "L") nextPath = body.toString("utf8").replace(/\0.*$/s, "");
    else {
      entries.push({ path: nextPath ?? headerPath, mode, type });
      nextPath = undefined;
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function readTarString(header, start, length) {
  return header.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
}

function readPaxPath(bytes) {
  const text = bytes.toString("utf8");
  for (const record of text.match(/\d+ [^\n]*\n/g) ?? []) {
    const field = record.slice(record.indexOf(" ") + 1, -1);
    if (field.startsWith("path=")) return field.slice("path=".length);
  }
  return undefined;
}

function assertAuditedComponent(component, name) {
  assert.match(component.version ?? "", /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, `${name} must use an exact audited version`);
  assert.ok(!/[~^*xX]|latest/.test(component.version), `${name} audited version must not float`);
  assert.match(component.license ?? "", /\S/, `${name} must record its reviewed license once audited`);
  assert.match(component.integrity ?? "", /^sha512-[A-Za-z0-9+/]+={0,2}$/, `${name} must record npm sha512 integrity once audited`);
}

function assertNonEmptyStringArray(value, label) {
  assert.ok(Array.isArray(value) && value.length > 0, `${label} must be a non-empty array`);
  for (const entry of value) assert.match(entry, /\S/, `${label} entries must be non-empty strings`);
}

function assertTarPath(entries, expectedPath) {
  const normalized = normalizePackagePath(expectedPath);
  assert.ok(entries.has(normalized) || [...entries].some((entry) => entry.startsWith(`${normalized}/`)), `packed artifact is missing ${normalized}`);
}

function normalizePackagePath(path) {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
}

function projectionShape(projection) {
  return {
    sourcePath: projection?.sourcePath,
    targetPath: projection?.targetPath,
  };
}

function resolvePnpm() {
  const corepackEntry = join(dirname(process.execPath), "node_modules", "corepack", "dist", "corepack.js");
  return existsSync(corepackEntry)
    ? { command: process.execPath, args: [corepackEntry, "pnpm"] }
    : process.platform === "win32"
      ? { command: process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe", args: ["/d", "/s", "/c", "pnpm.cmd"] }
      : { command: "pnpm", args: [] };
}
