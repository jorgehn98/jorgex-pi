import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const load = () => import("../scripts/notify-stack.mjs");
const version = "0.8.7";
const input = { version, producer_sha: "a".repeat(40), run_id: "34031189209" };
const url = "https://registry.npmjs.org/jorgex-pi/0.8.7";
const metadata = () => ({ name: "jorgex-pi", version, dist: {
  tarball: "https://registry.npmjs.org/jorgex-pi/-/jorgex-pi-0.8.7.tgz",
  integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
} });
const response = (data = metadata()) => Response.json(data);
const workflow = () => readFileSync(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8");
function job(name) {
  const section = workflow().match(new RegExp(`^  ${name}:\\r?\\n[\\s\\S]*?(?=^  [\\w-]+:|$(?![\\s\\S]))`, "m"))?.[0];
  assert.ok(section, `missing ${name} job`);
  return section;
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "jorgex-pi-notify-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^GIT_/i.test(key)) delete env[key];
  Object.assign(env, { GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
  const git = (...args) => execFileSync("git", ["-C", root, ...args], {
    env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  }).trim();
  git("init", "-q", "--initial-branch=main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "commit.gpgsign", "false");
  const commit = (name, v) => {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name, version: v }));
    git("add", "package.json");
    git("commit", "-qm", "fixture");
    return git("rev-parse", "HEAD");
  };
  const producer_sha = commit("jorgex-pi", version);
  git("tag", `v${version}`);
  git("update-ref", "refs/remotes/origin/main", producer_sha);
  return { root, git, commit, payload: { ...input, producer_sha } };
}

test("notification input accepts only three exact scalar fields, without trimming or output injection", async () => {
  const { validateNotificationPayload } = await load();
  assert.deepEqual(validateNotificationPayload(input), input);
  for (const payload of [null, [], {}, { ...input, extra: true },
    ...["v0.8.7", "0.8.7-beta.1", "0.8.7+build", "00.8.7", "0.8.7\n", "0.8.7\r", "../0.8.7", 7].map(version => ({ ...input, version })),
    ...["a".repeat(39), "g".repeat(40), `${input.producer_sha}\n`, " main", "HEAD"].map(producer_sha => ({ ...input, producer_sha })),
    ...["", "1\n", "1e3", "-1", 123, "12/3"].map(run_id => ({ ...input, run_id })),
  ]) assert.throws(() => validateNotificationPayload(payload), /payload|version|producer_sha|run_id/i);
});

test("producer version matches the coordinator's zero-or-nine-digit component boundaries", async () => {
  const { validateNotificationPayload, readPublishedVersion } = await load();
  for (const version of ["0.0.0", "1.2.3", "999999999.999999999.999999999"]) {
    const payload = { ...input, version };
    assert.deepEqual(validateNotificationPayload(payload), payload);
  }
  let reads = 0;
  for (const version of ["1000000000.0.0", "0.1000000000.0", "0.0.1000000000",
    "01.0.0", "0.01.0", "0.0.01", "0.0.0\n", "0.0.0\r", "0.0.0\r\n", "0.0.0\u2028", " 0.0.0", "0.0.0 "]) {
    assert.throws(() => validateNotificationPayload({ ...input, version }), /version/);
    await assert.rejects(readPublishedVersion(version, { fetchImpl: async () => { reads++; return response(); } }), /version/);
  }
  assert.equal(reads, 0, "invalid versions must fail before registry access");
});

test("producer run_id matches the coordinator's positive decimal string of at most twenty digits", async () => {
  const { validateNotificationPayload } = await load();
  for (const run_id of ["1", "10000000000000000000", "99999999999999999999"]) {
    const payload = { ...input, run_id };
    assert.deepEqual(validateNotificationPayload(payload), payload);
  }
  for (const run_id of ["0", "00", "01", "01234567890123456789", "100000000000000000000",
    "99999999999999999999999999999999", "1\n", "1\r", "1\r\n", "1\u2028", " 1", "1 ", "+1", 1]) {
    assert.throws(() => validateNotificationPayload({ ...input, run_id }), /run_id/);
  }
});

test("verification reads the tagged producer package, not the later checkout, and returns only verified fields", async t => {
  const { verifyNotification } = await load();
  const f = fixture(t);
  const later = f.commit("jorgex-pi", "0.8.8");
  f.git("update-ref", "refs/remotes/origin/main", later);
  let reads = 0;
  const result = await verifyNotification(f.payload, { root: f.root, fetchImpl: async (target, options) => {
    reads++;
    assert.equal(target, url);
    assert.equal(options.redirect, "manual");
    assert.equal(options.credentials, "omit");
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(new Headers(options.headers).has("authorization"), false);
    return response();
  } });
  assert.deepEqual(result, f.payload);
  assert.equal(reads, 1);
});

test("invalid input, tag mismatch, non-main ancestry and wrong producer package fail before registry access", async t => {
  const { verifyNotification } = await load();
  const f = fixture(t);
  let reads = 0;
  const options = { root: f.root, fetchImpl: async () => { reads++; return response(); } };
  await assert.rejects(verifyNotification({ ...f.payload, extra: true }, options), /payload/i);
  const later = f.commit("jorgex-pi", "0.8.8");
  await assert.rejects(verifyNotification({ ...f.payload, producer_sha: later }, options), /tag/i);
  f.git("tag", "-f", `v${version}`, later);
  await assert.rejects(verifyNotification({ ...f.payload, producer_sha: later }, options), /main|ancestor/i);
  f.git("update-ref", "refs/remotes/origin/main", later);
  await assert.rejects(verifyNotification({ ...f.payload, producer_sha: later }, options), /package|version/i);
  const wrong = f.commit("other-package", version);
  f.git("tag", "-f", `v${version}`, wrong);
  f.git("update-ref", "refs/remotes/origin/main", wrong);
  await assert.rejects(verifyNotification({ ...f.payload, producer_sha: wrong }, options), /package/i);
  f.git("tag", "-d", `v${version}`);
  await assert.rejects(verifyNotification(f.payload, options), /tag/i);
  assert.equal(reads, 0);
});

test("CLI appends only verified outputs and preserves the output file when readback fails", async t => {
  await load();
  const f = fixture(t);
  const outputPath = join(f.root, "outputs");
  const preload = join(f.root, "fake-fetch.mjs");
  const script = fileURLToPath(new URL("../scripts/notify-stack.mjs", import.meta.url));
  const env = { ...process.env, VERSION: version, PRODUCER_SHA: f.payload.producer_sha, RUN_ID: input.run_id, GITHUB_OUTPUT: outputPath };
  const run = () => execFileSync(process.execPath, ["--import", pathToFileURL(preload).href, script], {
    cwd: f.root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000,
  });
  writeFileSync(preload, `globalThis.fetch = async () => Response.json(${JSON.stringify(metadata())});`);
  writeFileSync(outputPath, "existing=value\n");
  assert.equal(run(), "");
  assert.equal(readFileSync(outputPath, "utf8"), `existing=value\nversion=0.8.7\nproducer_sha=${f.payload.producer_sha}\nrun_id=34031189209\n`);
  writeFileSync(outputPath, "existing=value\n");
  writeFileSync(preload, 'globalThis.fetch = async () => Response.json({name:"foreign"});');
  assert.throws(run, error => error.status === 1 && /registry metadata/i.test(String(error.stderr)));
  assert.equal(readFileSync(outputPath, "utf8"), "existing=value\n");
  env.VERSION = "0.8.7\nextra=bad";
  assert.throws(run, error => error.status === 1 && /version/i.test(String(error.stderr)));
  assert.equal(readFileSync(outputPath, "utf8"), "existing=value\n");
});

test("registry rejects invalid identity, tarball origins, integrity and JSON without retry", async () => {
  const { readPublishedVersion } = await load();
  const invalid = [null, [], {}, { ...metadata(), name: "other" }, { ...metadata(), version: "0.8.8" },
    ...["https://evil.invalid/jorgex-pi.tgz", `${metadata().dist.tarball}?x=1`, `${metadata().dist.tarball}\n`,
      "http://registry.npmjs.org/jorgex-pi/-/jorgex-pi-0.8.7.tgz", "https://registry.npmjs.org@evil.invalid/jorgex-pi.tgz"]
      .map(tarball => ({ ...metadata(), dist: { ...metadata().dist, tarball } })),
    ...["sha256-YQ==", "sha512-YQ==", `${metadata().dist.integrity}\n`, `${metadata().dist.integrity} sha512-YQ==`,
      `sha512-${"A".repeat(85)}B==`].map(integrity => ({ ...metadata(), dist: { ...metadata().dist, integrity } })),
  ];
  for (const data of invalid) {
    let reads = 0;
    await assert.rejects(readPublishedVersion(version, { fetchImpl: async () => { reads++; return response(data); } }), /metadata|registry|integrity/i);
    assert.equal(reads, 1);
  }
  let reads = 0;
  await assert.rejects(readPublishedVersion(version, { fetchImpl: async () => { reads++; return new Response("{"); } }), /JSON|metadata/i);
  assert.equal(reads, 1);
});

test("registry fails closed on redirects, foreign response URL, nonrecoverable HTTP and oversized streams", async () => {
  const { readPublishedVersion } = await load();
  for (const status of [301, 302, 307, 308, 400, 401, 403]) {
    let reads = 0;
    await assert.rejects(readPublishedVersion(version, { fetchImpl: async () => { reads++; return new Response(null, { status }); } }), /registry|HTTP|redirect/i);
    assert.equal(reads, 1);
  }
  const foreign = response();
  Object.defineProperty(foreign, "url", { value: "https://evil.invalid/metadata" });
  await assert.rejects(readPublishedVersion(version, { fetchImpl: async () => foreign }), /origin|URL|registry/i);
  for (const headers of [{}, { "content-length": "1048577" }]) {
    let cancelled = false;
    const body = new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(512 * 1024)); },
      cancel() { cancelled = true; },
    });
    await assert.rejects(readPublishedVersion(version, { fetchImpl: async () => new Response(body, { headers }) }), /size|large|limit|MiB/i);
    assert.equal(cancelled, true);
  }
});

