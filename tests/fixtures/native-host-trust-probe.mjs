// Host-trust probe: loaded BY PATH via real DefaultResourceLoader; forwards only real ctx.isProjectTrusted().
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
