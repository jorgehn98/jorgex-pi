import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(testDir, "..");

test("Pi 0.84.2 loads the package bootstrap before binding runtime actions and its guard starts fail-closed", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "jorgex-pi-loader-"));
  try {
    const isolation = {
      home: join(sandbox, "home"),
      agentDir: join(sandbox, "agent"),
      xdgConfig: join(sandbox, "xdg-config"),
      tempRoot: join(sandbox, "pi-subagents-temp"),
    };
    for (const path of Object.values(isolation)) mkdirSync(path, { recursive: true });
    const env = {
      ...allowedHostEnv(),
      HOME: isolation.home,
      PI_CODING_AGENT_DIR: isolation.agentDir,
      PI_SUBAGENTS_TEMP_ROOT: isolation.tempRoot,
      XDG_CACHE_HOME: join(sandbox, "xdg-cache"),
      XDG_CONFIG_HOME: isolation.xdgConfig,
      XDG_DATA_HOME: join(sandbox, "xdg-data"),
      TEMP: join(sandbox, "temp"),
      TMP: join(sandbox, "temp"),
      TMPDIR: join(sandbox, "temp"),
    };
    mkdirSync(env.TMPDIR, { recursive: true });
    assert.equal(Object.hasOwn(env, "PI_PACKAGE_DIR"), false, "PI_PACKAGE_DIR must remain the Pi binary's read-only package root");
    const output = execFileSync(process.execPath, [join(testDir, "fixtures", "load-bootstrap-with-pi.mjs"), root], {
      cwd: sandbox,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const loaded = JSON.parse(output);
    assert.deepEqual(loaded.errors, [], "the package bootstrap must not call runtime actions during Pi extension loading");
    assert.equal(loaded.extensionCount, 1, "the root package manifest must load exactly one bootstrap extension");
    assert.equal(loaded.guard?.block, true, "the real Pi runner must see the JorgeX guard before session health");
    assert.equal(loaded.guard?.terminate, true, "the pre-health guard must terminate the blocked tool batch");
    assert.deepEqual(loaded.isolation, { ...isolation, piPackageDirConfigured: false });
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

function allowedHostEnv() {
  const allowed = {};
  for (const key of ["PATH", "PATHEXT", "SYSTEMROOT", "SystemRoot", "COMSPEC", "ComSpec", "WINDIR", "windir"]) {
    if (process.env[key] !== undefined) allowed[key] = process.env[key];
  }
  return allowed;
}
