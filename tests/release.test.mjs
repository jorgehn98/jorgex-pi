import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseVersion = "0.1.0";
const repositoryUrl = "https://github.com/jorgehn98/jorgex-pi";

test("the public package metadata identifies the exact first release", () => {
  const manifest = readJson(join(root, "package.json"));
  const contract = readJson(join(root, "contract", "jorgex-pi.v1.json"));

  assert.equal(manifest.version, releaseVersion);
  assert.equal(Object.hasOwn(manifest, "private"), false, "the public package must not retain the private flag");
  assert.deepEqual(manifest.repository, { type: "git", url: `${repositoryUrl}.git` });
  assert.equal(manifest.homepage, `${repositoryUrl}#readme`);
  assert.deepEqual(manifest.bugs, { url: `${repositoryUrl}/issues` });
  assert.equal(manifest.publishConfig?.access, "public");
  assert.equal(contract.package.version, releaseVersion);
  assert.equal(contract.package.source, `npm:jorgex-pi@${releaseVersion}`);
});

test("the publish workflow is tag-gated, OIDC-only, and release-content preserving", () => {
  const workflowPath = join(root, ".github", "workflows", "publish.yml");
  assert.equal(existsSync(workflowPath), true, "the public release workflow must exist");
  const workflow = readFileSync(workflowPath, "utf8");

  const triggerLines = topLevelBlock(workflow, "on").split(/\r?\n/)
    .map((line) => line.trim().replace(/^-\s*["'](.*)["']$/, "- $1"))
    .filter((line) => line && !line.startsWith("#"));
  assert.deepEqual(triggerLines, ["push:", "tags:", "- v*"], "publishing must be triggered only by v* tags");

  const permissions = topLevelBlock(workflow, "permissions");
  assert.deepEqual(readFlatMap(permissions), { contents: "read", "id-token": "write" });
  assert.equal((workflow.match(/^permissions:/gm) ?? []).length, 1, "permissions must be declared once at workflow scope");
  const actionUses = [...workflow.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)\s*$/gm)].map((match) => match[1]);
  assert.deepEqual(actionUses, [
    "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
    "pnpm/action-setup@f40ffcd9367d9f12939873eb1018b921a783ffaa",
    "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
  ], "every release action must use its reviewed immutable commit");
  for (const action of actionUses) assert.match(action, /@[a-f0-9]{40}$/, `release action must not use a mutable tag: ${action}`);
  const runners = [...workflow.matchAll(/^\s*runs-on:\s*([^\s#]+)\s*$/gm)].map((match) => match[1]);
  assert.deepEqual(runners, ["ubuntu-latest"], "publishing must use one GitHub-hosted runner");
  assert.doesNotMatch(workflow, /self-hosted/i);

  const nodeVersion = workflow.match(/node-version:\s*["']?(\d+(?:\.\d+){0,2})["']?/)?.[1];
  const npmVersion = workflow.match(/\bnpm@(\d+\.\d+\.\d+)\b/)?.[1];
  assert.equal(versionAtLeast(nodeVersion, "22.14.0"), true, "setup-node must select Node >=22.14.0");
  assert.equal(versionAtLeast(npmVersion, "11.5.1"), true, "the workflow must pin npm >=11.5.1 using pnpm");

  const tagGuard = workflow.split(/\r?\n/).find((line) => line.includes("GITHUB_REF_NAME") && line.includes("package.json") && line.includes("version"));
  assert.match(tagGuard ?? "", /v/, "the workflow must require tag v<package.version> exactly");
  assert.match(tagGuard ?? "", /(?:!==|!=|==|=)/, "the tag/version comparison must fail on inequality");

  for (const command of [
    "pnpm install --frozen-lockfile",
    "pnpm test",
    "pnpm pack",
  ]) assert.ok(workflow.includes(command), `workflow is missing required command: ${command}`);

  const npmCommands = workflow.split(/\r?\n/)
    .map((line) => line.trim().replace(/^run:\s*/, ""))
    .filter((line) => line.startsWith("npm "));
  assert.equal(npmCommands.length, 1, "publish is the only direct npm command allowed");
  assert.match(npmCommands[0] ?? "", /^npm publish\b/, "the only direct npm command must publish");
  assert.doesNotMatch(workflow, /(?:^|[\s;&|])npm\s+(?:version|pack|install)\b/im, "standalone npm may only publish");
  assert.doesNotMatch(workflow, /NPM_TOKEN|secrets\.|^\s*(?:token|github-token):|pnpm\s+version|git\s+(?:commit|push|tag)|gh\s+release|changeset/i);
  assert.doesNotMatch(workflow, /uses:\s*[^\n]*(?:release|changeset)/i, "the workflow must not create a GitHub release or auto-version");
});

test("the publish workflow publishes the exact deterministic tarball created by pnpm pack", () => {
  const workflow = readFileSync(join(root, ".github", "workflows", "publish.yml"), "utf8");
  const artifactDirectory = ".release-artifacts";
  const artifactPath = `${artifactDirectory}/jorgex-pi-\${GITHUB_REF_NAME#v}.tgz`;

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

test("the release guide requires npm trusted-publisher setup before any tag", () => {
  const readme = readFileSync(join(root, "README.md"), "utf8");
  const trustedPublisher = readme.split(/\n\s*\n/).find((paragraph) => /trusted publisher/i.test(paragraph));
  assert.ok(trustedPublisher, "README must document the external npm trusted publisher prerequisite");
  assert.match(trustedPublisher, /npm(?:js\.com| package| settings)/i, "trusted publisher setup must happen in npm, outside the workflow");
  assert.match(trustedPublisher, /jorgehn98\/jorgex-pi/i, "README must identify the authorized GitHub repository");
  assert.match(trustedPublisher, /(?:\.github\/workflows\/)?publish\.yml/i, "README must identify the authorized workflow filename");
  assert.match(trustedPublisher, /before[^.\n]*tag/i, "trusted publisher setup must be required before creating or pushing a release tag");
  assert.match(trustedPublisher, /(?:workflow|repository)[^.\n]*(?:does not|cannot|is not)[^.\n]*(?:configure|sufficient|enough)/i, "README must not imply that committing the workflow configures npm automatically");
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
