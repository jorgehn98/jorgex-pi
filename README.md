# JorgeX Pi

`jorgex-pi` is the single Pi-native package for the JorgeX harness. JorgeX Stack remains the fleet manager and canonical source of shared assets; this repository owns their reviewed Pi representation and lifecycle. `contract/parity.v2.json` records the canonical snapshot, with `source.commit` as its source authority.

The version in `package.json` is the release authority. Minor and major remain manual decisions; after merge, the automatic release workflow preserves and publishes an unpublished selection from `main`. Later publicable changes increment the patch automatically. The current line adds the portable `work-audit` PRE/POST gates, the native JorgeX theme with first-sync absent-only defaults and TUI-only startup branding, modular system-prompt assets, the `/lean-audit` prompt, and local quality-capability diagnostics while retaining the fail-closed bootstrap, JSON runner, external official Engram setup, and versioned Stack snapshot.

## Current boundary

| Area | Current state |
| --- | --- |
| Compatibility | The producer contract records Pi `0.84.2`, `0.85.1`, and `0.87.1` as observed test hosts; the real isolated smoke on `0.87.1` resolved the dependency set at installation time. These are host observations, not a package selector or a promise for other or future Pi versions. |
| Pi resources | Bootstrap and TUI branding extensions, 17 reviewed JorgeX skills, the canonical policy fallback, modular Context7 and browser prompt assets, and the `/lean-audit` prompt are active. Context7 is projected only after its isolated HTTP server is registered successfully. `sync` seeds the `JorgeX` theme only when its global setting is absent. |
| Canonical snapshot | 14 agents (one dormant primary and 13 subagents) and 17 complete skill trees (89 files), plus the quality receipt v1 and quality capabilities v1 schemas. See `contract/parity.v2.json` for the source commit and projection hashes. |
| Runtime agents | 13 runnable subagents, including the read-only Engram specialist, plus a dormant primary orchestrator. |
| Package assets | `contract/assets.v1.json` owns the packaged extensions, theme, runtime agents, snapshot, skills, and contracts; it declares the bounded Sol lifecycle writes and preserves companion-owned state paths. |
| Active companions | The package declares six runtime dependencies with the npm selector `*`: five Pi companions plus `strip-json-comments`. Pi resolves them from npm when the package is installed; the versions observed in the CI lockfile are reproducibility evidence for CI, not user-facing selectors or a bundled closure. Official `gentle-engram` and `pi-mcp-adapter` are installed externally and remain provider-managed. |
| Model policy | The managed primary is `openai-codex/gpt-5.6-sol`; Pi session thinking remains user/session policy. The local `contextWindow` request is `872000`. |

The active skill list contains 17 explicit package-local paths. Browser automation is a separate opt-in integration provided through the verified Playwright handoff and package-local fallback. Upstream companion skills and prompts are also left inactive. The parity v2 contract records agents, skills, the shared policy, the modular system-prompt projections, the portable command projection, the quality-capabilities projection, and deliberate exclusions in `contract/parity.v2.json`; it does not project a JorgeX Engram protocol.

### Direct package versus managed Stack

There are two intentionally distinct channels:

- **Direct package:** first run `engram setup pi` to install and register the official external packages, then install with `pi install npm:jorgex-pi` (or add an explicit published version when you need to select one). This channel may need network access to resolve the six runtime dependencies from npm at installation time; they are not bundled in the package. Installation changes Pi's active npm tree in place and has no preactivation transactional rollback. If setup is missing, duplicated, malformed, unreadable, or conflicting, Pi fails closed and reports the setup state; it does not install or repair the official packages. `pi update` checks the parent `jorgex-pi` package, but does not refresh dependencies when only a dependency version changes.
- **Managed Stack:** Stack keeps its current exact pin; PR02 will coordinate the dynamic dependency contract and verification later. That managed channel is not published or adopted yet; publishing this Pi package does not ship PR02 or update a Stack candidate.

La versión declarada en `package.json` y la snapshot de Stack identificada por `contract/parity.v2.json` son autoridades independientes. La publicación de Pi y su adopción por Stack son pasos separados: comprueba la disponibilidad de la versión en npm y el pin actual de `src/lib/pi-runtime.ts` en Stack antes de instalar; PR02 podrá cambiar ese contrato de dependencias, pero todavía no está publicado ni adoptado. No deduzcas un nuevo par publicado de esta documentación.

La adopción gestionada de cualquier nueva versión deberá fijar el artefacto exacto y verificar URL, tamaño, SHA-256, SHA-512, lifecycle y rollback cuando PR02 se publique. En este cambio no existe todavía consumo gestionado; Stack conserva su pin actual hasta entonces. La provenance/attestation externa de npm queda fuera de la verificación del runtime.

Para Stack, consulta siempre el paquete publicado actual sin reutilizar la caché de `dlx`: `pnpm --config.dlx-cache-max-age=0 dlx jorgex-stack@latest install --engram`. Esta caché es independiente de `minimumReleaseAge`; una versión explícita de Stack como `@1.9.30` no reutiliza la entrada de otra versión. Para Pi, el canal directo admite `npm:jorgex-pi` sin selector; usa una versión explícita solo si necesitas controlar la versión del paquete padre.

La coordinación downstream con Stack no está publicada en este cambio. No se debe presentar PR02, su artefacto ni su adopción como disponibles; la coordinación gestionada queda para ese PR posterior.

The direct package does not provide a bundled Engram or adapter fallback. Official setup remains external; Stack-owned markers remain authoritative when a future managed channel is available.

### Managed Sol model lifecycle

The package's managed primary is provider `openai-codex` with model `gpt-5.6-sol`. This is distinct from the API provider `openai`. `sync` fills only missing compatible values in the Pi agent directory (resolved by `PI_CODING_AGENT_DIR`, normally `~/.pi/agent`): it creates both primary fields when both are absent, completes a matching Sol half, and leaves a foreign provider/model pair untouched.

- `settings.json`: `defaultProvider: "openai-codex"` and `defaultModel: "gpt-5.6-sol"`.
- `models.json`: `providers.openai-codex.modelOverrides.gpt-5.6-sol.contextWindow: 872000`.

