// T73 real-host project-trust probe (test artifact, never production).
//
// `tests/fixtures/native-host-trust.mjs` copies these bytes byte-identical into
// the `extensions` directory of a coherent managed release, and the child
// runner loads the copy BY PATH through the real Pi `DefaultResourceLoader`
// from the ACTIVE managed symlink. This file is never imported by Node first:
// the package identity the checker derives from `import.meta.url` must come from
// the loader's own module graph.
//
// The only value forwarded to the readonly checker is the REAL
// `ctx.isProjectTrusted()` the host `AgentSession` exposes (in the SDK,
// `() => settingsManager.isProjectTrusted()`). The fixture passes no literal
// trust boolean into the checker; the observed trust must come from the host.
// The result (or failure) is emitted on the shared extension event bus and
// never printed, so no fixture value can reach stdout and the probe cannot
// pretend the checker answered when it did not.
import { inspectNativeMcpOwnership } from "./native-mcp.mjs";

export default function nativeHostTrustProbe(pi) {
  pi.on("session_start", async (_event, ctx) => {
    const channel = process.env.JORGEX_PI_HOST_TRUST_CHANNEL;
    if (!channel) throw new Error("JORGEX_PI_HOST_TRUST_CHANNEL is required");
    try {
      if (!ctx || typeof ctx.isProjectTrusted !== "function") {
        throw new Error("the host session context exposes no public isProjectTrusted()");
      }
      const projectTrusted = ctx.isProjectTrusted();
      const result = await inspectNativeMcpOwnership({
        env: process.env,
        platform: process.platform,
        cwd: ctx.cwd,
        projectTrusted,
      });
      pi.events.emit(channel, { ok: true, projectTrusted, cwd: ctx.cwd, result });
    } catch (error) {
      pi.events.emit(channel, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
