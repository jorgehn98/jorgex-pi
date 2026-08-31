import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve, win32 } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import fc from "fast-check";

const testDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(testDir, "../..");
const manifest = readJson(join(root, "package.json"));
const packageSource = `npm:${manifest.name}@${manifest.version}`;
const platforms = process.platform === "win32" ? ["win32"] : ["linux", "darwin"];
const pathVariants = process.platform === "win32" ? ["exact", "dot", "case-folded"] : ["exact", "dot"];
const pathSegmentArbitrary = fc
  .string({ minLength: 1, maxLength: 8 })
  .map((value) => [...value].map((character) => String.fromCharCode(97 + (character.codePointAt(0) % 26))).join(""));
const sampleArbitrary = fc.record({
  platform: fc.constantFrom(...platforms),
  homeSegments: fc.array(pathSegmentArbitrary, { minLength: 0, maxLength: 3 }),
  agentSegments: fc.array(pathSegmentArbitrary, { minLength: 0, maxLength: 2 }),
  pathVariant: fc.constantFrom(...pathVariants),
  violation: fc.constantFrom("schemaVersion", "packageName", "version", "source", "scope", "path", "binary"),
});

const { resolveConfiguredEngramBinary } = await import("../../extensions/mcp-engram.ts");

test("the receipt resolver accepts exact generated receipts and rejects one explicit mandatory-field violation", () => {
  const propertyRoot = mkdtempSync(join(tmpdir(), "jorgex-pi-engram-property-"));
  try {
    fc.assert(
      fc.property(sampleArbitrary, (sample) => {
        const caseRoot = mkdtempSync(join(propertyRoot, "case-"));
        try {
          const paths = pathModule(sample.platform);
          const home = paths.join(caseRoot, "home", ...sample.homeSegments);
          const agentDir = paths.join(home, "pi-agent", ...sample.agentSegments);
          const receiptPath = paths.join(home, ".jorgex-stack", "pi-receipt.json");
          const pathBin = paths.join(caseRoot, "path-bin");
          const executableName = sample.platform === "win32" ? "engram.exe" : "engram";
          const binary = paths.join(home, executableName);
          const pathBinary = paths.join(pathBin, executableName);
          const invalidBinary = paths.join(home, sample.platform === "win32" ? "engram.cmd" : "missing-engram");
          const envAgentDir = compatibleAgentPath(agentDir, sample.platform, sample.pathVariant);

          mkdirSync(agentDir, { recursive: true });
          mkdirSync(pathBin, { recursive: true });
          writeExecutableFixture(binary);
          writeExecutableFixture(pathBinary);
          if (sample.platform === "win32") writeFileSync(invalidBinary, "non-native fixture\n");

          const validReceipt = createReceipt({ codingAgentDir: agentDir, binary });
          writeReceipt(receiptPath, validReceipt, paths);
          const env = {
            HOME: home,
            USERPROFILE: home,
            PATH: pathBin,
            PI_CODING_AGENT_DIR: envAgentDir,
          };

          assert.equal(
            resolveConfiguredEngramBinary({ env, platform: sample.platform }),
            binary,
            `exact ${sample.platform} receipt with ${sample.pathVariant} paths must resolve its controlled binary fixture`,
          );

          writeReceipt(
            receiptPath,
            violateReceipt(validReceipt, sample.violation, {
              version: mismatchedVersion(manifest.version),
              source: `npm:${manifest.name}@${mismatchedVersion(manifest.version)}`,
              codingAgentDir: paths.join(home, "foreign-agent"),
              binary: invalidBinary,
            }),
            paths,
          );
          assert.equal(
            resolveConfiguredEngramBinary({ env, platform: sample.platform }),
            undefined,
            `${sample.violation} violation must fail closed without falling back to PATH`,
          );
        } finally {
          rmSync(caseRoot, { recursive: true, force: true });
        }
      }),
      { numRuns: 100, seed: 20260831 },
    );
  } finally {
    rmSync(propertyRoot, { recursive: true, force: true });
  }
});

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function createReceipt({ codingAgentDir, binary }) {
  return {
    schemaVersion: 1,
    state: "installed",
    candidate: {
      package: { name: manifest.name, source: packageSource, version: manifest.version },
      tarball: { bytes: 1, sha256: "a", sha512: "b" },
      provenance: { commit: "reviewed" },
    },
    scope: { kind: "real", codingAgentDir },
    engram: { binary },
  };
}

function violateReceipt(receipt, violation, values) {
  const mutated = {
    ...receipt,
    candidate: { ...receipt.candidate, package: { ...receipt.candidate.package } },
    scope: { ...receipt.scope },
    engram: { ...receipt.engram },
  };
  switch (violation) {
    case "schemaVersion":
      mutated.schemaVersion = 2;
      break;
    case "packageName":
      mutated.candidate.package.name = `foreign-${manifest.name}`;
      break;
    case "version":
      mutated.candidate.package.version = values.version;
      break;
    case "source":
      mutated.candidate.package.source = values.source;
      break;
    case "scope":
      mutated.scope.kind = "sandbox";
      break;
    case "path":
      mutated.scope.codingAgentDir = values.codingAgentDir;
      break;
    case "binary":
      mutated.engram.binary = values.binary;
      break;
    default:
      assert.fail(`unknown receipt violation ${violation}`);
  }
  return mutated;
}

function writeReceipt(path, receipt, paths) {
  mkdirSync(paths.dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(receipt)}\n`);
}

function writeExecutableFixture(path) {
  writeFileSync(path, "native fixture; never execute\n");
  chmodSync(path, 0o755);
}

function compatibleAgentPath(agentDir, platform, variant) {
  if (variant === "dot") return `${agentDir}${platform === "win32" ? "\\\\" : "/"}.`;
  if (variant === "case-folded") return agentDir.toUpperCase();
  return agentDir;
}

function pathModule(platform) {
  return platform === "win32" ? win32 : posix;
}

function mismatchedVersion(version) {
  return version === "0.0.0" ? "0.0.1" : "0.0.0";
}