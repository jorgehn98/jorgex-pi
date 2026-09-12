import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitTransaction } from "./snapshot-transaction.mjs";

const DEFAULT_SCRIPT = "scripts/generate-snapshot.mjs";
const FIXTURE = "tests/fixtures/snapshot-parity.expected.json";
const PARITY = "contract/parity.v2.json";
const RUNTIME = "contract/runtime-agents.v1.json";
const DESTINATIONS = [
  "snapshot", "skills", "assets/system-prompt", "prompts", PARITY,
  "contract/schemas/quality-receipt.v1.schema.json", "contract/schemas/quality-capabilities.v1.schema.json",
  "agents", "deferred/agents", "primary", RUNTIME, DEFAULT_SCRIPT, FIXTURE,
];
const sha = (value) => typeof value === "string" && value.length === 40 && /^[0-9a-f]{40}$/.test(value);
const readJson = (root, name) => JSON.parse(readFileSync(join(root, name), "utf8"));
const owned = (name, destination) => name === destination || name.startsWith(`${destination}/`);

function gitEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase().startsWith("GIT_")) delete env[key];
  }
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

function git(root, args, binary = false) {
  return execFileSync("git", ["--no-replace-objects", "--no-optional-locks", "-C", root, ...args], {
    env: gitEnvironment(), encoding: binary ? undefined : "utf8", stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024, timeout: 30_000, windowsHide: true,
  });
}

function checkoutRoot(input) {
  if (typeof input !== "string" || !isAbsolute(input)) throw new Error("An absolute checkout root is required");
  const root = realpathSync(input);
  if (realpathSync(git(root, ["rev-parse", "--show-toplevel"]).trim()) !== root) throw new Error("Use the exact checkout root");
  return root;
}

function assertClean(root, stage) {
  const indexEntries = git(root, ["ls-files", "-v", "-z"]).split("\0").filter(Boolean);
  if (indexEntries.some((entry) => /^[a-zS] /.test(entry))) {
    throw new Error("Pi index contains assume-unchanged or skip-worktree entries; use an unmasked work checkout");
  }
  const paths = stage ? ["--", ".", `:(exclude,top,literal)${basename(stage)}`] : [];
  if (git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", ...paths])) {
    throw new Error("Pi checkout must be clean and exclusively owned");
  }
  if (git(root, ["status", "--porcelain=v1", "-z", "--ignored=matching", "--untracked-files=all", "--", ...DESTINATIONS])) {
    throw new Error("Generated destinations contain modified or extra ignored files");
  }
  for (const destination of DESTINATIONS) {
    let target = root;
    for (const part of destination.split("/")) {
      target = join(target, part);
      if (!existsSync(target)) continue;
      const stat = lstatSync(target);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error("Unsafe generated destination");
    }
  }
}

function assertExportableTree(root, commit, paths = []) {
  const names = new Set();
  for (const entry of git(root, ["ls-tree", "-r", "-t", "-z", commit, ...paths]).split("\0").filter(Boolean)) {
    const match = /^(?:(?:100644|100755) blob|040000 tree) [0-9a-f]{40}\t(.+)$/.exec(entry);
    if (!match) throw new Error("Unsupported Git tree entry (symlink or submodule)");
    const name = match[1];
    if (/[\x00-\x1f\\:<>"|?*]/.test(name) || name.startsWith("/") || name.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git" || /[. ]$/.test(part))) {
      throw new Error("Git tree contains a non-portable export path");
    }
    if (names.has(name.toLowerCase())) throw new Error("Git tree contains case-colliding paths");
    names.add(name.toLowerCase());
  }
}

function files(root) {
  const result = new Map();
  const walk = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const target = join(directory, name);
      const stat = lstatSync(target);
      if (stat.isSymbolicLink()) throw new Error("Staging contains a symlink");
      if (stat.isDirectory()) walk(target);
      else if (stat.isFile()) result.set(relative(root, target).split(sep).join("/"), createHash("sha256").update(readFileSync(target)).digest("hex"));
      else throw new Error("Staging contains a non-regular file");
    }
  };
  walk(root);
  return result;
}