test("only propagation/network errors are polled, and never beyond five minutes", async () => {
  const { readPublishedVersion } = await load();
  let time = 0;
  let reads = 0;
  const outcomes = [404, 429, 500, 503, "network", 200];
  await readPublishedVersion(version, { now: () => time, sleep: async ms => { time += ms; }, fetchImpl: async () => {
    const status = outcomes[reads++];
    if (status === "network") throw new TypeError("fetch failed");
    return status === 200 ? response() : new Response(null, { status });
  } });
  assert.equal(reads, 6);
  time = 0;
  reads = 0;
  await assert.rejects(readPublishedVersion(version, { now: () => time, sleep: async ms => { time += ms; }, fetchImpl: async () => {
    reads++;
    assert.ok(time < 300_000, "no request after the polling deadline");
    return new Response(null, { status: 404 });
  } }), /pending|deadline|timed out/i);
  assert.ok(reads > 1 && reads <= 31);
  assert.ok(time <= 300_000);
  reads = 0;
  await assert.rejects(readPublishedVersion(version, { fetchImpl: async () => {
    reads++;
    throw new Error("programming error");
  } }), /programming error/);
  assert.equal(reads, 1);
});

test("request deadlines cover stalled headers and bodies, abort and stay within the polling budget", async () => {
  const { readPublishedVersion } = await load();
  for (const bodyStall of [false, true]) {
    let signal;
    let cancelled = false;
    await assert.rejects(readPublishedVersion(version, {
      maxWaitMs: 45, requestTimeoutMs: 15, pollIntervalMs: 5,
      fetchImpl: async (_url, options) => {
        signal = options.signal;
        if (!bodyStall) return new Promise(() => {});
        return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
      },
    }), /pending|deadline|timed out/i);
    assert.equal(signal.aborted, true);
    if (bodyStall) assert.equal(cancelled, true);
  }
});

