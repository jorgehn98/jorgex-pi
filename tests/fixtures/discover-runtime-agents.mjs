import { createJiti } from "jiti";
import { writeFileSync } from "node:fs";

const names = JSON.parse(process.argv[2] ?? "[]");
const jiti = createJiti(import.meta.url, { moduleCache: false });
const { resolveSubagentLaunchContract } = await jiti.import("pi-subagents/preflight");
const results = [];
for (const name of names) {
  const result = await resolveSubagentLaunchContract({ agent: name, cwd: process.cwd(), context: "fresh", artifacts: false });
  results.push({
    requestedName: name,
    ok: result.ok,
    code: result.code,
    message: result.message,
    discoveredName: result.ok ? result.contract.agent.name : undefined,
    model: result.ok ? result.contract.model : undefined,
    modelCandidates: result.ok ? result.contract.modelCandidates : undefined,
    inheritSkills: result.ok ? result.contract.inheritSkills : undefined,
    skills: result.ok ? result.contract.skills : undefined,
    effectiveAllowlist: result.ok ? result.contract.tools.effectiveAllowlist : undefined,
    configuredExtensions: result.ok ? result.contract.tools.configuredExtensions : undefined,
  });
}
writeFileSync(1, `${JSON.stringify(results)}\n`);
