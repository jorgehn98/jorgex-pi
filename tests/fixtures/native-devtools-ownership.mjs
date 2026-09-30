// Bounded DevTools ownership chain fixture (Spec 71 L33/L44).
//
// Spec: the projection receipt must stamp the WHOLE handoff file
// (`devtools.sha256`) and the persisted stdio command/args must equal the
// trusted v3 resolution of that handoff — never a plain launcher or an arbitrary
// script that merely matches `definitionSha256`. New native registrations never
// degrade to the v1/v2 fallback.
//
// This helper adds only the DevTools chain on top of the approved read-only
// fixtures: the shared managed-release sandbox and the trusted T28 v3 handoff
// fixture. Fixture only: no Chromium, no Chrome, no MCP connection, no model, no
// credentials, and nothing is ever executed.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  digestNativeMcpDefinition,
  resolveNativeDevtoolsDefinition,
} from "../../extensions/mcp-engram.mjs";
import {
  createT28Fixture,
  createT28Handoff,
  writeT28Handoff,
} from "./t28-devtools-handoff.mjs";

// `<agentDir>/jorgex-pi/devtools.v1.json` (extensions/mcp-engram.mjs).
const HANDOFF_RELATIVE = ["jorgex-pi", "devtools.v1.json"];

export function installDevtoolsChain(sandbox, t) {
  // The trusted v3 handoff is produced by the approved T28 fixture; only its
  // exact FILE BYTES are copied into the agent dir the inspector resolves, so
  // the handoff keeps pointing at its own contained guard root.
  const t28 = createT28Fixture(() => {
    throw new Error("T28 config resolver is unused in this fixture");
  }, t);
  writeT28Handoff(t28, createT28Handoff(t28));
  const handoffBytes = readFileSync(t28.handoffPath);
  const handoffPath = join(sandbox.agentDir, ...HANDOFF_RELATIVE);
  mkdirSync(dirname(handoffPath), { recursive: true });
  writeFileSync(handoffPath, handoffBytes);

  const trustedDefinition = resolveNativeDevtoolsDefinition({
    env: sandbox.env,
    platform: process.platform,
  });
  if (trustedDefinition === undefined) {
    throw new Error("the trusted v3 handoff must resolve to a guard definition");
  }
  return {
    t28,
    handoffPath,
    handoffSha256: createHash("sha256").update(handoffBytes).digest("hex"),
    trustedDefinition,
    trustedDefinitionSha256: digestNativeMcpDefinition("chrome-devtools", trustedDefinition),
    // A syntactically valid stdio definition that is NOT the trusted guard: its
    // own digest can match a claim, yet it is an arbitrary script.
    plainLauncher: { command: process.execPath, args: [join(sandbox.root, "plain-launcher.mjs")] },
  };
}

// Writes the chrome-devtools config entry and its granular projection claim.
// `devtools` is the receipt stamp under test: present with the whole-handoff
// sha256, mismatched, or absent.
export function writeDevtoolsOwnership(sandbox, { entry, definitionSha256, devtools }) {
  const configPath = join(sandbox.agentDir, "mcp.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.mcpServers["chrome-devtools"] = entry;
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

  const projection = JSON.parse(readFileSync(sandbox.projectionPath, "utf8"));
  projection.mcpNative.entries["chrome-devtools"] = { definitionSha256 };
  if (devtools !== undefined) projection.devtools = devtools;
  writeFileSync(sandbox.projectionPath, `${JSON.stringify(projection, null, 2)}\n`);
}