The `872000` value is a requested local metadata policy, not proof that the backend accepts that context size. In particular, OAuth-backed `openai-codex` sessions must be smoke-tested against the backend; this package does not claim OAuth support for `1.05M`, and it does not configure the separate `openai` API provider.

Pi owns the lifecycle receipt at `PI_CODING_AGENT_DIR/jorgex-pi/sol-lifecycle.v1.json`. It records the fields, containers, and files that this package created. Existing user values, foreign providers/models, and user replacements are preserved. The lifecycle acquires Pi-compatible configuration locks before its read-modify-write cycle and fails closed when another process holds them. `cleanup` removes only receipt-owned fields whose values are still exactly the managed values, then prunes only empty receipt-owned containers/files and removes an empty receipt. If a user changes a managed value, the package releases that field instead of deleting the replacement.

To override the primary, set the relevant values in Pi's `settings.json` or `models.json` before running `sync`, or edit a managed value afterwards. The lifecycle will preserve the existing or changed value and will not treat it as removable package state.

### Experience defaults

The first `sync` also initializes the missing global experience settings in `PI_CODING_AGENT_DIR/settings.json` (normally `~/.pi/agent/settings.json`): `theme: "JorgeX"`, `quietStartup: true`, and `hideThinkingBlock: true`. The lifecycle records these fields in the separate `PI_CODING_AGENT_DIR/jorgex-pi/experience-lifecycle.v1.json` receipt. Values that already exist, including values equal to these defaults, remain user-owned and are not claimed.

The receipt records the first visit even when every field already exists. Later `sync` runs therefore do not reseed a field that a user deletes. If a user changes a package-owned value, that field is released; `cleanup` removes only fields still owned by the receipt and still equal to the managed value. Project settings continue to take precedence over global experience defaults, and `defaultThinkingLevel` is left unchanged.

Stack runs this `sync` before starting Pi. A direct package installation must run `node ./bin/jorgex-pi.mjs sync --json` before the next Pi start to apply the defaults; an already-running native session is not changed retroactively. The custom JorgeX header remains available alongside Pi's native settings, including `/jorgex:header builtin`, `/jorgex:header custom`, `JORGEX_PI_MOTION=reduce`, `NO_COLOR`, and `Ctrl+O`.

`contract/jorgex-pi.v1.json` advertises the active versioned capabilities, including `modular-system-prompts-v1`, `engram-official-bridge-v1`, `engram-runtime-tools-v1`, `runner-json-v1`, `tui-branding-v1`, and `managed-primary-model-v1`, and links the runtime-agent and runner contracts. The runtime contract records the translation from the 14 canonical agents. All 13 subagents live in `agents/`; `primary/orchestrator.md` is packaged but not activated as a subagent. The runtime-agent contract preserves each JorgeX tier without imposing model, provider, thinking, or fallback choices on subagent routing; the managed primary is documented separately above.

### Initialization diagnostics

The JSON runner exposes the first-initialization boundary through the `experience` and `permissions` status objects. The experience state is one of `pending`, `initialized`, `invalid`, or `unreadable`; `pending` means that the versioned experience receipt is absent, while `invalid` and `unreadable` retain the receipt path and a diagnostic code/reason. Permissions also reports `initialized: false` until its lifecycle receipt has been recorded. These diagnostics do not expose configuration contents or credentials.

Pending is blocking only for an exact registered `jorgex-pi` package: registered `pending` state makes `status` unhealthy, and each pending component marks its corresponding check as an error in `doctor`; when both components are pending, both checks fail. An unregistered package may still show informative pending state, but `status` does not become unhealthy for that reason alone. `doctor` therefore has five checks, in order: `package`, `engram`, `context7`, `permissions`, and `experience`. The Context7 check remains local; `available` does not imply a remote HTTP handshake, and Engram `ready` does not imply a health check against the database.

For registered pending state, run `node ./bin/jorgex-pi.mjs sync --json` and retry. `sync` is the initialization remedy: it records the lifecycle receipts and seeds only missing experience fields or an absent permission configuration, according to the ownership rules above. It does not auto-repair invalid or unreadable receipts. For those states, preserve the receipt at the reported `receiptPath`, correct it manually, and retry. `status` and `doctor` are read-only: repeated diagnosis does not lock, write, delete, repair, or reseed state. After initialization, changing or deleting a default is not reported as drift and does not cause a later `sync` to reseed it.

This capability is advertised as `initialization-diagnostics-v1`. It documents the Pi-side behavior delivered in Pi issue #56. JorgeX Stack issue #149 is already fixed separately; the current Stack installation must still adopt the exact published Pi artifact in the subsequent Stack change before managed Stack use can rely on this capability. This README does not assign or predict a future package version.

### F1 Pi: selección privada y límites de adopción

La proyección Pi de F1 conserva los 14 agentes canónicos: 12 workers reciben sólo la selección privada de skills necesaria para su rol, mientras `engram` conserva su prompt de rol sin selección de skills y sin declarar herramientas: prompt, tools, captura y hooks los aporta `gentle-engram` sin modificar. Cada agente generado fija `inheritSkills: false`; la ruta local `../skills` hace legible la selección declarada sin precargar el catálogo completo. El generador `scripts/generate-runtime-agents.mjs` es la autoridad de esta traducción y mantiene intactos los cuerpos canónicos, las herramientas, los tiers, la recursión y la extensión `git-read`; `codebase-analyst` conserva las skills backend `supabase` y `supabase-postgres-best-practices`.

Cada tarea formal de F1 mantiene una única Spec recuperable: una observación Engram o un Markdown canónico. Un mensaje inline sólo es un encargo auxiliar de su tarea padre; el resultado se registra aparte del origen de la Spec.

