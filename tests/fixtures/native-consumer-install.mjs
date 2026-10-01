// Consumer install fixture: shipped closure copied byte-identical for plain Node import.
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const PI_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const PACKAGE_NAME = "jorgex-pi";

// The producer surface a plain Node consumer must load from `node_modules`: the
// declared implementation, the checker that consumes it and the config module
// they both import.
export const PRODUCER_FILES = [
  "extensions/mcp-engram.mjs",
  "extensions/native-mcp.mjs",
  "extensions/context7-config.mjs",
];

// The single runtime dependency the copied closure imports.
const RUNTIME_DEPENDENCIES = ["strip-json-comments"];

export function createConsumerInstall(t) {
  const root = mkdtempSync(join(tmpdir(), "jorgex-pi-native-consumer-"));
  // Owned temporary tree: teardown is registered immediately after the owned
  // mkdtemp and before any other IO, so it runs on success, failure and a setup
  // failure alike. No process is started here.
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const installRoot = join(root, "node_modules", PACKAGE_NAME);
  const home = join(root, "home");
  const agentDir = join(root, "agent");
  mkdirSync(join(installRoot, "extensions"), { recursive: true });
  mkdirSync(join(installRoot, "node_modules"), { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(agentDir, { recursive: true });

  writeFileSync(join(installRoot, "package.json"), readFileSync(join(PI_ROOT, "package.json")));

  const missing = [];
  for (const relativePath of PRODUCER_FILES) {
    const source = join(PI_ROOT, relativePath);
    // Real bytes only. A file that does not exist stays missing: the consumer
    // proof must fail on the absent declaration, never on a fabricated copy of
    // the historical `.ts` renamed to `.mjs`.
    if (!existsSync(source)) {
      missing.push(relativePath);
      continue;
    }
    writeFileSync(join(installRoot, relativePath), readFileSync(source));
  }
  for (const name of RUNTIME_DEPENDENCIES) {
    cpSync(join(PI_ROOT, "node_modules", name), join(installRoot, "node_modules", name), {
      recursive: true,
    });
  }

  return {
    root,
    installRoot,
    home,
    agentDir,
    // Isolated consumer environment: no user configuration and no credentials.
    env: { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir },
    entryPath: join(installRoot, "extensions", "mcp-engram.mjs"),
    checkerPath: join(installRoot, "extensions", "native-mcp.mjs"),
    missing,
  };
}

// Content digest of the whole installed closure, so the consumer proof can show
// that importing the entrypoints writes nothing.
export function digestTree(root) {
  const files = {};
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const relativePath = relative(root, full).split(sep).join("/");
      files[relativePath] = createHash("sha256").update(readFileSync(full)).digest("hex");
    }
  };
  walk(root);
  return files;
}
