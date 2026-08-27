# JorgeX Pi

`jorgex-pi` is the single Pi-native package for the JorgeX harness. JorgeX Stack remains the fleet manager and canonical source of shared assets; this repository owns their reviewed Pi representation and lifecycle. Version `0.4.0` carries parity snapshot v2 from Stack commit `5353c83c212a8603ab3e3bd5cac54dde4c75037c`.

The version in `package.json` is the release authority. Minor and major remain manual decisions; after merge, the automatic release workflow preserves and publishes an unpublished selection from `main`. Later publicable changes increment the patch automatically. The current line adds the native opt-in JorgeX theme and TUI-only startup branding, shared system-policy and Engram-protocol assets, and the `/lean-audit` prompt while retaining the fail-closed bootstrap, JSON runner, isolated Engram MCP bridge, and versioned Stack snapshot.

## Current boundary

| Area | Current state |
| --- | --- |
| Compatibility | Tested only with Pi `0.84.2`; the contract does not claim a wider range. |
| Pi resources | Bootstrap and TUI branding extensions, 16 reviewed JorgeX skills, the canonical policy/protocol fallbacks, and the `/lean-audit` prompt are active. The `JorgeX` theme is available but opt-in. |
| Canonical snapshot | 15 agents and 17 complete skill trees (96 files) from JorgeX Stack commit `5353c83c212a8603ab3e3bd5cac54dde4c75037c`. |
| Runtime agents | 14 runnable subagents, including the read-only Engram specialist, plus a dormant primary orchestrator. |
| Package assets | `contract/assets.v1.json` owns the packaged extensions, theme, runtime agents, snapshot, skills, and contracts; it declares the bounded Sol lifecycle writes and preserves fourteen companion-owned state paths. |
| Active companions | `@gotgenes/pi-permission-system@27.0.0`, `@juicesharp/rpiv-ask-user-question@2.7.0`, `pi-subagents@0.54.0`, `pi-web-access@0.24.1`, `@narumitw/pi-goal@0.53.0`, and `pi-mcp-adapter@2.27.0`. |
| Model policy | The managed primary is `openai-codex/gpt-5.6-sol`; Pi session thinking remains user/session policy. The local `contextWindow` request is `872000`. |

The active skill list contains 16 explicit package-local paths. `playwright-cli` remains in the canonical snapshot but is not activated because browser automation is a separate opt-in integration. Upstream companion skills and prompts are also left inactive. The parity v2 contract records agents, skills, the shared policy, the Engram protocol, the portable command projection, and deliberate exclusions in `contract/parity.v2.json`.

### Direct package versus managed Stack

There are two intentionally distinct channels:

- **Direct package:** `pi install npm:jorgex-pi@0.4.0` installs the reviewed snapshot, policy/protocol assets, and `/lean-audit` prompt bundled in this package. The extension uses those assets as marker-aware fallbacks: it appends each missing `<!-- jorgex:... -->` section without replacing user prompt content or duplicating a section already supplied by Stack.
- **Future managed Stack adoption (PR02):** a later, separate Stack PR is expected to project the same policy, skills, prompt and capability-conditioned sections into Pi's user-level paths, then filter the packaged duplicates. That PR is not part of this package release and is not assumed to exist; until it is merged, managed installations keep their previously frozen Pi artifact.

The direct fallback is not a second managed installation mechanism. It is a safe package-local fallback for direct installs; Stack-owned markers remain authoritative whenever they are present.

### Managed Sol model lifecycle

The package's managed primary is provider `openai-codex` with model `gpt-5.6-sol`. This is distinct from the API provider `openai`. `sync` fills only missing compatible values in the Pi agent directory (resolved by `PI_CODING_AGENT_DIR`, normally `~/.pi/agent`): it creates both primary fields when both are absent, completes a matching Sol half, and leaves a foreign provider/model pair untouched.

- `settings.json`: `defaultProvider: "openai-codex"` and `defaultModel: "gpt-5.6-sol"`.
- `models.json`: `providers.openai-codex.modelOverrides.gpt-5.6-sol.contextWindow: 872000`.

The `872000` value is a requested local metadata policy, not proof that the backend accepts that context size. In particular, OAuth-backed `openai-codex` sessions must be smoke-tested against the backend; this package does not claim OAuth support for `1.05M`, and it does not configure the separate `openai` API provider.

Pi owns the lifecycle receipt at `PI_CODING_AGENT_DIR/jorgex-pi/sol-lifecycle.v1.json`. It records the fields, containers, and files that this package created. Existing user values, foreign providers/models, and user replacements are preserved. The lifecycle acquires Pi-compatible configuration locks before its read-modify-write cycle and fails closed when another process holds them. `cleanup` removes only receipt-owned fields whose values are still exactly the managed values, then prunes only empty receipt-owned containers/files and removes an empty receipt. If a user changes a managed value, the package releases that field instead of deleting the replacement.