La comprobación usa el contrato público `resolveSubagentLaunchContract` de `pi-subagents`, observado como `0.54.0` en CI, en `tests/fixtures/discover-runtime-agents.mjs`. Ese número es evidencia de CI, no el selector de una instalación directa. El seam permite comprobar la metadata de selección, las rutas/skills resueltas y la allowlist efectiva; no demuestra que un modelo ejecute una skill, que lea el cuerpo completo, que exista una ACL universal ni que todos los runtimes compartan el mismo contrato. El agente `engram` no declara herramientas JorgeX ni `MCP_DIRECT_TOOLS`: prompt, tools, captura y hooks los aporta el `gentle-engram` oficial sin modificar. Esta prueba demuestra que el child recibe el provider oficial intacto, no una conversación LLM completa ni una adopción gestionada de Engram.

La selección privada de skills de F1 no cambia los modelos de Pi ni el Goal nativo. `openai-codex/gpt-5.6-sol` y `contextWindow=872000` siguen siendo la política/metadata local descrita arriba; esa selección tampoco altera permisos, receipts, HOME ni configuración de usuario.

## TUI branding

The package supplies a responsive JorgeX header for interactive Pi sessions only. Its eye mark is a terminal-safe Braille rendering derived from the canonical packaged SVG: narrow terminals keep a compact mark, medium terminals stack the identity and metadata, and wide terminals compose the detailed eye at the left with the `JorgeX Pi` wordmark at the right. The displayed Pi version, package version, runnable-agent count, packaged-skill count, and workspace basename come from their runtime manifests or session context rather than duplicated literals.

The entrance is a single 800 ms reveal with deterministic timer cleanup; `JORGEX_PI_MOTION=reduce`, CI, `TERM=dumb`, and non-TTY output use the final static frame. It never clears stdout. The header is reversible for the current session with `/jorgex:header builtin` and can be restored with `/jorgex:header custom`; non-TUI modes are unchanged. The package also declares the native `JorgeX` Pi theme. A fresh lifecycle `sync` fills it only when the global value is absent; Pi's normal theme controls and later user changes take precedence. [`DESIGN.md`](./DESIGN.md) is the terminal-specific design authority and keeps its palette in tested parity with the theme.

The Pi projection preserves the canonical bash boundary per agent. `none` exposes no shell capability; `git-read` replaces bash with the child-only `git_read` tool, which executes only `git diff` and `git log` through validated argv without a shell; `full` exposes bash and remains governed by the user's permission policy. This dedicated tool avoids relying on `permission.bash`, which the `pi-subagents` API observed as `0.54.0` in CI does not support; that observed version is not a direct-install selector.

### Pi permission policy

The `@gotgenes/pi-permission-system` companion observed as `27.0.0` in the CI lockfile evaluates the native Pi permission surfaces; `27.0.0` is not the selector used by a direct install. JorgeX's generated policy (`assets/permissions/defaults.json`) carries no global `"*"` fallback: ordinary workspace reads, writes, edits, search, listing, shell use, skills, subagents, Web Access, and every MCP server (`mcp: "allow"`, no allowlist) are allowed, and ordinary Git work including commit and push is allowed. Only `git rebase` / `git reset --hard` and remote-copy tools (`ssh`, `scp`, `sftp`, `rsync`) require `ask`. Destructive system operations (`format`, `mkfs`, `dd`, `shred`) are denied, and sensitive paths such as `.env`, SSH and AWS credential files, `.npmrc`, Git credentials, private-key filenames, and `*.pem`/`*.key` are denied. A path rule is transversal, so a stricter path result takes precedence over a tool-level allow. Known limit: the transversal `path` gate also covers direct shell paths (e.g. `cat .env` via `bash` is denied), unlike Stack where `bash` has no secret denies — the residual is obfuscated or indirect exfiltration (glob expansion, encoding, copy-then-read), not direct paths. The policy is a permission default, not an OS security boundary.

The policy keeps the three Pi agent boundaries: `none` has no shell, `git-read` has only the validated shell-free `git_read` extension, and `full` has Bash subject to the native policy. `git_read` registers a public `registerToolAccessExtractor` only after `permissions:ready`; it checks every path-like argument with Pi's permission service and selects the most restrictive result. If the service or extractor is unavailable, the extension refuses to invoke Git. The wrapper disables Git signature verification and rejects output, external-path, shell, and other unsafe arguments before execution. Agent-specific and project-specific Pi policy can further narrow the result.

The JSON runner exposes this state through `status` and `doctor`; it reports whether the permission configuration is absent, managed, preexisting, invalid, or unreadable and gives a remediation for invalid state. `sync` seeds `PI_CODING_AGENT_DIR/extensions/pi-permission-system/config.json` only when that regular file is absent (and no lifecycle receipt exists). An empty, `{}`, malformed, foreign, or otherwise preexisting file is preserved by `sync` and is never merged or repaired. The explicit `upgrade` command (capability `permissions-upgrade-v1`, driven by Stack `sync/install --upgrade-permissions`) additionally replaces a receipt-owned managed copy that differs from the packaged default — with a prior byte-exact backup — and seeds when absent; a preexisting, foreign, invalid, or user-edited file is preserved (a user edit releases ownership) and never merged. Initialization and ownership are recorded separately in `PI_CODING_AGENT_DIR/jorgex-pi/permissions-lifecycle.v1.json`; a later user edit or deletion releases ownership and prevents reseeding while the receipt remains. On contention (exit 1 with `CONFIG_LOCKED`), Stack retries the `upgrade` order up to two times, then fails visibly; no other signal is retried. After ownership is released (user edit or missing owned file, without reseeding), the next `upgrade` is a no-op (`changed: false` with no actions).

The permission lifecycle does not claim a shared lock with Pi's native permission UI. It publishes a fresh policy with an exclusive filesystem operation and, during cleanup, moves only an exact package-owned copy into `PI_CODING_AGENT_DIR/jorgex-pi/permissions-backups`. Hash mismatches, replacements, companion files, and user configuration are preserved. The lifecycle is ownership-safe, but it is not a universal ACL for arbitrary processes or an operating-system security boundary.

## Bootstrap and safety boundary

