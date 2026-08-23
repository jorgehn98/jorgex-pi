# JorgeX Pi

`jorgex-pi` is the single Pi-native package for the JorgeX harness. JorgeX Stack remains the fleet manager and canonical source of shared assets; this repository owns their reviewed Pi representation and lifecycle.

This private development package is not an end-user release. PR03 activates the JorgeX skills and subagent runtime behind one fail-closed bootstrap while retaining a pinned, versioned snapshot of the JorgeX Stack sources.

## Current boundary

| Area | Current state |
| --- | --- |
| Compatibility | Tested only with Pi `0.84.2`; the contract does not claim a wider range. |
| Pi resources | One bootstrap extension and 16 reviewed JorgeX skills are active. Prompts and themes remain empty. |
| Canonical snapshot | 15 agents and 17 complete skill trees (96 files) from JorgeX Stack commit `6d2b98b1728e275bf97920f9712dd4b7928de6a7`. |
| Runtime agents | 13 runnable subagents, a dormant primary orchestrator, and Engram deferred behind the stable `engram-runtime-tools-v1` capability. |
| Package assets | `contract/assets.v1.json` owns the bootstrap, runtime agents, snapshot, skills, and contracts; it declares no JorgeX-managed external writes and preserves four companion-owned state paths. |
| Active companions | `@gotgenes/pi-permission-system@27.0.0`, `@juicesharp/rpiv-ask-user-question@2.7.0`, and `pi-subagents@0.54.0`. |
| Model policy | Provider, model, and thinking level are inherited from the Pi session. JorgeX tiers remain contract metadata only. |

The active skill list contains 16 explicit package-local paths. `playwright-cli` remains in the canonical snapshot but is not activated because browser automation is a separate opt-in integration. Upstream companion skills and prompts are also left inactive.

`contract/jorgex-pi.v1.json` advertises the active versioned capabilities (`foundation-contract-v1`, `stack-snapshot-v1`, `runtime-agents-v1`, `permission-gated-tools-v1`, and `structured-questions-v1`) and links `runtimeAgents.contractPath` to `contract/runtime-agents.v1.json`. That runtime contract records the translation from the 15 canonical agents. The 13 runnable files live in `agents/`; `primary/orchestrator.md` is packaged but not activated as a subagent, and `deferred/agents/engram.md` remains inert until the stable `engram-runtime-tools-v1` capability is available. The contract preserves each JorgeX tier without imposing model, provider, thinking, or fallback choices.

The Pi projection preserves the canonical bash boundary per agent. `none` exposes no bash tool or bash policy; `git-read` exposes bash but denies every command except `git diff*` and `git log*`; `full` exposes bash without adding a per-agent restriction.

## Bootstrap and safety boundary

`extensions/bootstrap.ts` is the only root extension. Pi's resource loader discovers and initializes it before runtime actions are bound, but that loading phase only registers handlers and companion tools; calls that require runner actions, including changes to the active tool set, occur only after `bindCore` and the corresponding lifecycle event. The bootstrap loads permission, ask, and subagents in that order, but hides `ask_user_question`, `subagent`, and `subagent_wait` until the current session emits `permissions:ready` and has a keyed permissions service. A bootstrap guard is registered before companion loading and blocks all tool calls with termination until that health boundary is satisfied. Load or factory failures retain that fail-closed guard, keep partial companion tools hidden, and surface one diagnostic identifying the phase, companion, and original cause at the next session start.

Health is session-scoped and cleared on session start or shutdown. Repeated ready events do not re-enable tools the user disabled. In headless sessions, `ask_user_question` stays unavailable instead of fabricating an answer; subagent delegation remains available after permission health.

This atomic safety guarantee applies to the tool-call flow. Pi's public API does not let the bootstrap roll back or pre-guard slash commands, companion event channels, or the event/RPC bridges registered internally by `pi-subagents`. Those surfaces retain their upstream lifecycle and error handling; this package does not claim otherwise.

## Development

