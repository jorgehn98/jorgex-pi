import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

const DESTINATIONS = ["snapshot", "skills", "contract/parity.v1.json"];

export function commitSnapshot({ root, stage, move = renameSync }) {
  const backupRoot = join(stage, ".snapshot-backup");
  const states = DESTINATIONS.map((path) => ({
    path,
    source: join(stage, path),
    target: join(root, path),
    backup: join(backupRoot, path),
    backedUp: false,
    published: false,
  }));

  for (const state of states) {
    if (!existsSync(state.source)) throw new Error(`Snapshot stage is missing ${state.path}`);
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
      mkdirSync(dirname(state.target), { recursive: true });
      move(state.source, state.target);
      state.published = true;
    }
  } catch (error) {
    publicationError = error;
    const rollbackErrors = rollback(states, move);
    if (rollbackErrors.length > 0) {
      preserveBackup = true;
      const failure = new AggregateError(rollbackErrors, "Snapshot publication failed and rollback was incomplete", {
        cause: error,
      });
      failure.preserveSnapshotStage = true;
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
      if (state.published) rmSync(state.target, { recursive: true, force: true });
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