To override the primary, set the relevant values in Pi's `settings.json` or `models.json` before running `sync`, or edit a managed value afterwards. The lifecycle will preserve the existing or changed value and will not treat it as removable package state.

`contract/jorgex-pi.v1.json` advertises the active versioned capabilities, including `mcp-adapter-v1`, `engram-runtime-tools-v1`, `runner-json-v1`, `tui-branding-v1`, and `managed-primary-model-v1`, and links the runtime-agent and runner contracts. The runtime contract records the translation from the 15 canonical agents. All 14 subagents live in `agents/`; `primary/orchestrator.md` is packaged but not activated as a subagent. The runtime-agent contract preserves each JorgeX tier without imposing model, provider, thinking, or fallback choices on subagent routing; the managed primary is documented separately above.

## TUI branding

The package supplies a responsive JorgeX header for interactive Pi sessions only. Its eye mark is a terminal-safe Braille rendering derived from the canonical packaged SVG: narrow terminals keep a compact mark, medium terminals stack the identity and metadata, and wide terminals compose the detailed eye at the left with the `JorgeX Pi` wordmark at the right. The displayed Pi version, package version, runnable-agent count, packaged-skill count, and workspace basename come from their runtime manifests or session context rather than duplicated literals.

The entrance is a single 800 ms reveal with deterministic timer cleanup; `JORGEX_PI_MOTION=reduce`, CI, `TERM=dumb`, and non-TTY output use the final static frame. It never clears stdout. The header is reversible for the current session with `/jorgex:header builtin` and can be restored with `/jorgex:header custom`; non-TUI modes are unchanged. The package also declares the native `JorgeX` Pi theme for selection through Pi's normal theme controls. It never selects, persists, or replaces a user's active theme. [`DESIGN.md`](./DESIGN.md) is the terminal-specific design authority and keeps its palette in tested parity with the opt-in theme.

The Pi projection preserves the canonical bash boundary per agent. `none` exposes no shell capability; `git-read` replaces bash with the child-only `git_read` tool, which executes only `git diff` and `git log` through validated argv without a shell; `full` exposes bash and remains governed by the user's permission policy. This dedicated tool avoids relying on `permission.bash`, which `pi-subagents@0.54.0` does not support.

## Bootstrap and safety boundary

`extensions/bootstrap.ts` is the security-focused root extension. Pi's resource loader discovers and initializes it before runtime actions are bound, but that loading phase only registers handlers and companion tools; calls that require runner actions, including changes to the active tool set, occur only after `bindCore` and the corresponding lifecycle event. The bootstrap loads permission, ask, subagents, Web Access, and—only after its preflight succeeds—Goal in that order, dynamically capturing the tools registered by Web Access and Goal. A bootstrap guard is registered before companion loading and blocks all tool calls with termination until the current session emits `permissions:ready` and has a keyed permissions service. Load or factory failures retain that fail-closed guard, keep partial companion tools hidden, and surface a diagnostic identifying the phase, companion, and original cause at the next session start.

`extensions/branding.ts` is a separate, independent root extension. It only replaces the interactive TUI header in memory and does not select themes, write settings, load companions, or modify the bootstrap health boundary.

Health is session-scoped and cleared on session start or shutdown. A normal session start does not mutate Pi's current tool selection: the guard supplies the pre-health boundary. If a prompt starts before health, the bootstrap records the selected companion tools and hides them. Once health arrives, it reconciles that snapshot against the current active tools and never adds a missing tool, so a selection disabled during the wait cannot be revived from stale state. If health arrives before the first prompt, the current selection remains untouched. Later ready events also never re-enable disabled tools. In headless sessions, `ask_user_question` stays unavailable instead of fabricating an answer; subagent delegation remains available after permission health.

The bootstrap reads Pi settings only to prevent loading Web Access, Goal, or `pi-mcp-adapter` twice. It checks global `PI_CODING_AGENT_DIR/settings.json` (default `~/.pi/agent/settings.json`) and project `.pi/settings.json` for pinned or unpinned npm entries, including object entries with `source`. Each detector latches until Pi reloads and reports its own issue only after a UI notification is actually delivered. Web Access detection retains the existing global fail-closed boundary. A Goal duplicate or unreadable Goal preflight skips only the bundled Goal. A direct `pi-mcp-adapter` entry skips only the internal Engram adapter; permission health, Web Access, Goal, and subagents remain available. Detection never rewrites settings. JorgeX Stack PR07 will add install/sync preflight and ownership-safe migration for npm, local, and Git package identities; the runtime detector intentionally recognizes only npm identities.

