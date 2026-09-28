import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const contractPath = fileURLToPath(new URL("../contract/browser-handoffs.v1.json", import.meta.url));

test("T42 declares the browser handoff schemas supported by published Pi readers", () => {
  const contract = JSON.parse(readFileSync(contractPath, "utf8"));
  assert.deepEqual(contract, {
    schemaVersion: 1,
    playwright: [1, 2],
    devtools: [1, 2, 3],
  });
});