`extensions/bootstrap.ts` is the security-focused root extension. Pi's resource loader discovers and initializes it before runtime actions are bound, but that loading phase only registers handlers and companion tools; calls that require runner actions, including changes to the active tool set, occur only after `bindCore` and the corresponding lifecycle event. The bootstrap loads permission, ask, subagents, Web Access, and—only after its preflight succeeds—Goal in that order, dynamically capturing the tools registered by Web Access and Goal. A bootstrap guard is registered before companion loading and blocks all tool calls with termination until the current session emits `permissions:ready` and has a keyed permissions service. Load or factory failures retain that fail-closed guard, keep partial companion tools hidden, and surface a diagnostic identifying the phase, companion, and original cause at the next session start.

`extensions/branding.ts` is a separate, independent root extension. It only replaces the interactive TUI header in memory and does not select themes, write settings, load companions, or modify the bootstrap health boundary.

Health is session-scoped and cleared on session start or shutdown. A normal session start does not mutate Pi's current tool selection: the guard supplies the pre-health boundary. If a prompt starts before health, the bootstrap records the selected companion tools and hides them. Once health arrives, it reconciles that snapshot against the current active tools and never adds a missing tool, so a selection disabled during the wait cannot be revived from stale state. If health arrives before the first prompt, the current selection remains untouched. Later ready events also never re-enable disabled tools. In headless sessions, `ask_user_question` stays unavailable instead of fabricating an answer; subagent delegation remains available after permission health.

The bootstrap reads Pi settings to validate the external official setup and prevent duplicate or conflicting package registrations. It checks global `PI_CODING_AGENT_DIR/settings.json` (default `~/.pi/agent/settings.json`) and project `.pi/settings.json` for pinned or unpinned npm entries, including object entries with `source`. Each detector latches until Pi reloads and reports its own issue only after a UI notification is actually delivered. Detection never rewrites settings and does not install, update, or remove provider-owned packages.

This atomic safety guarantee applies to the tool-call flow. A healthy Goal companion is additionally gated at its command, managed-run start, prompt, settled-continuation, and message-delivery boundaries so it cannot start provider work before permission health. A valid managed-run request rejected by that gate receives the upstream-compatible terminal `ACTIVATION_FAILED` error instead of disappearing silently. Other companion slash commands and the event/RPC bridges registered internally by `pi-subagents` retain their upstream lifecycle and error handling; this package does not claim to guard those surfaces.

## Local quality-capability diagnostics

Pi emits the `jorgex:quality-capabilities` event from `extensions/bootstrap.ts` at `session_start` and again when the session observes `permissions:ready`; `session_shutdown` invalidates the report by emitting every capability as `unavailable`. The report is derived from the diagnostic flags `bootstrapReady`, `policyPresent`, and `permissionReady`. It uses namespace `jorgex.quality.capabilities`, version `1`, runtime `pi`, and exactly three capability entries:

| Capability | Pi local state | Meaning |
| --- | --- | --- |
| `policy-guidance` | `prompt-only` | The bundled policy is present while bootstrap is healthy and is available as guidance; this does not prove runtime enforcement. Evidence is `assets/system-prompt/AGENTS.md`, version `1`. |
| `tool-approval` | `manual` | Bootstrap is healthy and the Pi permission service is ready, but approval remains a manual runtime action. Evidence is `contract/jorgex-pi.v1.json`, version `1`. |
| `external-verification` | `unavailable` | External quality verification is owned by JorgeX Stack and is not available in Pi. |

Pi's report is local diagnostics, not certification of what the runtime actually enforces. The common vocabulary includes `enforced`, but a local report can emit only `prompt-only`, `manual`, or `unavailable`; a failed bootstrap leaves all three capabilities `unavailable`. `evidence.version` identifies the reviewed declaration or contract version, not a Pi, companion, runtime, or compatibility version. The report contains no raw configuration or secrets.

The canonical schema is `stack/contracts/quality-capabilities.v1.schema.json` in Stack and its generated Pi projection is `contract/schemas/quality-capabilities.v1.schema.json`. `contract/parity.v2.json` records the `qualityCapabilities` projection with its namespace, version, source/target paths, and source/output SHA-256 digests. Pi emits this native event from its own bootstrap; it is not another Stack adapter and it does not produce `jorgex.quality.receipt`.

Event emission is best-effort and cannot change the bootstrap safety boundary. The report is not persisted as a receipt and does not change ownership or cleanup. Keep these artifacts separate: `~/.jorgex-stack/pi-receipt.json` (managed package hand-off), `~/.jorgex-stack/pi-projection-receipt.json` (shared projection), `PI_CODING_AGENT_DIR/jorgex-pi/sol-lifecycle.v1.json` (Pi primary lifecycle), and `jorgex.quality.receipt` (quality evidence). The JSON runner commands and lifecycle remain unchanged.

## MCP and Engram

Before a direct Pi installation, run `engram setup pi`. `gentle-engram` owns the native Engram memory tools, and the single external `pi-mcp-adapter` owns the gateway. JorgeX does not bundle either package, invoke setup, load ambient MCP configuration, or manage their versions; provider-managed versions are observed rather than pinned here.

Context7 uses the canonical endpoint `https://mcp.context7.com/mcp`. `CONTEXT7_API_KEY` is optional: when present, the bridge passes a runtime environment reference, and when absent it sends no credential header. Pi inspects a bounded set of shared, agent, project, and explicit MCP configuration files before registration. A homonymous `context7` server, unreadable or unverified discovery configuration, or invalid JSON preserves the user's files and blocks registration. The bridge never displays or stores a real key, imports foreign servers, or writes an MCP receipt.

The runner's `status` and `doctor` commands report whether Context7 configuration permits registration; `available` does not mean that an HTTP handshake has occurred. `sync` fails closed on a Context7 conflict and does not modify MCP configuration. At `session_start`, JorgeX registers Context7 and strict DevTools through the external adapter's runtime event bus; it does not create a bundled adapter or fallback factory. Missing, duplicate, malformed, unreadable, or conflicting official setup fails closed with a remediation to run `engram setup pi` and correct the external configuration.

