// Host-trust runner: one real session/trust store/bound probe; prints only bus output.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runNativeProbeSession } from "./native-probe-session.mjs";

const probePath = process.argv[2];
if (!probePath) throw new Error("probe extension path is required");
const channel = process.env.JORGEX_PI_HOST_TRUST_CHANNEL;
if (!channel) throw new Error("JORGEX_PI_HOST_TRUST_CHANNEL is required");
const decision = process.env.JORGEX_PI_HOST_TRUST_DECISION === "true";
const agentDir = process.env.PI_CODING_AGENT_DIR;
const home = process.env.HOME;
for (const [name, value] of [["PI_CODING_AGENT_DIR", agentDir], ["HOME", home]]) {
  if (!value) throw new Error(`${name} is required; the fixture must target an isolated sandbox, never the real HOME`);
}
const sdkRoot = process.env.JORGEX_PI_NATIVE_SDK_ROOT;
if (!sdkRoot) throw new Error("JORGEX_PI_NATIVE_SDK_ROOT is required (explicit native-capable host SDK root)");
const sdkEntry = join(sdkRoot, "dist", "index.js");
if (!existsSync(sdkEntry)) throw new Error(`Pi SDK entry not found: ${sdkEntry}`);
const sdkVersion = JSON.parse(readFileSync(join(sdkRoot, "package.json"), "utf8")).version;

const sdk = await import(pathToFileURL(sdkEntry).href);
const {
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  ModelRuntime,
  ProjectTrustStore,
  SessionManager,
  SettingsManager,
} = sdk;
if (typeof createAgentSession !== "function"
  || typeof createEventBus !== "function"
  || typeof DefaultResourceLoader !== "function"
  || typeof ModelRuntime?.create !== "function"
  || typeof ProjectTrustStore !== "function"
  || typeof SessionManager?.inMemory !== "function"
  || typeof SettingsManager?.inMemory !== "function") {
  throw new Error(`host SDK at ${sdkRoot} does not expose the public trust/loader/session API`);
}

const cwd = process.cwd();

// Real on-disk trust decision, persisted through the public store the host
// itself uses for `ctx.isProjectTrusted()`.
const trustStore = new ProjectTrustStore(agentDir);
trustStore.set(cwd, decision);
const stored = trustStore.get(cwd);

const settingsManager = SettingsManager.inMemory({});
const eventBus = createEventBus();
const loader = new DefaultResourceLoader({
  cwd,
  agentDir,
  settingsManager,
  eventBus,
  additionalExtensionPaths: [probePath],
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
});
// The public trust hook the real host uses: the loader sets
// `settingsManager.setProjectTrusted(...)` from the resolved decision, which the
// AgentSession then exposes through `ctx.isProjectTrusted()`.
await loader.reload({ resolveProjectTrust: async () => trustStore.get(cwd) === true });
const effectiveTrust = settingsManager.isProjectTrusted();
const loaded = loader.getExtensions();
if (loaded.errors.length > 0) {
  throw new Error(`the real Pi loader failed to load the probe by path: ${JSON.stringify(loaded.errors)}`);
}

// Explicit model runtime with no model turn: nothing is prompted and no
// credential is read (the isolated agent dir has no auth.json).
const probe = await runNativeProbeSession({ sdk, cwd, agentDir, loader, settingsManager, eventBus, channel });

process.stdout.write(`${JSON.stringify({
  sdkVersion,
  storedTrust: stored,
  effectiveTrust,
  loaderErrors: loaded.errors,
  extensionCount: loaded.extensions.length,
  probe: probe ?? null,
  isolated: { home, agentDir, cwd, probePath },
})}\n`);
