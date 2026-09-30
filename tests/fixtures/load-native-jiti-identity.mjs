// T73 real-Pi-loader identity runner (test artifact, never production).
//
// Loads ONE probe extension BY PATH through the real Pi `DefaultResourceLoader`
// (`additionalExtensionPaths`, i.e. the loader's Jiti path) and a real
// `AgentSession`, fires `session_start` through the public
// `AgentSession.bindExtensions`, and prints ONLY what the probe emitted on the
// shared extension event bus. The probe's factory is never imported here.
//
// The loader gets an IN-MEMORY `SettingsManager` so it never auto-loads the
// disk-registered `jorgex-pi` package (whose companion manifests are fixture
// stubs); the on-disk `settings.json` the readonly checker validates stays
// byte-identical. This does not replace any production trust: it is fixture
// isolation only. No model turn, no prompt, no network, no API key and no real
// HOME are involved; the fixture fails closed without an isolated sandbox.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const probePath = process.argv[2];
if (!probePath) throw new Error("probe extension path is required");
const channel = process.env.JORGEX_PI_JITI_IDENTITY_CHANNEL;
if (!channel) throw new Error("JORGEX_PI_JITI_IDENTITY_CHANNEL is required");
const agentDir = process.env.PI_CODING_AGENT_DIR;
const home = process.env.HOME;
for (const [name, value] of [["PI_CODING_AGENT_DIR", agentDir], ["HOME", home]]) {
  if (!value) throw new Error(`${name} is required; the fixture must target an isolated sandbox, never the real HOME`);
}
const sdkRoot = process.env.JORGEX_PI_NATIVE_SDK_ROOT;
if (!sdkRoot) throw new Error("JORGEX_PI_NATIVE_SDK_ROOT is required (explicit native-capable host SDK root)");
const sdkEntry = join(sdkRoot, "dist", "index.js");
if (!existsSync(sdkEntry)) throw new Error(`Pi SDK entry not found: ${sdkEntry}`);

const sdk = await import(pathToFileURL(sdkEntry).href);
const { createAgentSession, createEventBus, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = sdk;
if (typeof createAgentSession !== "function"
  || typeof createEventBus !== "function"
  || typeof DefaultResourceLoader !== "function"
  || typeof ModelRuntime?.create !== "function"
  || typeof SessionManager?.inMemory !== "function"
  || typeof SettingsManager?.inMemory !== "function") {
  throw new Error(`host SDK at ${sdkRoot} does not expose the public loader/session API`);
}

const cwd = process.cwd();
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
await loader.reload();
const loaded = loader.getExtensions();
if (loaded.errors.length > 0) {
  throw new Error(`the real Pi loader failed to load the probe by path: ${JSON.stringify(loaded.errors)}`);
}

// Explicit model runtime with no model turn: nothing is prompted and no
// credential is read (the isolated agent dir has no auth.json).
const modelRuntime = await ModelRuntime.create({
  authPath: join(agentDir, "auth.json"),
  modelsPath: null,
  refreshOnCreate: false,
});
const { session } = await createAgentSession({
  cwd,
  agentDir,
  modelRuntime,
  resourceLoader: loader,
  settingsManager,
  sessionManager: SessionManager.inMemory(cwd),
  noTools: "all",
});

let probe;
const unsubscribe = eventBus.on(channel, (data) => { probe = data; });
try {
  await session.bindExtensions({});
} finally {
  unsubscribe();
  session.dispose();
}

process.stdout.write(`${JSON.stringify({
  errors: loaded.errors,
  extensionCount: loaded.extensions.length,
  probe: probe ?? null,
  isolated: { home, agentDir, cwd, probePath },
})}\n`);