This atomic safety guarantee applies to the tool-call flow. A bundled healthy Goal is additionally gated at its command, managed-run start, prompt, settled-continuation, and message-delivery boundaries so it cannot start provider work before permission health. A valid managed-run request rejected by that gate receives the upstream-compatible terminal `ACTIVATION_FAILED` error instead of disappearing silently. Other companion slash commands and the event/RPC bridges registered internally by `pi-subagents` retain their upstream lifecycle and error handling; this package does not claim to guard those surfaces.

## MCP and Engram

The bundled `pi-mcp-adapter@2.27.0` receives a programmatic configuration containing exactly one lazy local server named `engram`. JorgeX does not call the adapter's ambient config loader, import host MCP configuration, preserve foreign server definitions inside its adapter instance, or enable HTTP transport. User MCP configuration remains external and untouched; it is neither adopted nor managed by this package.

The managed bridge resolves Engram in a strict order: a validated absolute `ENGRAM_BIN` supplied by the user first; otherwise the exact installed JorgeX Stack receipt at `~/.jorgex-stack/pi-receipt.json`, when it matches this package's name, version, npm source, real Pi agent directory, and an executable binary path. It never searches `PATH`. On Windows it accepts only a native `.exe` path because the wrapper launches the executable without a shell as `engram mcp --tools=agent`. If neither source resolves, the bridge remains unavailable and the adapter is not loaded. The full bundled Engram protocol is appended to the direct-install prompt only while that managed bridge is operational; an unavailable or colliding bridge does not advertise the protocol or memory tools. The receipt is a discovery hand-off from Stack; Pi does not install, update, remove, or otherwise own the Engram binary or database. The child receives only the documented portability and Engram data/project/timezone environment allowlist—not ambient secrets, proxy variables, Node options, cloud autosync credentials, or npm configuration. Passive capture is excluded, so `mem_capture_passive` is never advertised.

With a healthy managed bridge, the main Pi session receives the 17 reviewed direct Engram tools. The `engram` subagent is deliberately narrower and read-only: it exposes only `mem_search`, `mem_context`, `mem_get_observation`, `mem_suggest_topic_key`, `mem_current_project`, and `mem_doctor`; its contract retains `requiredCapability: engram-runtime-tools-v1` so unavailable runtime state stays machine-readable. Save, update, session-write, review, pin, and unpin operations remain unavailable to that specialist.

The packaged adapter closure includes the audited native keyring bindings for macOS arm64/x64; Linux armhf, arm64, riscv64, and x64 variants covered by the contract; and Windows arm64/ia32/x64. FreeBSD is intentionally outside the tested bundle. Runtime compatibility remains limited to Pi `0.84.2`; the bindings expand platform packaging, not the claimed Pi-version range.

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

## JSON runner

The package exposes the noninteractive `jorgex-pi` binary with the versioned contract in `contract/runner.v1.json` and response schema in `contract/schemas/runner-response.v1.schema.json`. During development, invoke it directly:

```bash
node ./bin/jorgex-pi.mjs status --json
node ./bin/jorgex-pi.mjs doctor --json
node ./bin/jorgex-pi.mjs models --json
node ./bin/jorgex-pi.mjs sync --json
node ./bin/jorgex-pi.mjs cleanup --json
```

`--json` is accepted after the command for Stack compatibility; stdout is one bounded JSON record with a trailing newline even when the flag is omitted. Exit codes are `0` for success, `1` for unhealthy state, `2` for invalid usage, and `3` for an internal failure. `status` reports exact-package registration plus user-owned Engram discovery. `doctor` requires both the exact package registration and an executable Engram binary. Invalid settings retain their path, reason, and remedy in the error envelope. `models` reports the managed `openai-codex/gpt-5.6-sol` primary and the requested local `872000` context window. `sync` and `cleanup` apply the ownership-safe lifecycle described above. For diagnostics only, the runner checks `ENGRAM_BIN` first and otherwise searches `PATH`/`PATHEXT`; it never spawns Engram. This diagnostic fallback does not broaden the managed bridge's `ENGRAM_BIN`-only runtime contract.

## Development

