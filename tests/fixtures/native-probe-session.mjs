// Shared native probe session: the byte-identical ModelRuntime + in-memory
// session + bind/dispose block used by the Jiti identity and host trust runners.
// Loaders, trust reload, ProjectTrustStore, probe paths and SDK root validation
// stay in each caller because their seams differ. Fixture only: no model turn,
// no credential and no real HOME.
import { join } from "node:path";

export async function runNativeProbeSession({ sdk, cwd, agentDir, loader, settingsManager, eventBus, channel }) {
  const { createAgentSession, ModelRuntime, SessionManager } = sdk;

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
  return probe;
}
