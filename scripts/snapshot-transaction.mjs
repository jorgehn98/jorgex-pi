import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

const LEGACY_DESTINATIONS = ["snapshot", "skills", "contract/parity.v1.json"];
const QUALITY_RECEIPT_DESTINATION = "contract/schemas/quality-receipt.v1.schema.json";
const QUALITY_CAPABILITIES_DESTINATION = "contract/schemas/quality-capabilities.v1.schema.json";
const V2_DESTINATIONS = [
  "snapshot",
  "skills",
  "assets/system-prompt",
  "prompts",
  "contract/parity.v2.json",
  { path: "contract/parity.v1.json", remove: true },
];

export function commitSnapshot({ root, stage, move = renameSync }) {
  return commitTransaction({
    root,
    stage,
    move,
    destinations: existsSync(join(stage, "contract", "parity.v2.json"))
      ? [
          ...V2_DESTINATIONS,
          ...(existsSync(join(stage, QUALITY_RECEIPT_DESTINATION)) ? [QUALITY_RECEIPT_DESTINATION] : []),
          ...(existsSync(join(stage, QUALITY_CAPABILITIES_DESTINATION)) ? [QUALITY_CAPABILITIES_DESTINATION] : []),
        ]
      : LEGACY_DESTINATIONS,
    backupName: ".snapshot-backup",
    label: "Snapshot",
    preserveFlag: "preserveSnapshotStage",
  });
}

export function commitTransaction({ root, stage, move = renameSync, destinations, backupName, label, preserveFlag }) {
  const backupRoot = join(stage, backupName);
  const states = destinations.map((destination) => {
    const { path, remove = false } = typeof destination === "string" ? { path: destination } : destination;
    return {
      path,
      remove,
      source: join(stage, path),
      target: join(root, path),
      backup: join(backupRoot, path),
      backedUp: false,
      published: false,
    };
  });

  for (const state of states) {
    if (!state.remove && !existsSync(state.source)) throw new Error(`${label} stage is missing ${state.path}`);
  }

  let publicationError;
  let preserveBackup = false;
  try {
    for (const state of states) {
      if (existsSync(state.target)) {
        mkdirSync(dirname(state.backup), { recursive: true });
        move(state.target, state.backup);
        state.backedUp = true;
      }
      if (state.remove) {
        state.published = true;
        continue;
      }
      mkdirSync(dirname(state.target), { recursive: true });
      move(state.source, state.target);
      state.published = true;
    }
  } catch (error) {
    publicationError = error;
    const rollbackErrors = rollback(states, move);
    if (rollbackErrors.length > 0) {
      preserveBackup = true;
      const failure = new AggregateError(rollbackErrors, `${label} publication failed and rollback was incomplete`, {
        cause: error,
      });
      failure[preserveFlag] = true;
      throw failure;
    }
    throw error;
  } finally {
    if (!preserveBackup) {
      try {
        rmSync(backupRoot, { recursive: true, force: true });
      } catch (cleanupError) {
        if (!publicationError) throw cleanupError;
      }
    }
  }
}

function rollback(states, move) {
  const errors = [];
  for (const state of [...states].reverse()) {
    try {
      if (state.published && !state.remove) rmSync(state.target, { recursive: true, force: true });
      if (state.backedUp) {
        mkdirSync(dirname(state.target), { recursive: true });
        move(state.backup, state.target);
      }
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}