test("workflow verification is opt-in, fail-closed and consumes real producer outputs without App credentials", () => {
  const verify = job("verify-notification");
  assert.match(verify, /needs: \[plan, publish, tag-release\]/);
  const condition = verify.match(/^    if: (.+)$/m)?.[1];
  assert.ok(condition);
  const expression = condition.replace(/\$\{\{|\}\}/g, "").replace(/needs\.([\w-]+)\.result/g, 'needs["$1"].result');
  const enabled = new Function("vars", "needs", "always", "cancelled", `return (${expression});`);
  for (const flag of ["true", "false", "", undefined]) for (const cancelled of [true, false]) {
    for (const plan of ["success", "failure", "skipped", "cancelled"]) for (const publish of ["success", "failure", "skipped", "cancelled"]) {
      for (const tag of ["success", "failure", "skipped", "cancelled"]) {
        assert.equal(enabled({ JORGEX_AUTOMATION_ENABLED: flag }, { plan: { result: plan }, publish: { result: publish }, "tag-release": { result: tag } }, () => true, () => cancelled),
          flag === "true" && !cancelled && plan === "success" && ["success", "skipped"].includes(publish) && tag === "success");
      }
    }
  }
  assert.match(verify, /ref: main/);
  assert.match(verify, /persist-credentials: false/);
  assert.match(verify, /fetch-depth: 0/);
  assert.match(verify, /git fetch origin main --tags/);
  assert.match(verify, /VERSION: \$\{\{ needs\.plan\.outputs\.version \}\}/);
  assert.match(verify, /PRODUCER_SHA: \$\{\{ needs\.plan\.outputs\.publish_sha \}\}/);
  assert.match(verify, /RUN_ID: \$\{\{ github\.run_id \}\}/);
  assert.match(verify, /node .\/scripts\/notify-stack\.mjs/);
  assert.doesNotMatch(verify, /secrets\.|create-github-app-token|contents: write|id-token|target_sha|pnpm install/);
});

