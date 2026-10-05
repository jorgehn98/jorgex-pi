import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as release from "../scripts/release-policy.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const manifest = JSON.parse(read("package.json"));

// The manifest is the native discovery and distribution boundary.
test("the independent package exposes only compact tools and host-provided peers", () => {
  assert.equal(manifest.name, "compact-tools");
  assert.deepEqual(manifest.pi, { extensions: ["./extensions/compact-tools.ts"] });
  assert.deepEqual(manifest.files, ["extensions/compact-tools.ts", "README.md", "LICENSE"]);
  assert.deepEqual(manifest.peerDependencies, {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
  });
  assert.equal(manifest.dependencies, undefined);
  assert.equal(manifest.bin, undefined);
  assert.equal(manifest.private, undefined);
  assert.equal(manifest.publishConfig.access, "public");
});

test("only shipped resources trigger an automatic patch release", () => {
  assert.deepEqual(release.classifyReleasePaths([
    "extensions/compact-tools.ts", "README.md", "tests/compact-tools.test.mjs",
    ".github/workflows/publish.yml", "scripts/release-policy.mjs", "AGENTS.md",
  ]), {
    publicPaths: ["extensions/compact-tools.ts", "README.md"],
    testPaths: ["tests/compact-tools.test.mjs"],
    workflowPaths: [".github/workflows/publish.yml"],
    scriptPaths: ["scripts/release-policy.mjs"],
    ignoredPaths: ["AGENTS.md"],
  });
  const input = { currentVersion: "0.2.0", currentVersionExists: true, publicable: true,
    releaseBumpCommit: false, recoveryRun: false, versionExists: version => version === "0.2.1" };
  assert.deepEqual(release.buildReleasePlan(input), { publish: true, bump: true, version: "0.2.2", reason: "publicable_patch" });
  assert.equal(release.buildReleasePlan({ ...input, publicable: false }).publish, false);
  assert.equal(release.buildReleasePlan({ ...input, recoveryRun: true }).publish, false);
  assert.equal(release.buildReleasePlan({ ...input, releaseBumpCommit: true }).publish, false);
  assert.deepEqual(release.buildReleasePlan({ ...input, currentVersionExists: false }),
    { publish: true, bump: false, version: "0.2.0", reason: "unpublished_version" });
});

test("a missing npm package is unpublished, but authentication errors still block", () => {
  const execute = message => () => { throw new Error(message); };
  assert.equal(release.npmHasVersion("compact-tools", "0.2.0", execute("[ERR_PNPM_FETCH_404] Not Found - 404")), false);
  assert.throws(() => release.npmHasVersion("compact-tools", "0.2.0", execute("ERR_PNPM_FETCH_401")), /401/);
});

test("version updates need no parallel contract and tags cannot collide with legacy releases", () => {
  const original = { name: "compact-tools", version: "0.2.0", untouched: true };
  assert.deepEqual(release.withReleaseVersion(original, "0.2.1"), { ...original, version: "0.2.1" });
  assert.equal(original.version, "0.2.0");
  assert.equal(release.releaseTag("0.2.1"), "compact-tools-v0.2.1");
});

test("published releases retain immutable tags and explicit missing-tag recovery", () => {
  const input = { currentVersion: "0.2.0", currentVersionExists: true, currentTagSha: null,
    recoveryRun: false, releaseShaProvided: false };
  assert.throws(() => release.assertReleaseBaseline(input), /Recover its exact published SHA/);
  assert.throws(() => release.assertReleaseBaseline({ ...input, recoveryRun: true }), /requires the exact release_sha/);
  assert.doesNotThrow(() => release.assertReleaseBaseline({ ...input, recoveryRun: true, releaseShaProvided: true }));
  const tag = { version: "0.2.0", tagSha: "a".repeat(40), publishSha: "b".repeat(40), publish: false, recoveryRun: false };
  assert.deepEqual(release.resolveReleaseTagState(tag), { tagNeeded: false });
  assert.throws(() => release.resolveReleaseTagState({ ...tag, publish: true }), /already points to/);
});

test("release keeps OIDC separate from repository writes and publishes the selected tarball", () => {
  const workflow = read(".github/workflows/publish.yml");
  const job = name => workflow.split(`\n  ${name}:\n`)[1]?.split(/\n  [\w-]+:\n/)[0] ?? "";
  assert.match(workflow, /concurrency:[\s\S]*?cancel-in-progress: false/);
  assert.match(workflow, /release_sha:/);
  assert.match(job("validate"), /name !== "compact-tools"/);
  assert.match(job("plan"), /contents: write/);
  assert.doesNotMatch(job("plan"), /id-token: write/);
  assert.match(job("publish"), /contents: read[\s\S]*id-token: write/);
  assert.doesNotMatch(job("publish"), /contents: write/);
  assert.match(job("publish"), /npm publish \.release-artifacts\/compact-tools-\$\{\{ needs.plan.outputs.version \}\}\.tgz --ignore-scripts --provenance/);
  assert.match(job("tag-release"), /tag="compact-tools-v\$VERSION"/);
  assert.doesNotMatch(workflow, /secrets\.|create-github-app-token|notify-stack|parity/);
  const quality = read(".github/workflows/quality.yml");
  assert.match(quality, /pull_request:/);
  assert.match(quality, /contents: read/);
  assert.doesNotMatch(quality, /id-token: write|contents: write|npm publish|secrets\./);
});
