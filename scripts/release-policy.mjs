import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FULL_SHA = /^[0-9a-f]{40}$/i;
const VERSION_NOT_FOUND = /ERR_PNPM_PACKAGE_NOT_FOUND|No matching version found/i;

export const PUBLICABLE_EXACT = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "README.md",
  "DESIGN.md",
  "LICENSE",
]);

export const PUBLICABLE_PREFIXES = [
  "agents/",
  "assets/",
  "bin/",
  "contract/",
  "extensions/",
  "primary/",
  "skills/",
  "snapshot/agents/",
  "themes/",
];

const TEST_PATTERN = /(^|\/)(?:tests?|specs?)\//i;

export function normalizeReleasePath(input) {
  return input.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

export function classifyReleasePaths(paths) {
  const result = { publicPaths: [], ignoredPaths: [], testPaths: [], workflowPaths: [], scriptPaths: [] };

  for (const input of paths) {
    const path = normalizeReleasePath(input);
    if (path === "") continue;
    if (TEST_PATTERN.test(path)) result.testPaths.push(path);
    else if (path.startsWith(".github/workflows/")) result.workflowPaths.push(path);
    else if (path.startsWith("scripts/")) result.scriptPaths.push(path);
    else if (PUBLICABLE_EXACT.has(path) || PUBLICABLE_PREFIXES.some((prefix) => path.startsWith(prefix))) result.publicPaths.push(path);
    else result.ignoredPaths.push(path);
  }

  return result;
}

export function bumpPatch(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`Version \"${version}\" must be a plain x.y.z semver.`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

export function buildReleasePlan({ currentVersion, currentVersionExists, publicable, releaseBumpCommit, recoveryRun, versionExists }) {
  if (releaseBumpCommit && !recoveryRun) {
    return { publish: false, bump: false, version: currentVersion, reason: "release_bump_commit" };
  }
  if (!currentVersionExists) {
    return { publish: true, bump: false, version: currentVersion, reason: "unpublished_version" };
  }
  if (recoveryRun) {
    return { publish: false, bump: false, version: currentVersion, reason: "published_recovery" };
  }
  if (!publicable) {
    return { publish: false, bump: false, version: currentVersion, reason: "no_publicable_changes" };
  }

  let version = bumpPatch(currentVersion);
  while (versionExists(version)) version = bumpPatch(version);
  return { publish: true, bump: true, version, reason: "publicable_patch" };
}

export function synchronizeReleaseMetadata({ manifest, contract, version }) {
  const nextManifest = structuredClone(manifest);
  const nextContract = structuredClone(contract);
  if (nextManifest.name !== "jorgex-pi" || nextContract?.package?.name !== "jorgex-pi") {
    throw new Error("Release metadata must describe jorgex-pi.");
  }
  bumpPatch(version);
  nextManifest.version = version;
  nextContract.package.version = version;
  nextContract.package.source = `npm:jorgex-pi@${version}`;
  return { manifest: nextManifest, contract: nextContract };
}

export function isReleaseBumpCommit(message, actor = "") {
  const text = message.trim();
  return /^chore\(release\):\s+/i.test(text)
    || /^v?\d+\.\d+\.\d+$/i.test(text)
    || (/\[bot\]$/i.test(actor.trim()) && /\b(?:release|publish|bump|version)\b/i.test(text));
}

export function normalizeRecoverySha(value) {
  const sha = value.trim().toLowerCase();
  if (!FULL_SHA.test(sha)) throw new Error("release_sha must be a complete 40-character Git SHA.");
  return sha;
}

export function assertReleaseBaseline({ currentVersion, currentVersionExists, currentTagSha, recoveryRun, releaseShaProvided }) {
  if (!currentVersionExists || currentTagSha !== null) return;
  const tag = `v${currentVersion}`;
  if (recoveryRun && !releaseShaProvided) {
    throw new Error(`${tag} is missing. Recovery requires the exact release_sha that was published.`);
  }
  if (!recoveryRun) {
    throw new Error(`${tag} is missing. Recover its exact published SHA before automatic patch releases continue.`);
  }
}

export function resolveReleaseTagState({ version, tagSha, publishSha, publish, recoveryRun }) {
  if (!publish && !recoveryRun) return { tagNeeded: false };
  if (tagSha !== null && tagSha !== publishSha) throw new Error(`v${version} already points to ${tagSha}, not ${publishSha}.`);
  return { tagNeeded: tagSha === null && (publish || recoveryRun) };
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options }).trim();
}

function npmHasVersion(name, version) {
  try {
    run("pnpm", ["view", `${name}@${version}`, "version"]);
    return true;
  } catch (error) {
    const output = `${error?.message ?? ""}\n${String(error?.stdout ?? "")}\n${String(error?.stderr ?? "")}`;
    if (VERSION_NOT_FOUND.test(output)) return false;
    throw error;
  }
}

