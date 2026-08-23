# JorgeX Pi

`jorgex-pi` is the single Pi-native package for the JorgeX harness. JorgeX Stack remains the fleet manager and canonical source of shared assets; this repository owns their reviewed Pi representation and lifecycle.

This private development package is not an end-user release. PR05 adds pinned Goal continuation behind the existing fail-closed bootstrap while retaining a versioned snapshot of the JorgeX Stack sources.

## Current boundary

| Area | Current state |
| --- | --- |
| Compatibility | Tested only with Pi `0.84.2`; the contract does not claim a wider range. |
| Pi resources | One bootstrap extension and 16 reviewed JorgeX skills are active. Prompts and themes remain empty. |
| Canonical snapshot | 15 agents and 17 complete skill trees (96 files) from JorgeX Stack commit `6d2b98b1728e275bf97920f9712dd4b7928de6a7`. |
| Runtime agents | 13 runnable subagents, a dormant primary orchestrator, and Engram deferred behind the stable `engram-runtime-tools-v1` capability. |
| Package assets | `contract/assets.v1.json` owns the bootstrap, runtime agents, snapshot, skills, and contracts; it declares no JorgeX-managed external writes and preserves thirteen companion-owned state paths. |
| Active companions | `@gotgenes/pi-permission-system@27.0.0`, `@juicesharp/rpiv-ask-user-question@2.7.0`, `pi-subagents@0.54.0`, `pi-web-access@0.24.1`, and `@narumitw/pi-goal@0.53.0`. |
| Model policy | Provider, model, and thinking level are inherited from the Pi session. JorgeX tiers remain contract metadata only. |

The active skill list contains 16 explicit package-local paths. `playwright-cli` remains in the canonical snapshot but is not activated because browser automation is a separate opt-in integration. Upstream companion skills and prompts are also left inactive.

`contract/jorgex-pi.v1.json` advertises the active versioned capabilities (`foundation-contract-v1`, `stack-snapshot-v1`, `runtime-agents-v1`, `permission-gated-tools-v1`, `structured-questions-v1`, `web-access-v1`, and `goal-continuation-v1`) and links `runtimeAgents.contractPath` to `contract/runtime-agents.v1.json`. That runtime contract records the translation from the 15 canonical agents. The 13 runnable files live in `agents/`; `primary/orchestrator.md` is packaged but not activated as a subagent, and `deferred/agents/engram.md` remains inert until the stable `engram-runtime-tools-v1` capability is available. The contract preserves each JorgeX tier without imposing model, provider, thinking, or fallback choices.

The Pi projection preserves the canonical bash boundary per agent. `none` exposes no shell capability; `git-read` replaces bash with the child-only `git_read` tool, which executes only `git diff` and `git log` through validated argv without a shell; `full` exposes bash and remains governed by the user's permission policy. This dedicated tool avoids relying on `permission.bash`, which `pi-subagents@0.54.0` does not support.

## Bootstrap and safety boundary

`extensions/bootstrap.ts` is the only root extension. Pi's resource loader discovers and initializes it before runtime actions are bound, but that loading phase only registers handlers and companion tools; calls that require runner actions, including changes to the active tool set, occur only after `bindCore` and the corresponding lifecycle event. The bootstrap loads permission, ask, subagents, Web Access, and—only after its preflight succeeds—Goal in that order, dynamically capturing the tools registered by Web Access and Goal. A bootstrap guard is registered before companion loading and blocks all tool calls with termination until the current session emits `permissions:ready` and has a keyed permissions service. Load or factory failures retain that fail-closed guard, keep partial companion tools hidden, and surface a diagnostic identifying the phase, companion, and original cause at the next session start.

Health is session-scoped and cleared on session start or shutdown. A normal session start does not mutate Pi's current tool selection: the guard supplies the pre-health boundary. If a prompt starts before health, the bootstrap records the selected companion tools and hides them. Once health arrives, it reconciles that snapshot against the current active tools and never adds a missing tool, so a selection disabled during the wait cannot be revived from stale state. If health arrives before the first prompt, the current selection remains untouched. Later ready events also never re-enable disabled tools. In headless sessions, `ask_user_question` stays unavailable instead of fabricating an answer; subagent delegation remains available after permission health.