When a compatible Stack projection provides `PI_CODING_AGENT_DIR/jorgex-pi/devtools.v1.json`, the bridge validates that optional handoff and registers strict DevTools through the external adapter. The handoff must contain only `schemaVersion: 1`, `enabled: true`, an absolute executable command, and `dlx chrome-devtools-mcp@<exact-stable-version> --isolated --redact-network-headers --no-performance-crux --no-usage-statistics`. Pi accepts only an exact stable semver in the package argument, reads the handoff at bootstrap, and never edits it; Stack owns its lifecycle. This Pi consumer validates the handoff shape, executable path, version form, and privacy flags; it does not download, checksum, or authenticate the DevTools binary. DevTools is advertised only when that managed handoff is valid and the external adapter accepts the registration. The registration is lazy/proxy (`directTools: false`); `MCP_DIRECT_TOOLS` is not used. Changing or removing the handoff requires reloading Pi because registration is created once per session.

The official setup owns the Engram binary, database, and memories. Pi only validates the external configuration needed for the session and never installs, updates, removes, or takes ownership of that state. Child environment handling is provider/runtime-owned; JorgeX defines no environment allowlist. Provider-managed `gentle-engram` hooks may automatically persist session, prompt, and compaction context; JorgeX does not own or configure those hooks.

The `engram` child declares no JorgeX tool selector: its contract omits the tools field and declares no child-only extension, and it sets no `MCP_DIRECT_TOOLS`. Official `gentle-engram` owns and injects the prompt, tools, capture, and hooks unchanged; JorgeX neither filters Engram tools nor configures provider hooks. Pi only recognizes and removes legacy `jorgex:engram-protocol` marker blocks during migration cleanup; it never injects that retired protocol or treats it as an active asset. The role prompt still tells the agent not to use shell, while `maxSubagentDepth: 0` prevents subdelegation; the shell guidance is behavioral, not a custom tool filter.

The current host evidence is a real isolated smoke on Pi `0.87.1` with the latest dependency resolution available during that installation. It does not establish compatibility for any other or future Pi version, and provider-managed package versions do not extend that evidence.

## Goal continuation and orchestrator policy

In the managed configuration, the `@narumitw/pi-goal` companion resolved for that installation is the sole producer of automatic continuation; `0.53.0` is the version observed in the CI lockfile, not a direct-install pin. It owns `/goal`, the `goal_complete`, `goal_blocked`, and `goal_wait` tools, session persistence, settled-idle continuation, and its disabled-by-default managed-run RPC channel. JorgeX does not add a second loop, queue, command, or RPC producer. The orchestrator skill remains policy: it governs phases, delegation, the durable `work/{name}/plan.md` board, verification, and delivery, while Goal only keeps the active objective moving between settled turns.

An absent `PI_CODING_AGENT_DIR/pi-goal.json` uses the upstream defaults without creating a file: Goal tools appear after the first accepted goal, RPC is off, automatic work pauses after 25 responses, and the no-progress guard pauses after three repeated runs. The former experimental queue is removed upstream. JorgeX neither seeds nor overrides these settings, including with unlimited values. An invalid or unreadable existing config latches Goal unhealthy for the loaded bootstrap and omits the package's resolved Goal companion; the rest of the foundation remains healthy. Correct the config and reload Pi explicitly to enable Goal.

Goal's active prompt is appended before JorgeX browser routing, so Goal supplies continuation state while the JorgeX guidance remains the final capability policy. If a direct npm Goal is detected, JorgeX does not load the package's separately resolved copy. The external Goal remains unmanaged and outside the Goal-specific safety bridge; remove it and reload Pi to return to the supported managed configuration. Current managed Goal state lives in Pi's session entries; the user-owned config and legacy `pi-goal-state.json` are preserved across JorgeX lifecycle operations.

## SDD change-first and selective clarification

The Pi snapshot carries the reviewed `work-audit` and `orchestrator` skills generated from the Stack commit pinned in `contract/parity.v2.json`, the authority for that source and projection. The packaged `primary/orchestrator.md` remains dormant as a subagent, while the projected skills provide the portable SDD policy.

Esta consolidación convierte el análisis en una decisión explícita antes de delegar, documenta únicamente las necesidades concretas, hace observable el progreso mediante resultados verificables y check-ins acotados, exige preflight antes de efectos externos costosos, reutiliza la verificación cuando siguen coincidiendo comando, configuración, entorno, entradas y contratos, limita los reintentos y reevalúa causa, alcance, ownership y seam antes de una segunda reparación si persisten bloqueantes o regresiones; los cambios materiales requieren aprobación antes de continuar. Aplica review selectiva sólo cuando el riesgo no queda cubierto por verificaciones deterministas, resume cada checkpoint ready con cambios y evidencia, continúa después de ready sólo de forma segura y aprobada, y mantiene los prompts como política sin crear modos nuevos. Consulta la [skill canónica `orchestrator`](skills/orchestrator/SKILL.md).

In PRE, `work-audit` reports a clarification gap only when there are plausible interpretations that materially change observable behavior, approved scope, an `SC-*` criterion, or the testing decision. Low-impact implementation preferences, defaults, wording, and paths are not blockers. The audit remains read-only, and the orchestrator remains the only writer of active work artifacts.

During EXECUTE and VERIFY, the orchestrator distinguishes a defect that restores the approved contract from an intentional material contract change. The latter stops implementation and returns to SPEC: update the PRD first, then the plan, tasks, `SC-*` criteria, and testing decisions; rerun PRE until `clean`, obtain human approval, and only then resume EXECUTE. A bugfix that restores the approved contract remains in EXECUTE. POST cannot legitimise an intentional scope change retroactively through code, tests, or evidence: it routes that case to SPEC/change-first, defects to EXECUTE, and other gaps to their owning phase.

## Web Access and browser routing

Web Access is the core route for web research, source verification, and static HTTP(S) retrieval, including remote PDF, GitHub, and YouTube content. The four default upstream tools are `web_search`, `source_check`, `fetch_content`, and `get_search_content`; custom upstream tool names are captured and health-gated at registration time. Retrieved content is untrusted data, not instructions.

The JorgeX wrapper gives `web_search` a safe workflow precedence: a valid per-call `workflow` wins, then a valid value from the user's read-only `web-search.json`, and otherwise `none`. Thus the browser curator does not open by default through the tool route. `summary-review` or `auto-summary` remains an explicit per-call or user-config choice. The wrapper never creates or repairs that configuration. Browser-cookie authentication and remote hosted fetch providers also retain the upstream opt-in defaults; JorgeX does not enable `allowBrowserCookies`, `authFetch`, or `fetchRouting.allowRemoteHostedProviders`.

