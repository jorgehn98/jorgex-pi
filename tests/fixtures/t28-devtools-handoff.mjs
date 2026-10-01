// Trusted Chrome DevTools v3 handoff fixture, extracted verbatim from
// tests/mcp-engram.test.mjs so the legacy registration control and the native
// definition tracer authenticate the same real guard chain instead of each
// reimplementing it. Fixture only: no credentials, no real HOME and no real
// browser tree; the launcher writes a marker file and never launches anything.
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

export function installAdapterFixture(agentDir) {
  const packageDir = join(agentDir, "npm", "node_modules", "pi-mcp-adapter");
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: "pi-mcp-adapter", version: "2.36.0" }));
}

export function createT28Fixture(resolveMcpEngramConfig, t) {
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "jorgex-pi-t28-trusted-devtools-")));
  // Owned temporary tree: register the runner-hook teardown immediately after
  // the owned mkdtemp and before any other IO, so a failure while the fixture is
  // being built still cleans up on success, failure and cancellation.
  t?.after?.(() => rmSync(sandbox, { recursive: true, force: true }));
  const agentDir = join(sandbox, "agent");
  const handoffPath = join(agentDir, "jorgex-pi", "devtools.v1.json");
  const engramBin = join(sandbox, process.platform === "win32" ? "engram.exe" : "engram");
  const rootPath = join(sandbox, "managed-browser");
  const treePath = join(rootPath, "tree");
  const launcherPath = join(rootPath, "launcher.mjs");
  const entryPath = join(treePath, "node_modules", "browser", "bin", "entry.mjs");
  const linkPath = join(treePath, "node_modules", ".bin", "browser");
  const markerPath = join(sandbox, "marker.json");
  const fixedFlags = [
    "--isolated",
    "--redact-network-headers",
    "--no-performance-crux",
    "--no-usage-statistics",
  ];
  const env = { HOME: join(sandbox, "home"), PI_CODING_AGENT_DIR: agentDir };

  mkdirSync(dirname(handoffPath), { recursive: true });
  mkdirSync(dirname(entryPath), { recursive: true });
  mkdirSync(dirname(linkPath), { recursive: true });
  writeFileSync(engramBin, "fake Engram binary; never execute\n");
  chmodSync(engramBin, 0o755);
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
    packages: ["npm:gentle-engram@0.1.13", "npm:pi-mcp-adapter@2.36.0"],
  }));
  installAdapterFixture(agentDir);
  writeFileSync(join(agentDir, "mcp.json"), `${JSON.stringify({
    mcpServers: {
      engram: {
        command: engramBin,
        args: ["mcp", "--tools=agent"],
        lifecycle: "lazy",
        directTools: false,
      },
    },
  }, null, 2)}\n`);

  const entryBytes = `import { writeFileSync } from "node:fs";
const expectedFlags = ${JSON.stringify(fixedFlags)};
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expectedFlags)) process.exit(41);
if (!process.env.T28_MARKER) process.exit(42);
writeFileSync(process.env.T28_MARKER, JSON.stringify({ launcherPath: process.argv[1], args: process.argv.slice(2) }));
`;
  const launcherBytes = `await import(${JSON.stringify(pathToFileURL(entryPath).href)});\n`;
  writeFileSync(entryPath, entryBytes);
  writeFileSync(launcherPath, launcherBytes);
  if (process.platform !== "win32") symlinkSync("../browser/bin/entry.mjs", linkPath);

  return {
    sandbox,
    env,
    resolve: () => resolveMcpEngramConfig({ resolveEngramBinary: () => engramBin, env }),
    handoffPath,
    rootPath,
    treePath,
    launcherPath,
    entryPath,
    linkPath,
    markerPath,
    fixedFlags,
    launcherBytes,
    entryBytes,
  };
}

export function createT28Handoff(fixture) {
  return {
    args: [fixture.launcherPath, ...fixture.fixedFlags],
    command: process.execPath,
    enabled: true,
    entryPath: fixture.entryPath,
    launcherPath: fixture.launcherPath,
    launcherSha256: sha256File(fixture.launcherPath),
    rootPath: fixture.rootPath,
    schemaVersion: 3,
    treePath: fixture.treePath,
    treeSha256: deterministicTreeSha256(fixture.treePath),
  };
}

export function writeT28Handoff(fixture, handoff) {
  writeFileSync(fixture.handoffPath, `${JSON.stringify(handoff)}\n`);
}

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function deterministicTreeSha256(root) {
  const entries = [];
  const visit = (directory) => {
    for (const dirent of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, dirent.name);
      const rel = relative(root, full).split(sep).join("/");
      if (dirent.isSymbolicLink()) {
        entries.push({ kind: "symlink", rel, target: readlinkSync(full) });
      } else if (dirent.isDirectory()) {
        entries.push({ kind: "dir", rel });
        visit(full);
      } else if (dirent.isFile()) {
        entries.push({ kind: "file", rel });
      } else {
        throw new Error(`unsupported T28 fixture entry: ${full}`);
      }
    }
  };
  visit(root);
  entries.sort((left, right) => left.rel < right.rel ? -1 : left.rel > right.rel ? 1 : 0);
  const hash = createHash("sha256");
  hash.update("browser-v2\0", "utf8");
  for (const entry of entries) {
    const payload = entry.kind === "symlink"
      ? Buffer.from(entry.target, "utf8")
      : entry.kind === "file"
        ? readFileSync(join(root, ...entry.rel.split("/")))
        : Buffer.alloc(0);
    hash.update(`${entry.kind}\0${entry.rel}\0`, "utf8");
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(payload.length));
    hash.update(length);
    hash.update(payload);
  }
  return hash.digest("hex");
}