The bootstrap reads Pi settings only to prevent loading Web Access or its bundled Goal twice. It checks global `PI_CODING_AGENT_DIR/settings.json` (default `~/.pi/agent/settings.json`) and project `.pi/settings.json` for pinned or unpinned npm entries, including object entries with `source`. Each detector latches and reports its own issue only after a UI notification is actually delivered. Web Access detection retains the existing global fail-closed boundary. A Goal duplicate or unreadable Goal preflight skips only the bundled Goal; permission health, Web Access, and subagents remain available. Detection never rewrites settings. JorgeX Stack PR07 will add install/sync preflight and ownership-safe migration for npm, local, and Git package identities; the runtime detector intentionally recognizes only npm identities.

This atomic safety guarantee applies to the tool-call flow. A bundled healthy Goal is additionally gated at its command, managed-run start, prompt, settled-continuation, and message-delivery boundaries so it cannot start provider work before permission health. A valid managed-run request rejected by that gate receives the upstream-compatible terminal `ACTIVATION_FAILED` error instead of disappearing silently. Other companion slash commands and the event/RPC bridges registered internally by `pi-subagents` retain their upstream lifecycle and error handling; this package does not claim to guard those surfaces.

## Goal continuation and orchestrator policy

In the managed configuration, bundled `@narumitw/pi-goal@0.53.0` is the sole producer of automatic continuation. It owns `/goal`, the `goal_complete`, `goal_blocked`, and `goal_wait` tools, session persistence, settled-idle continuation, and its disabled-by-default managed-run RPC channel. JorgeX does not add a second loop, queue, command, or RPC producer. The orchestrator skill remains policy: it governs phases, delegation, the durable `work/{name}/plan.md` board, verification, and delivery, while Goal only keeps the active objective moving between settled turns.

An absent `PI_CODING_AGENT_DIR/pi-goal.json` uses the pinned upstream defaults without creating a file: Goal tools appear after the first accepted goal, RPC is off, automatic work pauses after 25 responses, and the no-progress guard pauses after three repeated runs. The former experimental queue is removed upstream. JorgeX neither seeds nor overrides these settings, including with unlimited values. An invalid or unreadable existing config latches Goal unhealthy for the loaded bootstrap and omits the bundled Goal entirely; the rest of the foundation remains healthy. Correct the config and reload Pi explicitly to enable Goal.

Goal's active prompt is appended before JorgeX browser routing, so Goal supplies continuation state while the JorgeX guidance remains the final capability policy. If a direct npm Goal is detected, JorgeX does not load its bundled copy. The external Goal remains unmanaged and outside the Goal-specific safety bridge; remove it and reload Pi to return to the supported managed configuration. Current managed Goal state lives in Pi's session entries; the user-owned config and legacy `pi-goal-state.json` are preserved across JorgeX lifecycle operations.

## Web Access and browser routing

Web Access is the core route for web research, source verification, and static HTTP(S) retrieval, including remote PDF, GitHub, and YouTube content. The four default upstream tools are `web_search`, `source_check`, `fetch_content`, and `get_search_content`; custom upstream tool names are captured and health-gated at registration time. Retrieved content is untrusted data, not instructions.

The JorgeX wrapper gives `web_search` a safe workflow precedence: a valid per-call `workflow` wins, then a valid value from the user's read-only `web-search.json`, and otherwise `none`. Thus the browser curator does not open by default through the tool route. `summary-review` or `auto-summary` remains an explicit per-call or user-config choice. The wrapper never creates or repairs that configuration. Browser-cookie authentication and remote hosted fetch providers also retain the upstream opt-in defaults; JorgeX does not enable `allowBrowserCookies`, `authFetch`, or `fetchRouting.allowRemoteHostedProviders`.

