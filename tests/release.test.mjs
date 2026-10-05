import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as release from "../scripts/release-policy.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const manifest = JSON.parse(read("package.json"));
const sha = "a".repeat(40);
const otherSha = "b".repeat(40);
const integrity = "sha512-" + "A".repeat(86) + "==";
const input = { version: "0.8.48", registry: null, tagSha: null, sha, mainSha: sha, recovery: false };

test("the independent package exposes only compact tools and host-provided peers", () => {
  assert.equal(manifest.name, "compact-tools");
  assert.deepEqual(manifest.pi, { extensions: ["./extensions/compact-tools.ts"] });
  assert.deepEqual(manifest.files, ["extensions/compact-tools.ts", "README.md", "LICENSE"]);
  assert.deepEqual(manifest.peerDependencies, {
    "@earendil-works/pi-coding-agent": "*", "@earendil-works/pi-tui": "*",
  });
  assert.equal(manifest.dependencies, undefined);
  assert.equal(manifest.bin, undefined);
  assert.equal(manifest.private, undefined);
  assert.equal(manifest.publishConfig.access, "public");
});

test("PR versions publish once; ordinary pushes never generate a patch", () => {
  assert.deepEqual(release.releasePlan(input), { publish: true, needed: true });
  assert.deepEqual(release.releasePlan({ ...input, registry: { integrity }, tagSha: otherSha }), { publish: false, needed: false });
  assert.throws(() => release.releasePlan({ ...input, registry: { integrity } }), /release_sha/);
  assert.throws(() => release.releasePlan({ ...input, mainSha: otherSha }), /historical/);
  assert.throws(() => release.releasePlan({ ...input, tagSha: otherSha }), /different SHA/);
});

test("recovery binds exact SHA and SRI without republishing or moving tags", () => {
  assert.deepEqual(release.releasePlan({ ...input, recovery: true, registry: { integrity }, mainSha: otherSha }), { publish: false, needed: true });
  assert.throws(() => release.releasePlan({ ...input, recovery: true, registry: { integrity }, tagSha: otherSha }), /different SHA/);
  assert.throws(() => release.verifyIntegrity({ integrity: "sha512-different" }, integrity), /integrity/);
  assert.throws(() => release.verifyIntegrity(null, integrity), /unavailable/);
  release.verifyIntegrity({ integrity }, integrity);
  assert.equal(release.publicationNeeded(null, integrity, true), true);
  assert.equal(release.publicationNeeded({ integrity }, integrity, true, true), false); // rerun after successful publish
  assert.throws(() => release.publicationNeeded(null, integrity, true, true), /never republish/);
  assert.equal(release.publicationNeeded({ integrity }, integrity, false), false); // recovery
  assert.throws(() => release.publicationNeeded(null, integrity, false), /unavailable/);
  assert.throws(() => release.publicationNeeded({ integrity: "sha512-different" }, integrity, true), /integrity/);
});

test("only 404 means absent; registry/auth/network errors fail closed", async () => {
  const fetcher = (status, value = {}) => async () => ({ status, ok: status === 200, json: async () => value });
  assert.equal(await release.registryVersion("compact-tools", "0.8.48", fetcher(404)), null);
  await assert.rejects(release.registryVersion("compact-tools", "0.8.48", fetcher(403)), /403/);
  await assert.rejects(release.registryVersion("compact-tools", "0.8.48", fetcher(200)), /metadata/);
  await assert.rejects(release.registryVersion("compact-tools", "0.8.48", async () => { throw new Error("network"); }), /network/);
  assert.deepEqual(await release.registryVersion("compact-tools", "0.8.48", fetcher(200, { name: "compact-tools", version: "0.8.48", dist: { integrity } })), { integrity });
});

test("real tarball bytes and package version are checked before registry access", () => {
  const temp = mkdtempSync("/var/tmp/pi-release-test-");
  try {
    mkdirSync(join(temp, "package"));
    writeFileSync(join(temp, "package/package.json"), JSON.stringify({ name: "compact-tools", version: "0.8.48" }));
    const tarball = join(temp, "package.tgz");
    execFileSync("tar", ["-czf", tarball, "-C", temp, "package"], { timeout: 5_000 });
    const result = spawnSync(process.execPath, ["scripts/release-policy.mjs", "verify", tarball], {
      cwd: root, env: { ...process.env, VERSION: "0.8.48", INTEGRITY: integrity }, encoding: "utf8", timeout: 5_000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Artifact changed after validation/);
    const wrongVersion = spawnSync(process.execPath, ["scripts/release-policy.mjs", "verify", tarball], {
      cwd: root, env: { ...process.env, VERSION: "0.8.49", INTEGRITY: integrity }, encoding: "utf8", timeout: 5_000,
    });
    assert.equal(wrongVersion.status, 1);
    assert.match(wrongVersion.stderr, /Tarball package\/version differs/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("placeholders and mutable refs are not release candidates", () => {
  assert.equal(release.validateVersion("0.8.48"), "0.8.48");
  for (const version of ["0.0.0-stage", "00.8.48", "0.8", "0.8.48\n"]) assert.throws(() => release.validateVersion(version));
  assert.equal(release.normalizeSha(sha.toUpperCase()), sha);
  assert.throws(() => release.normalizeSha("main"), /40/);
});
