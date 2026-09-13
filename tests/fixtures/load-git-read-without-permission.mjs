import { pathToFileURL } from "node:url";
import { join } from "node:path";

const root = process.argv[2];
if (!root) throw new Error("package root argument is required");
const sdkRoot = process.env.JORGEX_PI_SDK_ROOT;
const sdk = sdkRoot
  ? await import(pathToFileURL(join(sdkRoot, "dist", "index.js")).href)
  : await import("@earendil-works/pi-coding-agent");

const agentDir = process.env.PI_CODING_AGENT_DIR;
const cwd = process.cwd();
const loader = new sdk.DefaultResourceLoader({
  cwd,
  agentDir,
  additionalExtensionPaths: [join(root, "extensions", "git-read.ts")],
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
});
await loader.reload();
const loaded = loader.getExtensions();
if (loaded.errors.length > 0) throw new Error(JSON.stringify(loaded.errors));
const tool = loaded.extensions
  .flatMap((extension) => [...extension.tools.values()])
  .find(({ definition }) => definition.name === "git_read")?.definition;
if (!tool) throw new Error("git_read was not registered");

let error;
let result;
try {
  result = await tool.execute("without-permission", { action: "diff", args: [] }, undefined, undefined, { cwd });
} catch (cause) {
  error = cause instanceof Error ? cause.message : String(cause);
}
process.stdout.write(`${JSON.stringify({ result, error })}\n`);
