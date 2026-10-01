// Loader identity probe: loaded BY PATH via real DefaultResourceLoader Jiti path; relative import binds package root.
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
