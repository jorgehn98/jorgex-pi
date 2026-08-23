import { renameSync } from "node:fs";
import { commitTransaction } from "./snapshot-transaction.mjs";

const DESTINATIONS = ["agents", "deferred/agents", "primary", "contract/runtime-agents.v1.json"];

export function commitRuntimeAgents({ root, stage, move = renameSync }) {
  return commitTransaction({
    root,
    stage,
    move,
    destinations: DESTINATIONS,
    backupName: ".runtime-agents-backup",
    label: "Runtime agent",
    preserveFlag: "preserveRuntimeAgentsStage",
  });
}
