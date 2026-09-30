// T70/T73 portability seed: the standalone consumer contract.
//
// Spec 71 declares ONE implementation in `extensions/mcp-engram.mjs`, keeps the
// `.ts` file only as a historical `export *` shim, and requires the checker and
// bootstrap to consume the `.mjs` with no Node type-stripping hook and no new
// Jiti dependency. Node 24 refuses TS under `node_modules`
// (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so the existing heavy proof's
// test-side `module.registerHooks` bridge does NOT represent a real consumer.
//
// This case is the real boundary: the shipped producer closure is copied
// byte-identical into `<temp>/node_modules/jorgex-pi` and a PLAIN child Node
// imports the declared `.mjs` entrypoints. No load hook, no Jiti, no checkout,
// no HTTP and no credentials are involved, and the isolated HOME/USERPROFILE and
// agent dir are empty, so the imports can have no side effect.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  createConsumerInstall,
  digestTree,
  PRODUCER_FILES,
} from "./fixtures/native-consumer-install.mjs";

// Fixed inline consumer program: it receives the declared entrypoint file URLs
// through argv and reports the concrete export surface. It is never arbitrary
// page or user code.
const CHILD_PROGRAM = `
const [entryUrl, checkerUrl] = process.argv.slice(1);
const report = { entry: {}, checker: {} };
const entry = await import(entryUrl);
report.entry.digest = typeof entry.digestNativeMcpDefinition;
report.entry.devtools = typeof entry.resolveNativeDevtoolsDefinition;
report.entry.absentHandoffIsUndefined = entry.resolveNativeDevtoolsDefinition({
  env: process.env,
  platform: process.platform,
}) === undefined;
const checker = await import(checkerUrl);
report.checker.inspect = typeof checker.inspectNativeMcpOwnership;
process.stdout.write(JSON.stringify(report));
`;

test("a plain Node consumer imports the declared .mjs producer surface from node_modules", (t) => {
  const install = createConsumerInstall(t);
  const before = digestTree(install.installRoot);

  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      CHILD_PROGRAM,
      pathToFileURL(install.entryPath).href,
      pathToFileURL(install.checkerPath).href,
    ],
    { cwd: install.root, env: install.env, encoding: "utf8" },
  );

  assert.equal(
    result.status,
    0,
    `a plain Node consumer must import the declared producer entrypoints (copied ${PRODUCER_FILES.length}, missing ${JSON.stringify(install.missing)}):\n${result.stdout}\n${result.stderr}`,
  );
  const report = JSON.parse(result.stdout);
  assert.equal(report.entry.digest, "function", "the declared implementation must export the pure digest");
  assert.equal(report.entry.devtools, "function", "the declared implementation must export the DevTools resolver");
  assert.equal(
    report.entry.absentHandoffIsUndefined,
    true,
    "an absent handoff must resolve to undefined with no side effect",
  );
  assert.equal(
    report.checker.inspect,
    "function",
    "the checker must consume the portable implementation without hooks",
  );
  assert.deepEqual(
    digestTree(install.installRoot),
    before,
    "importing the entrypoints must not write to the installed closure",
  );
});