`fetch_content` accepts only absolute remote HTTP(S) URLs through JorgeX. Local paths plus `file:`, `data:`, and other schemes are rejected before the upstream companion runs. A GitHub URL may cause the upstream package to clone into its configured temporary clone root (default `/tmp/pi-github-repos`), whose session cache the companion clears. PDF extraction may write generated Markdown under the OS temporary `pi-web-pdf` directory. Those temporary artifacts are upstream behavior, not JorgeX-managed external writes.

Playwright remains a separate opt-in route, used only when the task requires interactive browser UI, forms, dynamic DOM, screenshots, or tracing. Browser profiles, authenticated sessions, cookies, and stored browser state require explicit user approval; page DOM, downloads, and dialogs remain untrusted data.

When the Playwright handoff resolves as ready, the bootstrap adds a package-local fallback using the verified command path. The guidance tells the agent to consult `--help`, use its own task-specific session (`-s=<name>`), open Chromium with `--browser=chromium`, obtain refs with `snapshot`, verify action results, and close only the session it created. Pi does not perform browser launch readiness checks here.

The optional Stack handoff is `PI_CODING_AGENT_DIR/jorgex-pi/playwright.v1.json` (normally `~/.pi/agent/jorgex-pi/playwright.v1.json`). It is a strict, Stack-owned, read-only JSON contract with exactly these fields. “Stack-owned” describes the lifecycle and write ownership; the Pi resolver does not authenticate the file's provenance.

```json
{
  "schemaVersion": 1,
  "enabled": true,
  "version": "<exact-stable-version>",
  "command": "/absolute/path/to/playwright-cli"
}
```

Pi accepts the handoff only when `schemaVersion` is `1`, `enabled` is `true`, `version` is an exact stable semver, `command` is absolute and executable, and invoking that path with `--version` returns exactly the handoff version. The resolver does not search `PATH`, inspect browser profiles, open a user session, or test whether a live browser can launch. Stack owns installation of the global CLI and Chromium, including browser readiness checks; the Pi capability check validates only the executable handoff and does not download, checksum, or authenticate the CLI binary.

When the handoff is absent, malformed, or fails the version check, the capability stays hidden and the browser guidance is omitted. A manually written file that satisfies the same schema and executable/version checks is accepted; Pi does not authenticate its provenance. Once a valid handoff is present, Pi exposes the routing with the managed command path. The bootstrap resolves it in `before_agent_start` for each agent turn and does not rewrite it; changing or removing the file is re-evaluated on the next turn. The capability is advertised as `playwright-handoff-v1`; this resolver state does not certify live browser readiness. Its adoption is a separate Stack change and does not alter Pi's canonical snapshot or shared source commit.

`pi-web-access` also registers `/websearch`, `/curator`, `/google-account`, and `/search`. These slash commands are explicit user actions and do not pass through Pi's `tool_call` health guard. They retain the companion's own lifecycle, UI, configuration, and error handling; the fail-closed guarantee above applies to agent tool calls, not those commands.

## JSON runner

The package exposes the noninteractive `jorgex-pi` binary with the versioned contract in `contract/runner.v1.json` and response schema in `contract/schemas/runner-response.v1.schema.json`. During development, invoke it directly:

```bash
node ./bin/jorgex-pi.mjs status --json
node ./bin/jorgex-pi.mjs doctor --json
node ./bin/jorgex-pi.mjs models --json
node ./bin/jorgex-pi.mjs sync --json
node ./bin/jorgex-pi.mjs upgrade --json
node ./bin/jorgex-pi.mjs cleanup --json
```

`--json` is accepted after the command for Stack compatibility; stdout is one bounded JSON record with a trailing newline even when the flag is omitted. Exit codes are `0` for success, `1` for unhealthy state, `2` for invalid usage, and `3` for an internal failure. `status` reports exact-package registration plus user-owned Engram discovery. `doctor` requires both the exact package registration and an executable Engram binary. Invalid settings retain their path, reason, and remedy in the error envelope. `models` reports the managed `openai-codex/gpt-5.6-sol` primary and the requested local `872000` context window. `sync` and `cleanup` apply the ownership-safe lifecycle described above. `upgrade` applies the explicit permissions upgrade from the Pi permission policy section: it rewrites an absent or owned-stale config with a prior byte-exact backup, while existing, invalid, and concurrent user state is preserved. For diagnostics only, the runner checks `ENGRAM_BIN` first and otherwise searches `PATH`/`PATHEXT`; it never spawns Engram. This diagnostic fallback does not broaden the managed bridge's `ENGRAM_BIN`-only runtime contract.

## Development

pnpm 11 dependency resolution uses `minimumReleaseAge=1440` by default; the workspace config excludes only `jorgex-stack` and `jorgex-pi` through `minimumReleaseAgeExclude`, so their coordinated release consumption is immediate after verification. Keep the same package exclusions in the user-level config used by `pnpm dlx` from HOME and preserve unrelated settings; this does not configure other users.