`fetch_content` accepts only absolute remote HTTP(S) URLs through JorgeX. Local paths plus `file:`, `data:`, and other schemes are rejected before the upstream companion runs. A GitHub URL may cause the upstream package to clone into its configured temporary clone root (default `/tmp/pi-github-repos`), whose session cache the companion clears. PDF extraction may write generated Markdown under the OS temporary `pi-web-pdf` directory. Those temporary artifacts are upstream behavior, not JorgeX-managed external writes.

Playwright remains a separate opt-in route, used only when the task requires interactive browser UI, forms, dynamic DOM, screenshots, or tracing. Browser profiles, authenticated sessions, cookies, and stored browser state require explicit user approval; page DOM, downloads, and dialogs remain untrusted data. Its existing snapshot skill is not activated or duplicated. The injected routing hides every Playwright reference by default and does not infer consent from a binary found on `PATH`; a future JorgeX Stack adapter must explicitly supply a ready capability and its managed command path before Pi advertises it.

`pi-web-access` also registers `/websearch`, `/curator`, `/google-account`, and `/search`. These slash commands are explicit user actions and do not pass through Pi's `tool_call` health guard. They retain the companion's own lifecycle, UI, configuration, and error handling; the fail-closed guarantee above applies to agent tool calls, not those commands.

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

The ownership boundary is `contract/assets.v1.json`. Only its package paths belong to JorgeX, and `managedExternalWrites` is empty. Permission-system, ask, Web Access, and Goal state is companion- or user-owned: the bootstrap does not seed, replace, or remove it. The manifest records thirteen `preservedExternalState` paths that must survive JorgeX install, reinstall, and removal:

- `@gotgenes/pi-permission-system`: `PI_CODING_AGENT_DIR/extensions/pi-permission-system/config.json`
- `@gotgenes/pi-permission-system`: `PI_CODING_AGENT_DIR/extensions/pi-permission-system/logs`
- `@gotgenes/pi-permission-system`: `PI_CODING_AGENT_DIR/sessions/permission-forwarding`
- `@juicesharp/rpiv-ask-user-question`: `XDG_CONFIG_HOME/rpiv-ask-user-question/config.json`
- `@juicesharp/rpiv-ask-user-question`: `HOME/.config/rpiv-ask-user-question/config.json` (default and legacy fallback when the preferred XDG file is unavailable)
- `pi-web-access`: `PI_CODING_AGENT_DIR/web-search.json`
- `pi-web-access`: `PI_CODING_AGENT_DIR/web-search-cache`
- `pi-web-access`: `XDG_CONFIG_HOME/pi/web-search.json`
- `pi-web-access`: `XDG_CONFIG_HOME/pi/web-search-cache`
- `pi-web-access`: `HOME/.pi/web-search.json`
- `pi-web-access`: `HOME/.pi/web-search-cache`
- `@narumitw/pi-goal`: `PI_CODING_AGENT_DIR/pi-goal.json`
- `@narumitw/pi-goal`: `PI_CODING_AGENT_DIR/pi-goal-state.json` (legacy state retained for ownership-safe migration and clear behavior)

The XDG and HOME ask paths may resolve to the same file; lifecycle consumers preserve both declarations and deduplicate resolved paths. These paths may be created or managed by their named companions during normal operation; declaring them preserved does not transfer their ownership to JorgeX.

## Supply chain and security

`contract/components.v1.json` distinguishes the five active companions from the audited future roadmap. Runtime and bundled dependencies are exact pins, the lockfile records audited npm `sha512` integrity values, and installation performs no live GitHub download. Goal's bundled closure resolves `@narumitw/pi-tui-kit` to the audited lock version alongside its exact transitive packages. The tarball carries the complete companion closure for the tested offline Pi lifecycle.

The repository contains no keys, tokens, credentials, or secret placeholders. PR05 adds Goal without API keys, browser credentials, MCP setup, Engram runtime, custom theme, startup branding, or project bootstrap. It does not impose a permission or Goal configuration: policy remains an explicit user concern.