function topology(parity) {
  const value = structuredClone(parity);
  delete value.source.commit;
  const stripHashes = (item) => {
    if (item === null || typeof item !== "object") return;
    for (const key of Object.keys(item)) {
      if (["sha256", "sourceSha256", "outputSha256"].includes(key)) delete item[key];
      else stripHashes(item[key]);
    }
  };
  for (const key of ["agents", "skills", "policy", "engramProtocol", "systemPromptModules", "commands"]) stripHashes(value[key]);
  return value;
}

/** Prepare in isolation; only --apply publishes verified files to an exclusive work checkout. */
export function prepareStackSnapshot({ root: rootInput, stackDir: stackInput, sourceCommit, apply = false }) {
  if (!sha(sourceCommit) || typeof apply !== "boolean") throw new Error("A full lowercase source SHA and boolean apply are required");
  const root = checkoutRoot(rootInput);
  const stackDir = checkoutRoot(stackInput);
  if (root === stackDir || readJson(root, "package.json").name !== "jorgex-pi") throw new Error("Expected a separate JorgeX Pi checkout");
  const branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  if (["main", "master"].includes(branch)) throw new Error("Use a work branch or detached checkout, not production");
  assertClean(root);
  const baseCommit = git(root, ["rev-parse", "HEAD"]).trim();
  const previous = readJson(root, PARITY);
  if (!sha(previous?.source?.commit) || previous.source.repository !== "https://github.com/jorgehn98/jorgex-stack") throw new Error("Unsupported snapshot source");
  if (git(stackDir, ["rev-parse", "--verify", `${sourceCommit}^{commit}`]).trim() !== sourceCommit) throw new Error("Source does not resolve exactly");
  git(stackDir, ["merge-base", "--is-ancestor", sourceCommit, "origin/main"]);
  git(stackDir, ["merge-base", "--is-ancestor", previous.source.commit, sourceCommit]);
  const unchanged = () => ({ status: "unchanged", sourceCommit, baseCommit, changedPaths: [] });
  if (git(stackDir, ["rev-parse", `${previous.source.commit}:stack`]) === git(stackDir, ["rev-parse", `${sourceCommit}:stack`])) return unchanged();

  assertExportableTree(root, baseCommit);
  assertExportableTree(stackDir, sourceCommit, ["--", "stack"]);
  const stage = mkdtempSync(join(root, ".snapshot-prepare-"));
  let preserveStage = false;
  try {
    const archive = join(stage, ".baseline.tar");
    writeFileSync(archive, git(root, ["archive", "--format=tar", baseCommit], true), { flag: "wx" });
    execFileSync("tar", ["-xf", archive, "-C", stage], { stdio: ["ignore", "pipe", "pipe"], timeout: 30_000, windowsHide: true });
    rmSync(archive);
    const beforeFiles = files(stage);
    const beforeRuntime = readJson(stage, RUNTIME);
    const script = readFileSync(join(stage, DEFAULT_SCRIPT), "utf8");
    const defaultPin = /const DEFAULT_SOURCE_COMMIT = "[0-9a-f]{40}";/g;
    if ((script.match(defaultPin) ?? []).length !== 1) throw new Error("Unsupported generator default pin");
    const nextScript = script.replace(defaultPin, `const DEFAULT_SOURCE_COMMIT = "${sourceCommit}";`);
    writeFileSync(join(stage, DEFAULT_SCRIPT), nextScript);
    const fixture = readJson(stage, FIXTURE);
    if (fixture.sourceCommit !== previous.source.commit) throw new Error("Fixture/source identity mismatch");
    const nextFixture = `${JSON.stringify({ ...fixture, sourceCommit }, null, 2)}\n`;
    writeFileSync(join(stage, FIXTURE), nextFixture);
    const env = { ...gitEnvironment(), JORGEX_STACK_DIR: stackDir, JORGEX_STACK_COMMIT: sourceCommit };
    for (const name of ["generate-snapshot.mjs", "generate-runtime-agents.mjs"]) {
      execFileSync(process.execPath, [join(stage, "scripts", name)], { env, stdio: ["ignore", "pipe", "pipe"], timeout: 120_000, windowsHide: true });
    }
    const nextParity = readJson(stage, PARITY);
    assert.equal(nextParity.source.commit, sourceCommit, "Generator source mismatch");
    assert.deepEqual(topology(nextParity), topology(previous), "Snapshot topology/schema changes require manual review");
    assert.deepEqual(readJson(stage, RUNTIME), beforeRuntime, "Runtime contract changes require manual review");
    execFileSync(process.execPath, ["--test", join(stage, "tests", "snapshot-parity.test.mjs")], { env, stdio: ["ignore", "pipe", "pipe"], timeout: 120_000, windowsHide: true });
    assert.equal(readFileSync(join(stage, DEFAULT_SCRIPT), "utf8"), nextScript, "Generator modified its own source");
    assert.equal(readFileSync(join(stage, FIXTURE), "utf8"), nextFixture, "Generation modified semantic expectations");
    const afterFiles = files(stage);
    const changedPaths = [...new Set([...beforeFiles.keys(), ...afterFiles.keys()])].filter((name) => beforeFiles.get(name) !== afterFiles.get(name)).sort();
    if (changedPaths.some((name) => !DESTINATIONS.some((destination) => owned(name, destination)))) throw new Error("Generation changed files outside its scope");
    const beforeParity = structuredClone(previous);
    const comparableParity = structuredClone(nextParity);
    delete beforeParity.source.commit;
    delete comparableParity.source.commit;
    const outputChanges = changedPaths.filter((name) => ![PARITY, DEFAULT_SCRIPT, FIXTURE].includes(name));
    if (outputChanges.length === 0 && JSON.stringify(beforeParity) === JSON.stringify(comparableParity)) return unchanged();
    if (git(root, ["rev-parse", "HEAD"]).trim() !== baseCommit) throw new Error("Pi HEAD changed during preparation");
    assertClean(root, stage);
    if (apply) {
      commitTransaction({
        root, stage,
        destinations: DESTINATIONS.filter((destination) => changedPaths.some((name) => owned(name, destination))),
        backupName: ".prepare-backup", label: "Stack snapshot preparation", preserveFlag: "preserveSnapshotPreparationStage",
      });
    }
    return { status: "prepared", sourceCommit, baseCommit, changedPaths };
  } catch (error) {
    preserveStage = error?.preserveSnapshotPreparationStage === true || error?.preserveSnapshotStage === true || error?.preserveRuntimeAgentsStage === true;
    if (preserveStage) error.recoveryPath = stage;
    throw error;
  } finally {
    if (!preserveStage) {
      if (dirname(stage) !== root || !basename(stage).startsWith(".snapshot-prepare-")) throw new Error("Unsafe staging cleanup path");
      rmSync(stage, { recursive: true });
    }
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    if (![4, 5].includes(args.length) || args[0] !== "--stack-dir" || args[2] !== "--commit" || (args.length === 5 && args[4] !== "--apply")) {
      throw new Error("Usage: node scripts/prepare-stack-snapshot.mjs --stack-dir ABS --commit FULL_SHA [--apply]");
    }
    const result = prepareStackSnapshot({ root: resolve(dirname(fileURLToPath(import.meta.url)), ".."), stackDir: args[1], sourceCommit: args[3], apply: args.length === 5 });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    console.error(error.recoveryPath
      ? `Snapshot preparation failed; recovery retained at ${error.recoveryPath}`
      : "Snapshot preparation failed. Check the input refs, checkout cleanliness and compatibility. Usage: --stack-dir ABS --commit FULL_SHA [--apply]");
    process.exitCode = 1;
  }
}
