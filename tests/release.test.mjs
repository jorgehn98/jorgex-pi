import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertReleaseBaseline,
  buildReleasePlan,
  classifyReleasePaths,
  resolveReleaseTagState,
  synchronizeReleaseMetadata,
} from "../scripts/release-policy.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseVersion = readJson(join(root, "package.json")).version;
const repositoryUrl = "https://github.com/jorgehn98/jorgex-pi";
const reviewedActions = new Set([
  "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
  "pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86",
  "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
]);

test("the public package metadata identifies the exact minor release candidate", () => {
  const manifest = readJson(join(root, "package.json"));
  const contract = readJson(join(root, "contract", "jorgex-pi.v1.json"));

  assert.equal(releaseVersion, "0.4.0", "parity v2 and direct-install projections require the planned minor release");
  assert.equal(manifest.version, releaseVersion);
  assert.equal(Object.hasOwn(manifest, "private"), false, "the public package must not retain the private flag");
  assert.deepEqual(manifest.repository, { type: "git", url: `${repositoryUrl}.git` });
  assert.equal(manifest.homepage, `${repositoryUrl}#readme`);
  assert.deepEqual(manifest.bugs, { url: `${repositoryUrl}/issues` });
  assert.equal(manifest.publishConfig?.access, "public");
  assert.equal(contract.package.version, releaseVersion);
  assert.equal(contract.package.source, `npm:jorgex-pi@${releaseVersion}`);
});

test("the release policy publishes manual versions and only auto-bumps publicable changes", () => {
  assert.deepEqual(classifyReleasePaths([
    "extensions/bootstrap.ts",
    "contract/jorgex-pi.v1.json",
    "README.md",
    "tests/release.test.mjs",
    ".github/workflows/publish.yml",
    "scripts/release-policy.mjs",
    "AGENTS.md",
  ]), {
    publicPaths: ["extensions/bootstrap.ts", "contract/jorgex-pi.v1.json", "README.md"],
    ignoredPaths: ["AGENTS.md"],
    testPaths: ["tests/release.test.mjs"],
    workflowPaths: [".github/workflows/publish.yml"],
    scriptPaths: ["scripts/release-policy.mjs"],
  });

  assert.deepEqual(buildReleasePlan({
    currentVersion: "0.2.0",
    currentVersionExists: false,
    publicable: false,
    releaseBumpCommit: false,
    recoveryRun: false,
    versionExists: () => false,
  }), { publish: true, bump: false, version: "0.2.0", reason: "unpublished_version" });

  assert.deepEqual(buildReleasePlan({
    currentVersion: "0.2.0",
    currentVersionExists: true,
    publicable: true,
    releaseBumpCommit: false,
    recoveryRun: false,
    versionExists: (version) => version === "0.2.1",
  }), { publish: true, bump: true, version: "0.2.2", reason: "publicable_patch" });

  assert.deepEqual(buildReleasePlan({
    currentVersion: "0.2.0",
    currentVersionExists: true,
    publicable: false,
    releaseBumpCommit: false,
    recoveryRun: false,
    versionExists: () => false,
  }), { publish: false, bump: false, version: "0.2.0", reason: "no_publicable_changes" });

  assert.deepEqual(buildReleasePlan({
    currentVersion: "0.2.0",
    currentVersionExists: true,
    publicable: true,
    releaseBumpCommit: false,
    recoveryRun: true,
    versionExists: () => false,
  }), { publish: false, bump: false, version: "0.2.0", reason: "published_recovery" });

  assert.deepEqual(buildReleasePlan({
    currentVersion: "0.2.1",
    currentVersionExists: false,
    publicable: true,
    releaseBumpCommit: true,
    recoveryRun: false,
    versionExists: () => false,
  }), { publish: false, bump: false, version: "0.2.1", reason: "release_bump_commit" });
});

test("automatic patch bumps keep package and root contract synchronized", () => {
  const manifest = { name: "jorgex-pi", version: "0.2.0", untouched: true };
  const contract = { package: { name: "jorgex-pi", version: "0.2.0", source: "npm:jorgex-pi@0.2.0" }, schemaVersion: 1 };
  assert.deepEqual(synchronizeReleaseMetadata({ manifest, contract, version: "0.2.1" }), {
    manifest: { name: "jorgex-pi", version: "0.2.1", untouched: true },
    contract: { package: { name: "jorgex-pi", version: "0.2.1", source: "npm:jorgex-pi@0.2.1" }, schemaVersion: 1 },
  });
  assert.equal(manifest.version, "0.2.0", "the pure policy must not mutate caller-owned objects");
});

