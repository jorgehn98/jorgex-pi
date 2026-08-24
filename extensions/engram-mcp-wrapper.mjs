#!/usr/bin/env node

import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

export const ENGRAM_CHILD_ENV_KEYS = [
  "HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "APPDATA", "LOCALAPPDATA",
  "TMPDIR", "TEMP", "TMP", "SystemRoot", "SYSTEMROOT", "WINDIR", "LANG", "LC_ALL",
  "LC_CTYPE", "TZ", "ENGRAM_DATA_DIR", "ENGRAM_PROJECT", "ENGRAM_TIMEZONE",
];

export function buildEngramChildSpec({ binary, env = process.env }) {
  if (typeof binary !== "string" || !isAbsolute(binary) || !isExecutableFile(binary)
    || (process.platform === "win32" && !/\.exe$/i.test(binary))) {
    throw new Error("Engram MCP requires an absolute executable ENGRAM_BIN path.");
  }
  return {
    file: binary,
    args: ["mcp", "--tools=agent"],
    options: {
      env: Object.fromEntries(ENGRAM_CHILD_ENV_KEYS.flatMap((key) => env[key] === undefined ? [] : [[key, env[key]]])),
      shell: false,
    },
  };
}

function isExecutableFile(path) {
  try {
    const stat = statSync(path);
    return stat.isFile() && (process.platform === "win32" || (stat.mode & 0o111) !== 0);
  } catch {
    return false;
  }
}

async function main() {
  if (process.argv.length !== 3) throw new Error("Expected one absolute Engram binary path.");
  const child = buildEngramChildSpec({ binary: process.argv[2] });
  const processHandle = spawn(child.file, child.args, { ...child.options, stdio: "inherit" });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => processHandle.kill(signal));
  }
  processHandle.once("error", (error) => {
    process.stderr.write(`Engram MCP failed to start: ${error.message}\n`);
    process.exitCode = 1;
  });
  processHandle.once("exit", (code, signal) => {
    process.exitCode = signal ? 1 : (code ?? 1);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