Use pnpm for repository work:

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm build
pnpm pack
```

`pnpm install --frozen-lockfile` provisions `@earendil-works/pi-coding-agent@0.84.2` as an exact development dependency. The lifecycle test invokes that local Pi entrypoint with isolated home, cache, workspace, and `PI_CODING_AGENT_DIR` paths, so verification does not depend on a globally installed Pi. Pi itself is not bundled in the tarball and is not a runtime dependency of `jorgex-pi`.

### Refresh and verify the canonical snapshot

Regenerate only from a local JorgeX Stack checkout that contains the pinned commit:

```bash
JORGEX_STACK_DIR="/abs/path/to/JorgeX Stack" pnpm snapshot:generate
```

The generator reads raw Git objects at the exact SHA, ignoring replacement refs; it does not use live working-tree content or download upstream assets. It produces `snapshot/agents`, `skills`, and `contract/parity.v1.json` deterministically and publishes the three together as one transaction. If publication fails, the prior generation is restored. The generated assets contain 15 agents and all 96 files from the 17 approved skill trees.

Run the explicit cross-repository parity check against the same checkout:

```bash
JORGEX_STACK_DIR="/abs/path/to/JorgeX Stack" node --test tests/cross-repo/snapshot-parity.test.mjs
```

Skills are preserved byte-for-byte. Agent sources are normalized to LF for portable output, so the parity manifest records separate source and output SHA-256 hashes. A general `git diff --check` can therefore report the three reviewed trailing-whitespace occurrences inherited from the canonical skills; the hashes in `contract/parity.v1.json` are the parity authority.

Regenerate the Pi-native agent projection after refreshing the snapshot:

```bash
pnpm runtime-agents:generate
```

This publishes `agents`, `deferred/agents`, `primary`, and `contract/runtime-agents.v1.json` transactionally; a failure restores the previous generation. `pnpm test` verifies deterministic output, containment, the bundled closure, and the isolated Pi lifecycle. `pnpm pack` creates the candidate tarball with the bootstrap, resources, pinned companions, audited closure, and required WASM files. Development generators and transaction modules under `scripts/` are excluded.

The package is currently `private` with the development version `0.0.0-development`. There is therefore no valid installation command for users yet. After a reviewed release is published, installation will use Pi's package manager with an exact version:

```bash
pi install npm:jorgex-pi@<published-version>
```

That command is the narrow package-manager exception: Pi uses npm internally to register and resolve its own package. Repository development, dependency management, and release preparation continue to use pnpm exclusively.

## Paths, state, and ownership

Pi may relocate its agent directory through `PI_CODING_AGENT_DIR`; the package relies on Pi and its companions to resolve that location rather than assuming a fixed user path.

The ownership boundary is `contract/assets.v1.json`. Only its package paths belong to JorgeX, and `managedExternalWrites` is empty. Permission-system and ask configuration is user-owned: the bootstrap does not seed, replace, or remove it. The manifest records four `preservedExternalState` paths that must survive JorgeX install, reinstall, and removal:

- `@gotgenes/pi-permission-system`: `PI_CODING_AGENT_DIR/extensions/pi-permission-system/config.json`
- `@gotgenes/pi-permission-system`: `PI_CODING_AGENT_DIR/extensions/pi-permission-system/logs`
- `@gotgenes/pi-permission-system`: `PI_CODING_AGENT_DIR/sessions/permission-forwarding`
- `@juicesharp/rpiv-ask-user-question`: `XDG_CONFIG_HOME/rpiv-ask-user-question/config.json`

These paths may be created or managed by their named companions during normal operation; declaring them preserved does not transfer their ownership to JorgeX.

## Supply chain and security

`contract/components.v1.json` distinguishes the three active companions from the audited future roadmap. Runtime and bundled dependencies are exact pins, the lockfile records audited npm `sha512` integrity values, and installation performs no live GitHub download. The tarball carries the complete companion closure for the tested offline Pi lifecycle.

The repository contains no keys, tokens, credentials, or secret placeholders. PR03 adds no web access, MCP setup, Engram runtime, goals, custom theme, startup branding, or project bootstrap. It does not impose a permission configuration: policy remains an explicit user concern.