test("published releases use an immutable tag baseline and require exact recovery when it is missing", () => {
  assert.doesNotThrow(() => assertReleaseBaseline({
    currentVersion: "0.2.0",
    currentVersionExists: true,
    currentTagSha: "a".repeat(40),
    recoveryRun: false,
    releaseShaProvided: false,
  }));
  assert.throws(() => assertReleaseBaseline({
    currentVersion: "0.2.0",
    currentVersionExists: true,
    currentTagSha: null,
    recoveryRun: false,
    releaseShaProvided: false,
  }), /Recover its exact published SHA/);
  assert.throws(() => assertReleaseBaseline({
    currentVersion: "0.2.0",
    currentVersionExists: true,
    currentTagSha: null,
    recoveryRun: true,
    releaseShaProvided: false,
  }), /requires the exact release_sha/);
  assert.doesNotThrow(() => assertReleaseBaseline({
    currentVersion: "0.2.0",
    currentVersionExists: true,
    currentTagSha: null,
    recoveryRun: true,
    releaseShaProvided: true,
  }));
});

test("non-publishing merges leave the existing immutable release tag untouched", () => {
  assert.deepEqual(resolveReleaseTagState({
    version: "0.2.0",
    tagSha: "a".repeat(40),
    publishSha: "b".repeat(40),
    publish: false,
    recoveryRun: false,
  }), { tagNeeded: false });

  assert.throws(() => resolveReleaseTagState({
    version: "0.2.0",
    tagSha: "a".repeat(40),
    publishSha: "b".repeat(40),
    publish: true,
    recoveryRun: false,
  }), /already points to/);

  assert.throws(() => resolveReleaseTagState({
    version: "0.2.0",
    tagSha: "a".repeat(40),
    publishSha: "b".repeat(40),
    publish: false,
    recoveryRun: true,
  }), /already points to/);
});