function resolveTagSha(tag) {
  try {
    return run("git", ["rev-list", "-n", "1", tag]) || null;
  } catch (error) {
    const output = `${error?.message ?? ""}\n${String(error?.stderr ?? "")}`;
    if (/unknown revision|ambiguous argument|bad revision|unknown commit/i.test(output)) return null;
    throw error;
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function changedPathsSinceRelease(base, head) {
  return run("git", ["diff", "--name-only", base, head]).split(/\r?\n/).filter(Boolean);
}

function appendOutputs(values) {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) throw new Error("GITHUB_OUTPUT is required.");
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n");
  writeFileSync(output, `${lines}\n`, { flag: "a" });
}

function commitVersion(version) {
  const manifest = readJson("package.json");
  const contract = readJson("contract/jorgex-pi.v1.json");
  const synchronized = synchronizeReleaseMetadata({ manifest, contract, version });
  writeJson("package.json", synchronized.manifest);
  writeJson("contract/jorgex-pi.v1.json", synchronized.contract);
  run("git", ["config", "user.name", "github-actions[bot]"]);
  run("git", ["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"]);
  run("git", ["add", "package.json", "contract/jorgex-pi.v1.json"]);
  run("git", ["commit", "-m", `chore(release): bump version to v${version}`]);
  run("git", ["push", "origin", "HEAD:main"]);
  return run("git", ["rev-parse", "HEAD"]);
}

export function runReleasePlan() {
  const event = (process.env.GITHUB_EVENT_NAME ?? "").trim();
  const recoveryRun = event === "workflow_dispatch";
  const targetSha = normalizeRecoverySha(process.env.TARGET_SHA ?? "");
  const head = run("git", ["rev-parse", "HEAD"]).toLowerCase();
  if (head !== targetSha) throw new Error(`Checked out SHA ${head} does not match target ${targetSha}.`);

  run("git", ["fetch", "origin", "main", "--tags"]);
  const originMain = run("git", ["rev-parse", "origin/main"]).toLowerCase();
  if (!recoveryRun && originMain !== targetSha) throw new Error("Release run is stale because origin/main advanced.");

  const manifest = readJson("package.json");
  const contract = readJson("contract/jorgex-pi.v1.json");
  bumpPatch(manifest.version);
  if (contract?.package?.name !== manifest.name
    || contract.package.version !== manifest.version
    || contract.package.source !== `npm:${manifest.name}@${manifest.version}`) {
    throw new Error("package.json and contract/jorgex-pi.v1.json release metadata are not synchronized.");
  }

  const currentVersionExists = npmHasVersion(manifest.name, manifest.version);
  const currentTag = `v${manifest.version}`;
  const currentTagSha = resolveTagSha(currentTag)?.toLowerCase() ?? null;
  assertReleaseBaseline({
    currentVersion: manifest.version,
    currentVersionExists,
    currentTagSha,
    recoveryRun,
    releaseShaProvided: Boolean((process.env.RELEASE_SHA ?? "").trim()),
  });
  if (currentTagSha !== null) {
    try {
      run("git", ["merge-base", "--is-ancestor", currentTagSha, targetSha]);
    } catch {
      throw new Error(`${currentTag} does not belong to the selected main history.`);
    }
  }

  const paths = recoveryRun || currentTagSha === null ? [] : changedPathsSinceRelease(currentTagSha, targetSha);
  const classification = classifyReleasePaths(paths);
  const message = run("git", ["log", "-1", "--pretty=%B", targetSha]);
  const plan = buildReleasePlan({
    currentVersion: manifest.version,
    currentVersionExists,
    publicable: classification.publicPaths.length > 0,
    releaseBumpCommit: isReleaseBumpCommit(message, process.env.GITHUB_ACTOR ?? ""),
    recoveryRun,
    versionExists: (version) => npmHasVersion(manifest.name, version),
  });

  let publishSha = targetSha;
  if (plan.bump) publishSha = commitVersion(plan.version).toLowerCase();

  const tag = `v${plan.version}`;
  const tagSha = resolveTagSha(tag)?.toLowerCase() ?? null;
  const { tagNeeded } = resolveReleaseTagState({
    version: plan.version,
    tagSha,
    publishSha,
    publish: plan.publish,
    recoveryRun,
  });

  appendOutputs({ publish: plan.publish, version: plan.version, publish_sha: publishSha, tag_needed: tagNeeded, reason: plan.reason });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv[2] !== "plan") throw new Error("Usage: node scripts/release-policy.mjs plan");
  runReleasePlan();
}
