import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_WAIT_MS = 300_000;
const plainVersion = value => typeof value === "string"
  && /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/.test(value) && !/\s/.test(value);

export function validateNotificationPayload(payload) {
  if (!payload || Array.isArray(payload) || typeof payload !== "object"
    || Object.keys(payload).sort().join(",") !== "producer_sha,run_id,version") {
    throw new Error("Notification payload must contain exactly version, producer_sha and run_id");
  }
  const { version, producer_sha, run_id } = payload;
  if (!plainVersion(version)) throw new Error("version must be plain x.y.z");
  if (typeof producer_sha !== "string" || producer_sha.length !== 40 || !/^[0-9a-f]{40}$/.test(producer_sha)) {
    throw new Error("producer_sha must be a complete lowercase SHA40");
  }
  if (typeof run_id !== "string" || !/^[1-9][0-9]{0,19}$/.test(run_id) || /\s/.test(run_id)) {
    throw new Error("run_id must be a positive decimal string of at most 20 digits without leading zeros");
  }
  return { version, producer_sha, run_id };
}

function git(root, args) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^GIT_/i.test(key)) delete env[key];
  Object.assign(env, {
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0",
  });
  return execFileSync("git", ["--no-replace-objects", "--no-optional-locks", "-C", root, ...args], {
    env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    maxBuffer: MAX_METADATA_BYTES, timeout: 30_000,
  }).trim();
}

class PendingRegistryError extends Error {}

function validateMetadata(data, version) {
  const integrity = data?.dist?.integrity;
  if (data?.name !== "jorgex-pi" || data.version !== version
    || data?.dist?.tarball !== `https://registry.npmjs.org/jorgex-pi/-/jorgex-pi-${version}.tgz`) {
    throw new Error("Invalid registry metadata identity or tarball origin");
  }
  if (typeof integrity !== "string" || integrity.length !== 95 || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)
    || Buffer.from(integrity.slice(7), "base64").length !== 64
    || Buffer.from(integrity.slice(7), "base64").toString("base64") !== integrity.slice(7)) {
    throw new Error("Invalid registry sha512 integrity");
  }
  return data;
}

async function requestMetadata(url, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  let reader;
  let response;
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new PendingRegistryError("Registry request timed out"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([deadline, (async () => {
      try {
        response = await fetchImpl(url, {
          redirect: "manual", credentials: "omit", signal: controller.signal,
          headers: { accept: "application/json" },
        });
      } catch (error) {
        if (error instanceof TypeError || controller.signal.aborted) throw new PendingRegistryError("Registry network error");
        throw error;
      }
      if (response.redirected || (response.url && response.url !== url)) throw new Error("Unexpected registry response URL");
      if ([404, 429].includes(response.status) || (response.status >= 500 && response.status <= 599)) {
        throw new PendingRegistryError(`Registry HTTP ${response.status}`);
      }
      if (response.status !== 200) throw new Error(`Registry HTTP ${response.status}`);
      if (Number(response.headers.get("content-length")) > MAX_METADATA_BYTES) throw new Error("Registry metadata exceeds 1 MiB limit");
      if (!response.body) throw new Error("Missing registry metadata body");
      reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      while (true) {
        let chunk;
        try {
          chunk = await reader.read();
        } catch (error) {
          if (error instanceof TypeError || controller.signal.aborted) throw new PendingRegistryError("Registry body network error");
          throw error;
        }
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_METADATA_BYTES) throw new Error("Registry metadata exceeds 1 MiB limit");
        chunks.push(Buffer.from(chunk.value));
      }
      try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        throw new Error("Invalid registry metadata JSON");
      }
    })()]);
  } finally {
    clearTimeout(timer);
    // Cancellation must not itself extend the readback deadline.
    if (reader) void reader.cancel().catch(() => {});
    else if (response?.body) void response.body.cancel().catch(() => {});
  }
}

export async function readPublishedVersion(version, {
  fetchImpl = globalThis.fetch, now = () => performance.now(), sleep: wait = sleep,
  maxWaitMs = MAX_WAIT_MS, requestTimeoutMs = 10_000, pollIntervalMs = 10_000,
} = {}) {
  if (!plainVersion(version)) throw new Error("version must be plain x.y.z");
  for (const value of [maxWaitMs, requestTimeoutMs, pollIntervalMs]) {
    if (!Number.isFinite(value) || value <= 0) throw new Error("Invalid registry timeout");
  }
  const end = now() + Math.min(maxWaitMs, MAX_WAIT_MS);
  const url = `https://registry.npmjs.org/jorgex-pi/${version}`;
  while (now() < end) {
    try {
      const data = await requestMetadata(url, fetchImpl, Math.min(requestTimeoutMs, 10_000, end - now()));
      if (now() >= end) break;
      return validateMetadata(data, version);
    } catch (error) {
      if (!(error instanceof PendingRegistryError)) throw error;
    }
    const remaining = end - now();
    if (remaining > 0) await wait(Math.min(pollIntervalMs, remaining));
  }
  throw new Error("Registry readback pending after polling deadline; recover through the Stack coordinator workflow_dispatch without republishing");
}

export async function verifyNotification(payload, { root = process.cwd(), ...registryOptions } = {}) {
  const verified = validateNotificationPayload(payload);
  const { version, producer_sha } = verified;
  let tagSha;
  try {
    tagSha = git(root, ["rev-parse", "--verify", `refs/tags/v${version}^{commit}`]);
  } catch {
    throw new Error("Producer release tag is missing or invalid");
  }
  if (tagSha !== producer_sha) throw new Error("Release tag does not match producer_sha");
  try {
    git(root, ["merge-base", "--is-ancestor", producer_sha, "refs/remotes/origin/main"]);
  } catch {
    throw new Error("Producer must be an ancestor of origin/main");
  }
  let manifest;
  try {
    manifest = JSON.parse(git(root, ["show", `${producer_sha}:package.json`]));
  } catch {
    throw new Error("Invalid producer package.json");
  }
  if (manifest?.name !== "jorgex-pi" || manifest.version !== version) throw new Error("Producer package name/version mismatch");
  await readPublishedVersion(version, registryOptions);
  return verified;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw new Error("Usage: node scripts/notify-stack.mjs");
    if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required");
    const verified = await verifyNotification({
      version: process.env.VERSION, producer_sha: process.env.PRODUCER_SHA, run_id: process.env.RUN_ID,
    });
    appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(verified).map(([key, value]) => `${key}=${value}\n`).join(""));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