test("the publish workflow is main-gated, recoverable, OIDC-only, and release-content preserving", () => {
  const workflowPath = join(root, ".github", "workflows", "publish.yml");
  assert.equal(existsSync(workflowPath), true, "the public release workflow must exist");
  const workflow = readFileSync(workflowPath, "utf8").replace(/\r\n/g, "\n");

  const triggerLines = topLevelBlock(workflow, "on").split(/\r?\n/)
    .map((line) => line.trim().replace(/^-\s*["'](.*)["']$/, "- $1"))
    .filter((line) => line && !line.startsWith("#"));
  assert.deepEqual(triggerLines, [
    "push:",
    "branches:",
    "- main",
    "workflow_dispatch:",
    "inputs:",
    "release_sha:",
    "description: SHA completa de 40 hex de recuperación anclada a main (opcional)",
    "required: false",
  ], "publishing must be triggered by main pushes and expose only the pinned recovery input");
  assert.match(workflow, /actions\/checkout@[a-f0-9]{40}[\s\S]*?ref:\s*main/, "validation must test the current serialized main head so rapid merges cannot lose publicable changes");

  const permissions = topLevelBlock(workflow, "permissions");
  assert.deepEqual(readFlatMap(permissions), { contents: "read" });
  assert.equal((workflow.match(/^permissions:/gm) ?? []).length, 1, "permissions must be declared once at workflow scope");
  const actionUses = [...workflow.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)\s*$/gm)].map((match) => match[1]);
  assert.ok(actionUses.length >= 3, "the release pipeline must contain its reviewed setup actions");
  for (const action of actionUses) assert.match(action, /@[a-f0-9]{40}$/, `release action must not use a mutable tag: ${action}`);
  for (const action of actionUses) assert.equal(reviewedActions.has(action), true, "release action is not in the reviewed allowlist: " + action);
  const runners = [...workflow.matchAll(/^\s*runs-on:\s*([^\s#]+)\s*$/gm)].map((match) => match[1]);
  assert.ok(runners.length >= 3, "validation, planning, publishing and tagging must be isolated jobs");
  assert.ok(runners.every((runner) => runner === "ubuntu-latest"), "publishing must use only GitHub-hosted runners");
  assert.doesNotMatch(workflow, /self-hosted/i);

  const nodeVersion = workflow.match(/node-version:\s*["']?(\d+(?:\.\d+){0,2})["']?/)?.[1];
  const npmVersion = workflow.match(/MINIMUM_NPM_VERSION:\s*["']?(\d+\.\d+\.\d+)["']?/)?.[1];
  assert.equal(versionAtLeast(nodeVersion, "22.14.0"), true, "setup-node must select Node >=22.14.0");
  assert.equal(versionAtLeast(npmVersion, "11.5.1"), true, "the workflow must require npm >=11.5.1");

  for (const command of [
    "pnpm install --frozen-lockfile",
    "pnpm test",
    "pnpm pack",
    "node ./scripts/release-policy.mjs plan",
  ]) assert.ok(workflow.includes(command), `workflow is missing required command: ${command}`);

  const npmCommands = workflow.split(/\r?\n/)
    .map((line) => line.trim().replace(/^run:\s*/, ""))
    .filter((line) => line.startsWith("npm "));
  assert.equal(npmCommands.length, 1, "publish is the only direct npm command allowed");
  assert.match(npmCommands[0] ?? "", /^npm publish\b/, "the only direct npm command must publish");
  assert.doesNotMatch(workflow, /(?:^|[\s;&|])npm\s+(?:version|pack|install)\b/im, "standalone npm may only publish");
  assert.doesNotMatch(workflow, /NPM_TOKEN|secrets\.|^\s*(?:token|github-token):|pnpm\s+version|gh\s+release|changeset/i);
  assert.match(workflow, /id-token:\s*write/, "only the publish job must receive OIDC authority");
  assert.match(workflow, /contents:\s*write/, "version and tag jobs require narrowly scoped repository writes");
  const planJob = workflow.split("\n  plan:\n")[1]?.split("\n  publish:\n")[0] ?? "";
  const publishJob = workflow.split("\n  publish:\n")[1]?.split("\n  tag-release:\n")[0] ?? "";
  assert.doesNotMatch(planJob, /id-token:\s*write/, "the repository-write planning job must not receive OIDC");
  assert.match(publishJob, /contents:\s*read[\s\S]*id-token:\s*write/, "the publish job must be read-only except for OIDC");
  assert.doesNotMatch(publishJob, /contents:\s*write/, "the npm publish job must not write to the repository");
  assert.doesNotMatch(publishJob, /\bcache:\s*(?:pnpm|npm|yarn)\b/, "the privileged release build must not reuse a package-manager cache");
  assert.match(publishJob, /npm_version="\$\(npm --version\)"/, "the release job must verify the npm bundled with Node without a global install");
  assert.doesNotMatch(publishJob, /pnpm\s+(?:add|install)\s+--global\s+npm\b/, "the release job must not depend on pnpm global-bin configuration");
  assert.match(workflow, /git\s+tag/, "the verified release SHA must receive its immutable version tag");
  assert.match(workflow, /git\s+push\s+origin/, "the release commit and tag must be pushed explicitly");
});

test("pull requests execute the reviewed actions in a non-privileged quality gate", () => {
  const workflowPath = join(root, ".github", "workflows", "quality.yml");
  assert.equal(existsSync(workflowPath), true, "the pull-request quality workflow must exist");
  const workflow = readFileSync(workflowPath, "utf8");

  assert.deepEqual(topLevelBlock(workflow, "on").trim(), "pull_request:");
  assert.deepEqual(readFlatMap(topLevelBlock(workflow, "permissions")), { contents: "read" });
  assert.doesNotMatch(workflow, /id-token:\s*write|contents:\s*write|npm publish|secrets\./i);

  const actionUses = [...workflow.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)\s*$/gm)].map((match) => match[1]);
  assert.deepEqual(actionUses, [...reviewedActions], "quality must use each reviewed setup action exactly once and in order");
  for (const action of actionUses) assert.match(action, /@[a-f0-9]{40}$/, `quality action must not use a mutable tag: ${action}`);
  for (const action of actionUses) assert.equal(reviewedActions.has(action), true, "quality action is not in the reviewed allowlist: " + action);
  assert.equal(workflow.match(/node-version:\s*["']?(\d+)["']?/)?.[1], "24", "quality must exercise the actions under Node 24");

  for (const command of [
    "pnpm install --frozen-lockfile",
    "pnpm test",
    "pnpm pack --pack-destination .validation-artifacts",
  ]) assert.ok(workflow.includes(command), `quality workflow is missing required command: ${command}`);
});

test("the publish workflow publishes the exact deterministic tarball created by pnpm pack", () => {
  const workflow = readFileSync(join(root, ".github", "workflows", "publish.yml"), "utf8");
  const artifactDirectory = ".release-artifacts";
  const artifactPath = `${artifactDirectory}/jorgex-pi-\${{ needs.plan.outputs.version }}.tgz`;

  assert.match(
    workflow,
    new RegExp(`run:\\s*\\|\\s*\\n\\s*mkdir -p ${escapeRegExp(artifactDirectory)}\\s*\\n\\s*pnpm pack --pack-destination ${escapeRegExp(artifactDirectory)}\\s*(?:\\n|$)`),
    "Pack must create a deterministic artifact directory and place the tarball there with pnpm pack",
  );
  assert.match(
    workflow,
    new RegExp(`run:\\s*npm publish ${escapeRegExp(artifactPath)} --ignore-scripts --provenance\\s*(?:\\n|$)`),
    "npm publish must receive the exact tarball created by Pack",
  );
  assert.doesNotMatch(
    workflow,
    /run:\s*npm publish\s+--ignore-scripts\s+--provenance\s*(?:\n|$)/,
    "npm publish without an artifact path would silently package the working tree again",
  );
  assert.doesNotMatch(
    workflow,
    new RegExp(`run:\\s*npm publish ${escapeRegExp(artifactDirectory)}/jorgex-pi-\\d+\\.\\d+\\.\\d+(?:[-+][\\w.-]+)?\\.tgz\\b`),
    "the artifact path must derive its version from the validated tag, never from a release-specific literal",
  );
});

test("the release guide explains automatic publishing and coordinated Stack adoption", () => {
  const readme = readFileSync(join(root, "README.md"), "utf8");
  const trustedPublisher = readme.split(/\n\s*\n/).find((paragraph) => /trusted publisher/i.test(paragraph));
  assert.ok(trustedPublisher, "README must document the external npm trusted publisher prerequisite");
  assert.match(trustedPublisher, /npm(?:js\.com| package| settings)/i, "trusted publisher setup must happen in npm, outside the workflow");
  assert.match(trustedPublisher, /jorgehn98\/jorgex-pi/i, "README must identify the authorized GitHub repository");
  assert.match(trustedPublisher, /(?:\.github\/workflows\/)?publish\.yml/i, "README must identify the authorized workflow filename");
  assert.match(trustedPublisher, /before[^.\n]*(?:publish|release|main)/i, "trusted publisher setup must be required before automatic publishing");
  assert.match(trustedPublisher, /(?:workflow|repository)[^.\n]*(?:does not|cannot|is not)[^.\n]*(?:configure|sufficient|enough)/i, "README must not imply that committing the workflow configures npm automatically");
  assert.match(readme, /push[^.\n]*main/i, "README must identify main pushes as the automatic release trigger");
  assert.match(readme, /patch[^.\n]*(?:automatic|automático|increment)/i, "README must explain automatic patch bumps");
  assert.match(readme, /minor[^.\n]*major[^.\n]*(?:manual|human)/i, "README must keep minor and major version decisions manual");
  assert.match(readme, /(?:24[- ]hour|24 horas)[^.\n]*Stack/i, "README must retain the managed Stack maturity window");
});

function topLevelBlock(yaml, key) {
  const lines = yaml.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `${key}:`);
  assert.notEqual(start, -1, `workflow is missing top-level ${key}`);
  const block = [];
  for (const line of lines.slice(start + 1)) {
    if (/^[^\s#][^:]*:/.test(line)) break;
    block.push(line);
  }
  return block.join("\n");
}

function readFlatMap(block) {
  return Object.fromEntries([...block.matchAll(/^\s+([\w-]+):\s*([^\s#]+)\s*$/gm)].map((match) => [match[1], match[2]]));
}

function versionAtLeast(actual, minimum) {
  if (!actual) return false;
  const left = actual.split(".").map(Number);
  const right = minimum.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if ((left[index] ?? 0) !== (right[index] ?? 0)) return (left[index] ?? 0) > (right[index] ?? 0);
  }
  return true;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