test("dispatch has a separate verified-only job, exact dedicated App names and safe JSON stdin", () => {
  const notify = job("notify-stack");
  assert.match(notify, /needs: verify-notification/);
  assert.match(notify, /if: always\(\) && !cancelled\(\) && needs\.verify-notification\.result == 'success'/);
  assert.match(notify, /permissions: \{\}/);
  assert.match(notify, /actions\/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1/);
  assert.match(notify, /client-id: \$\{\{ vars\.JORGEX_AUTOMATION_APP_CLIENT_ID \}\}/);
  assert.match(notify, /private-key: \$\{\{ secrets\.JORGEX_AUTOMATION_APP_PRIVATE_KEY \}\}/);
  assert.match(notify, /owner: jorgehn98/);
  assert.match(notify, /repositories: jorgex-stack/);
  assert.deepEqual([...notify.matchAll(/^          (permission-[\w-]+): (.+)$/gm)].map(m => [m[1], m[2].trim()]), [["permission-contents", "write"]]);
  assert.match(notify, /gh api --method POST \/repos\/jorgehn98\/jorgex-stack\/dispatches --input -/);
  assert.doesNotMatch(notify, /checkout@|pnpm|npm publish|--retry|while |for |git push|continue-on-error/);
  const script = notify.match(/node --input-type=module <<'NODE'[^\n]*\n([\s\S]*?)^          NODE/m)?.[1];
  assert.ok(script, "inline Node JSON producer must pipe to gh, never interpolate inputs in shell");
  assert.doesNotMatch(script, /\$\{\{/);
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, VERSION: input.version, PRODUCER_SHA: input.producer_sha, RUN_ID: input.run_id }, encoding: "utf8",
  });
  assert.deepEqual(JSON.parse(output), { event_type: "pi-published-v1", client_payload: input });
  const beforeNotify = workflow().split("\n  notify-stack:")[0];
  assert.doesNotMatch(beforeNotify, /JORGEX_AUTOMATION_APP_PRIVATE_KEY|create-github-app-token/);
});