Use pnpm for repository work:

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm build
pnpm pack
```

`pnpm install --frozen-lockfile` provisions `@earendil-works/pi-coding-agent@0.84.2` as an exact development dependency. The lifecycle test invokes that local Pi entrypoint with isolated home, cache, workspace, and `PI_CODING_AGENT_DIR` paths, so verification does not depend on a globally installed Pi. Pi itself is not bundled in the tarball and is not a runtime dependency of `jorgex-pi`.

Tests use isolated temporary homes and fake executable Engram paths. They verify discovery, argv, environment filtering, adapter metadata, direct-tool projection, lifecycle recovery, JSON protocol, and tarball bindings without starting a real Engram process or reading a real Engram database.

### Refresh and verify the canonical snapshot

Regenerate only from a local JorgeX Stack checkout that contains the pinned commit `5353c83c212a8603ab3e3bd5cac54dde4c75037c`:

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

Package metadata and contracts always carry the same version. After the selected version is present on npm, a standalone installation uses Pi's package manager with that release pinned explicitly:

```bash
pi install npm:jorgex-pi@<published-version>
```

That command is the narrow package-manager exception: Pi uses npm internally to register and resolve its own package. Repository development, dependency management, and release preparation continue to use pnpm exclusively.

Before merging anything that may publish, configure the npm trusted publisher in the npmjs.com package settings for GitHub repository `jorgehn98/jorgex-pi`, workflow filename `publish.yml`, and allowed action `npm publish`. The workflow does not configure that npm trust relationship and is not sufficient without this external prerequisite. Release jobs use Node 24 and reject its bundled npm if it is older than 11.5.1.

A push to `main` starts the release workflow. If the version declared in `package.json` is absent from npm, it is published unchanged; this preserves a manual minor or major decision. If it already exists and the push changes packaged runtime content, the workflow selects the next free patch, updates `package.json` and the root contract together, verifies the resulting commit, publishes its exact `pnpm pack` tarball with npm provenance through OIDC, and creates the immutable `v<version>` tag. Tests, work state, release scripts, workflow-only changes and operational `AGENTS.md` edits do not create another patch once the declared version is published. `workflow_dispatch` can recover an unpublished version or missing tag only from a verified SHA belonging to `main`.

Publication does not update JorgeX Stack. The 24-hour npm maturity window applies only to real consumption by managed Stack installations: Pi development, sequential PRs, merges, publication, and validation of the future Stack adoption may proceed immediately after this package is published. A later Stack PR may adopt the exact artifact with its tarball URL, byte length, SHA-256, SHA-512, lifecycle evidence and rollback candidate; an earlier managed consumption requires Jorge's explicit exception. Until that adoption PR is merged, managed installations continue using the previous frozen Pi version.

### Recent Stack content adopted in 0.4.0

- Stack PR #59 updated the shared `xreview` work-context policy and the affected canonical agents, including `orchestrator` and `xreview`.
- Stack PR #62 hardened `lean-code`; this release regenerates that skill and bundles Stack's shared policy projection, including the canonical `/lean-audit` command.

These changes are represented by parity v2 and the pinned Stack commit above; they do not imply that the future managed Stack adoption PR has already been created or merged.

## Paths, state, and ownership

Pi may relocate its agent directory through `PI_CODING_AGENT_DIR`; the package relies on Pi and its companions to resolve that location rather than assuming a fixed user path.

The ownership boundary is `contract/assets.v1.json`. Package-owned external writes are limited to the Sol lifecycle fields in `PI_CODING_AGENT_DIR/settings.json`, `PI_CODING_AGENT_DIR/models.json`, and the receipt at `PI_CODING_AGENT_DIR/jorgex-pi/sol-lifecycle.v1.json`. Permission-system, ask, Web Access, Goal, and MCP adapter state is companion- or user-owned: the bootstrap does not seed, replace, or remove it. The manifest records fourteen `preservedExternalState` paths that must survive JorgeX install, reinstall, and removal:

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
- `pi-mcp-adapter`: `PI_CODING_AGENT_DIR/mcp-cache.json`

The XDG and HOME ask paths may resolve to the same file; lifecycle consumers preserve both declarations and deduplicate resolved paths. These paths may be created or managed by their named companions during normal operation; declaring them preserved does not transfer their ownership to JorgeX.

## Supply chain and security

`contract/components.v1.json` distinguishes the six active companions from the audited future roadmap. Runtime and bundled dependencies are exact pins, the lockfile records audited npm `sha512` integrity values, and installation performs no live GitHub download. Goal's bundled closure resolves `@narumitw/pi-tui-kit` to the audited lock version alongside its exact transitive packages. The tarball carries the complete companion closure and reviewed native bindings for the tested offline Pi lifecycle.

The repository contains no keys, tokens, credentials, or secret placeholders. The isolated local Engram bridge and JSON runner exclude browser credentials, HTTP MCP, passive capture, and project bootstrap. The TUI branding remains in-memory and session-local: it has no settings-write, shell, network, or direct stdout surface, and its finite timer is owned and cancelled by the header lifecycle. The package does not install, update, remove, or test against the user's real Engram binary or memory database, and it does not impose permission, Goal, or MCP configuration outside the isolated internal adapter.
