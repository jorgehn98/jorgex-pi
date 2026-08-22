import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(testDir, "..");
const expected = readJson(join(testDir, "fixtures", "foundation-contract.expected.json"), "foundation contract fixture");

test("package manifest reserves empty Pi resource arrays for later capability PRs", () => {
  const manifest = readJson(join(root, "package.json"), "package manifest required by the published Pi package");
  assert.equal(manifest.name, expected.packageName);
  assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  assert.ok(manifest.pi && typeof manifest.pi === "object", "package.json must declare a pi manifest");
  for (const kind of expected.requiredPiResourceKinds) {
    assert.ok(Array.isArray(manifest.pi[kind]), `package.json pi.${kind} must be an array`);
    assert.deepEqual(
      manifest.pi[kind],
      expected.foundationResources,
      `package.json pi.${kind} must stay empty in PR01; its resources belong to a later capability PR`,
    );
  }
  assert.ok(Array.isArray(manifest.files) && manifest.files.includes("contract"), "package.json files must publish the contract directory");
});

test("contract v1 describes a pinned, closed compatibility boundary", () => {
  const packageManifest = readJson(join(root, "package.json"), "package manifest");
  const contract = readJson(join(root, expected.contractPath), "versioned jorgex-pi contract");
  assert.equal(contract.schemaVersion, expected.schemaVersion);
  assert.equal(contract.package?.name, expected.packageName);
  assert.equal(contract.package?.version, packageManifest.version);
  assert.equal(contract.package?.source, `${expected.sourcePrefix}${packageManifest.version}`);
  assertClosedPiCompatibility(contract.pi);
  assertNonEmptyStringArray(contract.capabilities, "contract capabilities");
  assert.equal(contract.assets?.manifestVersion, expected.assetManifestVersion);
  assert.equal(contract.assets?.manifestPath, expected.assetManifestPath);
  assert.equal(contract.components?.inventoryPath, expected.componentInventoryPath);
  const assetManifest = readJson(join(root, expected.assetManifestPath), "foundation asset manifest");
  assert.equal(assetManifest.schemaVersion, expected.schemaVersion);
  assert.equal(assetManifest.manifestVersion, expected.assetManifestVersion);
  assert.deepEqual(
    assetManifest.resources,
    expected.foundationResources,
    "contract/assets.v1.json resources must be empty in foundation",
  );
  assert.deepEqual(
    contract.schemas,
    expected.foundationSchemas,
    "foundation must not publish schemas for commands that PR01 does not implement",
  );
});

test("component inventory records the approved roadmap without activating future companions", () => {
  const inventory = readJson(join(root, expected.componentInventoryPath), "core component inventory");
  assert.equal(inventory.schemaVersion, expected.schemaVersion);
  assert.ok(Array.isArray(inventory.components), "component inventory must contain components[]");
  const byName = new Map(inventory.components.map((component) => [component.name, component]));
  assert.equal(byName.size, inventory.components.length, "component inventory names must be unique");
  assert.deepEqual([...byName.keys()].sort(), [...expected.requiredComponents].sort(), "component inventory must contain exactly the approved core companions");
  for (const name of expected.requiredComponents) {
    const component = byName.get(name);
    assert.equal(component.status, expected.requiredComponentStatus, `${name} must remain audited and inactive in PR01`);
    assertAuditedComponent(component, name);
  }
});

test("the pnpm-packed artifact contains every contract and declared resource", () => {
  readJson(join(root, "package.json"), "package manifest required before pnpm pack");
  const packDir = mkdtempSync(join(tmpdir(), "jorgex-pi-pack-"));
  try {
    execFileSync("pnpm", ["pack", "--pack-destination", packDir], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const packedFiles = readdirSync(packDir).filter((name) => name.endsWith(".tgz"));
    assert.equal(packedFiles.length, 1, "pnpm pack must produce exactly one tarball");
    const tarball = join(packDir, packedFiles[0]);
    const entries = new Set(execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).trim().split(/\r?\n/).filter(Boolean));
    const packageManifest = readTarJson(tarball, "package/package.json");
    const contract = readTarJson(tarball, `package/${expected.contractPath}`);
    readTarJson(tarball, `package/${expected.componentInventoryPath}`);
    const requiredPaths = new Set([
      "package/package.json",
      `package/${expected.contractPath}`,
      `package/${expected.componentInventoryPath}`,
      `package/${expected.assetManifestPath}`,
      ...expected.requiredPiResourceKinds.flatMap((kind) =>
        (packageManifest.pi[kind] ?? []).map((path) => `package/${normalizePackagePath(path)}`),
      ),
    ]);
    for (const path of requiredPaths) assertTarPath(entries, path);
    for (const kind of expected.requiredPiResourceKinds) {
      if ((packageManifest.pi[kind] ?? []).length === 0) {
        assert.equal(
          [...entries].some((entry) => entry.startsWith(`package/${kind}/`)),
          false,
          `packed artifact must not contain an undeclared package/${kind}/ directory`,
        );
      }
    }
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

function readTarJson(tarball, entry) {
  const bytes = execFileSync("tar", ["-xOzf", tarball, entry], { encoding: "utf8" });
  try {
    return JSON.parse(bytes);
  } catch (error) {
    assert.fail(`${entry} in packed artifact is not valid JSON (${error.message})`);
  }
}

function assertClosedPiCompatibility(pi) {
  assert.ok(pi && typeof pi === "object", "contract must describe tested Pi compatibility");
  assert.match(pi.minimumVersion ?? "", /^\d+\.\d+\.\d+$/, "pi.minimumVersion must be exact semver");
  assert.match(pi.maximumVersion ?? "", /^\d+\.\d+\.\d+$/, "pi.maximumVersion must be exact semver");
  assertNonEmptyStringArray(pi.testedVersions, "pi.testedVersions");
  assert.ok(pi.testedVersions.includes(pi.minimumVersion), "minimum Pi version must have been tested");
  assert.ok(pi.testedVersions.includes(pi.maximumVersion), "maximum Pi version must have been tested");
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
