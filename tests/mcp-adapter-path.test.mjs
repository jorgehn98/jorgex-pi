import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveMcpEngramConfig } from "../extensions/mcp-engram.ts";

test("current pi-mcp-adapter cannot make ignored mcp.json look healthy", async () => {
  const root = mkdtempSync(join(tmpdir(), "jorgex-pi-adapter-path-"));
  const agentDir = join(root, "agent");
  const adapterDir = join(agentDir, "npm", "node_modules", "pi-mcp-adapter");
  const server = {
    command: process.execPath,
    args: ["mcp", "--tools=agent"],
    lifecycle: "lazy",
    directTools: false,
  };
  const config = `${JSON.stringify({ mcpServers: { engram: server } })}\n`;
  const env = { HOME: root, PI_CODING_AGENT_DIR: agentDir, XDG_CONFIG_HOME: join(root, "xdg") };
  const resolve = () => resolveMcpEngramConfig({
    resolveEngramBinary: () => process.execPath,
    env,
    platform: process.platform,
    cwd: root,
  });

  try {
    mkdirSync(adapterDir, { recursive: true });
    writeFileSync(join(adapterDir, "package.json"), JSON.stringify({ name: "pi-mcp-adapter", version: "3.2.0" }));
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:gentle-engram@0.1.16", "npm:pi-mcp-adapter"] }));
    writeFileSync(join(agentDir, "mcp.json"), config);

    const ignored = await resolve();
    assert.equal(ignored.state, "failed");
    assert.match(ignored.reason ?? "", /mcp-adapter\.json/);

    writeFileSync(join(agentDir, "mcp-adapter.json"), config);
    const duplicate = await resolve();
    assert.equal(duplicate.state, "failed", "two active-looking Engram definitions must not be accepted");

    writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ "mcp-servers": { engram: server } }));
    assert.equal((await resolve()).state, "failed", "alternate legacy spelling cannot bypass duplicate detection");

    rmSync(join(agentDir, "mcp.json"));
    const current = await resolve();
    assert.equal(current.state, "managed");
    assert.equal(current.config.mcpServers.engram.command, process.execPath);

    writeFileSync(join(agentDir, "mcp-adapter.json"), `{
      // The adapter accepts comments and trailing commas.
      "mcpServers": { "engram": ${JSON.stringify(server)}, },
    }\n`);
    assert.equal((await resolve()).state, "managed", "valid adapter JSONC must not hide Engram");

    rmSync(join(adapterDir, "package.json"));
    const absentPackage = await resolve();
    assert.equal(absentPackage.state, "failed", "settings without an installed adapter are not healthy");
    assert.match(absentPackage.reason ?? "", /package metadata is missing/);
    writeFileSync(join(adapterDir, "package.json"), JSON.stringify({ name: "pi-mcp-adapter", version: "3.2.0" }));
    writeFileSync(join(agentDir, "mcp-adapter.json"), config);

    for (const version of ["3.0.0", "3.0.9", "3.1.0"]) {
      writeFileSync(join(adapterDir, "package.json"), JSON.stringify({ name: "pi-mcp-adapter", version }));
      assert.equal((await resolve()).state, "managed", `${version} must read mcp-adapter.json`);
    }

    writeFileSync(join(adapterDir, "package.json"), JSON.stringify({ name: "pi-mcp-adapter", version: "2.36.0" }));
    rmSync(join(agentDir, "mcp-adapter.json"));
    writeFileSync(join(agentDir, "mcp.json"), config);
    assert.equal((await resolve()).state, "managed", "the historical adapter still reads mcp.json");

    writeFileSync(join(adapterDir, "package.json"), JSON.stringify({ name: "pi-mcp-adapter", version: "4.0.0" }));
    rmSync(join(agentDir, "mcp.json"));
    writeFileSync(join(agentDir, "mcp-adapter.json"), config);
    const unknownMajor = await resolve();
    assert.equal(unknownMajor.state, "managed", "a newer major with the same observed contract is not blocked by its number");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