Use pnpm for repository work:

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm pack
```

`pnpm test` is the build alias; execute it once rather than running `pnpm build` separately. `pnpm install --frozen-lockfile` provisions the repository's exact development dependency from the lockfile. The real isolated smoke passed with Pi `0.87.1` after resolving the latest runtime dependencies; it uses isolated home, cache, workspace, and `PI_CODING_AGENT_DIR` paths and does not use real models, auth, or HOME state. Pi itself is not bundled in the tarball and is not a runtime dependency of `jorgex-pi`.

Tests use isolated temporary homes and fake executable Engram paths. They verify discovery, argv, environment filtering, adapter metadata, direct-tool projection, lifecycle recovery, JSON protocol, and tarball bindings without starting a real Engram process or reading a real Engram database.

### Optional property-testing pilot

This repository contains an opt-in property-testing pilot for maintainers working from a checkout. It is not part of the installed package or the default CI path.

Run it with:

```bash
pnpm test:property
```

The pilot lives under `pilots/property`, uses the development-only `fast-check@4.9.0` dependency, and runs Node's test runner serially: `node --test --test-concurrency=1 pilots/property/*.test.mjs`. `pnpm test` remains the default suite and does not include this pilot. The paired Stack pilot covers TOML upsert idempotence and preservation; this Pi pilot covers positive Engram receipt resolution and contractual invalidators.

Runs use a reproducible budget of 100 cases with seed `20260831` and fast-check's default shrinking. To replay a failure, use the seed and path reported by `fc.assert` with a local temporary edit, then restore that edit; do not invent environment variables or CLI flags. The pilot documents reported and tested behavior only: it does not claim enforcement or operating-system security, and it defines no additional quality threshold.

### Optional native coverage pilot

This repository also contains an opt-in native Node coverage pilot for maintainers working from a checkout. It is not part of the installed package or the default CI path. Prepare and run it with the package manager pinned by `package.json`:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm test:coverage
```

`test:coverage` creates `coverage/` before invoking Node's built-in test runner serially with `--experimental-test-coverage` (experimental in Node 24). It runs `tests/bootstrap.test.mjs` and `tests/runner.test.mjs`, limits the coverage report to `bin/jorgex-pi.mjs`, `extensions/bootstrap.ts`, and `extensions/quality-capabilities.ts`, writes the `spec` report to stdout, and writes LCOV to `coverage/lcov.info`. The pilot was observed with Node `24.13.0`; it adds no production runtime or dependency. `coverage/lcov.info` is local-only: `/coverage/` is gitignored and `coverage` is excluded from the published package.

Before using any percentage, verify that `coverage/lcov.info` is non-empty, contains the three expected source paths, and maps them correctly. A missing source is incomplete coverage even when the command exits `0`. The experiment observed attribution for the runner's `spawnSync` path in this seam; it does not claim automatic coverage of every child process, VM, or TypeScript execution. This is an exploratory report only: it has no threshold or CI gate, and it does not change the JSON runner contract.

### Refresh and verify the canonical snapshot

Regenerate only from a local JorgeX Stack checkout containing the exact commit recorded in `contract/parity.v2.json` at `source.commit`. For coordinated changes, after Stack merges, regenerate and re-pin to the merged commit before publishing Pi:

```bash
JORGEX_STACK_DIR="/abs/path/to/JorgeX Stack" pnpm snapshot:generate
```

The generator reads raw Git objects at the exact SHA, ignoring replacement refs; it does not use live working-tree content or download upstream assets. It produces `snapshot/agents`, `skills`, `assets/system-prompt/AGENTS.md`, the Context7 and browser system-prompt modules, `prompts/lean-audit.md`, `contract/schemas/quality-receipt.v1.schema.json`, `contract/schemas/quality-capabilities.v1.schema.json`, and `contract/parity.v2.json` deterministically. Publication is transactional across those roots: existing roots are staged aside, every v2 root is published, and the legacy parity contract is removed; if any move fails, the previous generation is restored. The generated assets contain 14 agents and all 89 files from the 17 approved skill trees. The retired `engram-protocol.md` asset is not generated or packed.

Run the explicit cross-repository parity check against the same checkout:

```bash
JORGEX_STACK_DIR="/abs/path/to/JorgeX Stack" node --test tests/cross-repo/snapshot-parity.test.mjs
```

Skills are preserved byte-for-byte. Agent sources are normalized to LF for portable output, so `contract/parity.v2.json` records separate source and output SHA-256 hashes for agents; copied policy and modular prompt files and the translated prompt also record their source and output paths and hashes. A general `git diff --check` can therefore report the three reviewed trailing-whitespace occurrences inherited from the canonical skills; the v2 manifest is the parity authority.

Regenerate the Pi-native agent projection after refreshing the snapshot:

```bash
pnpm runtime-agents:generate
```

This publishes `agents`, `deferred/agents`, `primary`, and `contract/runtime-agents.v1.json` transactionally; a failure restores the previous generation. `pnpm test` verifies deterministic output, containment, the npm-resolved runtime dependency model, and the isolated Pi lifecycle. `pnpm pack` creates the candidate tarball with the bootstrap and resources; runtime dependencies are resolved by Pi from npm rather than copied into a bundled node_modules closure. Development generators and transaction modules under `scripts/` are excluded.

Package metadata and contracts always carry the same version. A standalone installation may use Pi's package manager without pinning the parent package:

```bash
pi install npm:jorgex-pi
```

That command is the narrow package-manager exception: Pi uses npm internally to register and resolve its own package. Repository development, dependency management, and release preparation continue to use pnpm exclusively.

Before merging anything that may publish, configure the npm trusted publisher in the npmjs.com package settings for GitHub repository `jorgehn98/jorgex-pi`, workflow filename `publish.yml`, and allowed action `npm publish`. The workflow does not configure that npm trust relationship and is not sufficient without this external prerequisite. Release jobs use Node 24 and reject its bundled npm if it is older than 11.5.1.

A push to `main` starts the release workflow. If the version declared in `package.json` is absent from npm, it is published unchanged; this preserves a manual minor or major decision. If it already exists and the push changes packaged runtime content, the workflow selects the next free patch, updates `package.json` and the root contract together, verifies the resulting commit, publishes its exact `pnpm pack` tarball with npm provenance through OIDC, and creates the immutable `v<version>` tag. Tests, work state, release scripts, workflow-only changes and operational `AGENTS.md` edits do not create another patch once the declared version is published. `workflow_dispatch` can recover an unpublished version or missing tag only from a verified SHA belonging to `main`.

Publication does not update JorgeX Stack automatically. Stack's managed installation consumes the exact candidate recorded in its runtime registry; adopting a future Pi release remains a separate coordinated change that verifies the published artifact's URL, byte length, SHA-256, SHA-512, lifecycle evidence and rollback candidate. Managed Stack installations may consume the package immediately after publication and verified adoption. Direct installation uses a separate npm-resolution channel and does not provide Stack's staging or rollback guarantees; use Stack when exact artifact integrity and managed recovery are required.

The following receipt transition is historical (`Stack 1.9.2` / Pi `0.8.0`). For any current transition, use the Stack version that recognizes the receipt currently present; do not edit receipts, hashes or manual state:

```bash
# Pi receipt 0.7.0 → 0.8.0
pnpm dlx jorgex-stack@1.9.0 uninstall --agents pi
pnpm dlx jorgex-stack@1.9.2 install --agents pi

# Roll back from Pi receipt 0.8.0 → 0.7.0
pnpm dlx jorgex-stack@1.9.2 uninstall --agents pi
pnpm dlx jorgex-stack@1.9.0 install --agents pi
```

### Mantenimiento: preparar la snapshot desde Stack

El helper [`scripts/prepare-stack-snapshot.mjs`](./scripts/prepare-stack-snapshot.mjs) usa una SHA completa, fusionada y que no sea un downgrade respecto de la snapshot actual, y prepara la proyección en un staging temporal propio. Requiere un checkout Pi limpio de trabajo (no `main`/`master`), también en **dry-run**, que es el modo por defecto: no modifica archivos tracked y sólo informa las rutas candidatas. Sustituye las dos cadenas del ejemplo por la ruta absoluta y la SHA verificadas:

```bash
node scripts/prepare-stack-snapshot.mjs --stack-dir "/ruta/absoluta/stack" --commit "SHA_COMPLETA_EN_MINUSCULAS"
```

Añade `--apply` sólo desde una rama o checkout de trabajo que no sea `main`/`master` y esté completamente limpio; el helper también rechaza `assume-unchanged` y `skip-worktree`, porque pueden ocultar ediciones locales. No modifica esos flags: usa un checkout de trabajo sin ellos. El helper no acepta cambios dirty ni crea commits, PRs, red ni automatizaciones. Tras aplicar y revisar la candidata, haz el commit antes de repetir la preparación. Un no-op de metadata no cambia la provenance. Si la generación o los fixtures son incompatibles, se detiene para revisión humana y deja la raíz intacta. Si falla el rollback transaccional, conserva el staging/backup de recuperación y no lo borra.

### Stack content represented in this package

- Stack PR #59 updated the shared `xreview` work-context policy and the affected canonical agents, including `orchestrator` and `xreview`.
- Stack PR #62 hardened `lean-code`; this release regenerates that skill and bundles Stack's shared policy projection, including the canonical `/lean-audit` command.
- Stack PR #66 introduced the versioned quality receipt schema projected at `contract/schemas/quality-receipt.v1.schema.json`; it remains package metadata and does not become Pi-managed user state.

These changes are represented by parity v2 and its `source.commit`; the managed Stack candidate remains an independent release concern and must be updated only through the exact-artifact adoption flow above.

## Paths, state, and ownership

Pi may relocate its agent directory through `PI_CODING_AGENT_DIR`; the package relies on Pi and its companions to resolve that location rather than assuming a fixed user path.

The ownership boundary is `contract/assets.v1.json`. Package-owned external writes include the Sol lifecycle fields in `PI_CODING_AGENT_DIR/settings.json`, `PI_CODING_AGENT_DIR/models.json`, and its receipt at `PI_CODING_AGENT_DIR/jorgex-pi/sol-lifecycle.v1.json`, plus the first-sync experience fields in `PI_CODING_AGENT_DIR/settings.json` and their separate receipt at `PI_CODING_AGENT_DIR/jorgex-pi/experience-lifecycle.v1.json`. Experience defaults are written only when their global fields are absent; existing values and project settings remain user-owned. JorgeX may also create the permission policy at `PI_CODING_AGENT_DIR/extensions/pi-permission-system/config.json` only when that file is absent; the explicit `upgrade` command may additionally replace a receipt-owned managed copy that differs from the packaged default, with a prior backup. Its ownership is recorded separately in `PI_CODING_AGENT_DIR/jorgex-pi/permissions-lifecycle.v1.json`. Cleanup removes only an exact policy still owned by that receipt, retains its backup, and preserves any user replacement. Official setup state is provider-owned: cleanup/uninstall preserve the official `gentle-engram` and `pi-mcp-adapter` packages, `PI_CODING_AGENT_DIR/mcp-cache.json`, the Engram binary, the Engram database, and memories. Permission companion logs and forwarding state, ask, Web Access, and Goal state are also never replaced or removed by the bootstrap. The manifest records the preserved companion paths that must survive JorgeX install, reinstall, and removal:

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
- official Engram setup: `PI_CODING_AGENT_DIR/mcp-cache.json`, official packages, and provider-owned Engram state

The XDG and HOME ask paths may resolve to the same file; lifecycle consumers preserve both declarations and deduplicate resolved paths. These paths may be created or managed by their named companions during normal operation; declaring them preserved does not transfer their ownership to JorgeX.

## Supply chain and security

`contract/components.v1.json` distinguishes the active companions from the audited future roadmap. Its `version` and `integrity` fields are a historical audit of the frozen CI build, not the npm versions installed by a user and not a gate for the next version. The six runtime dependencies in `package.json` use the npm selector `*`; the lockfile records the versions and npm `sha512` integrity values observed by CI, but it does not impose those versions on direct Pi installation. The published tarball does not carry a bundled companion closure: Pi resolves the runtime dependencies from npm during installation. Stack PR02 is expected to read installed runtime versions from npm state when that managed contract is implemented; PR02 is not shipped here. This package does not claim a no-network installation or a transitive closure independent of npm.

The repository contains no real keys, tokens, credentials, or user secrets. The external Engram and Context7 gateway plus JSON runner exclude browser credentials and project bootstrap. Provider-managed `gentle-engram` hooks may persist session, prompt, and compaction context; those hooks are outside JorgeX ownership and configuration. The TUI branding remains in-memory and session-local: it has no settings-write, shell, network, or direct stdout surface, and its finite timer is owned and cancelled by the header lifecycle. The package does not install, update, remove, or test against the user's real Engram binary or memory database. Official packages, MCP cache, binary, database, and memories remain provider-owned and survive cleanup/uninstall; other permission, Goal, and MCP state remains outside JorgeX ownership except for the explicitly declared permission policy lifecycle.
