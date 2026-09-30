// T73 real-Pi-loader identity probe (test artifact, never production).
//
// `tests/fixtures/native-jiti-identity.mjs` copies these bytes byte-identical
// into the `extensions` directory of a coherent managed release and into a
// foreign stage package root, and the test loads each copy BY PATH through the
// real Pi `DefaultResourceLoader` (`additionalExtensionPaths`, i.e. the
// loader's Jiti path). This file is never imported by Node first: the identity
// under test must come from the loader's own module graph, never from the test
// process module cache.
//
// The only import is the RELATIVE sibling `./native-mcp.mjs`. The readonly
// checker derives its own package root from `import.meta.url`, so whichever
// physical package root the real loader bound is exactly what this probe
// proves. No package-root argument, bypass or private SDK call is involved.
//
// The result (or the failure) is emitted on the shared extension event bus and
// never printed, so no fixture value can reach stdout and the fixture cannot
// pretend the checker answered when it did not.
import { inspectNativeMcpOwnership } from "./native-mcp.mjs";

export default function nativeJitiIdentityProbe(pi) {
  pi.on("session_start", async () => {
    const channel = process.env.JORGEX_PI_JITI_IDENTITY_CHANNEL;
    if (!channel) throw new Error("JORGEX_PI_JITI_IDENTITY_CHANNEL is required");
    try {
      const result = await inspectNativeMcpOwnership({ env: process.env, cwd: process.cwd() });
      pi.events.emit(channel, { ok: true, result });
    } catch (error) {
      pi.events.emit(channel, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
}
