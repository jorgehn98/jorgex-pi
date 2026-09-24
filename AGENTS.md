# JorgeX Pi

Paquete Pi-native del harness JorgeX. Este archivo define la relación operativa con JorgeX Stack y las comprobaciones mínimas antes de cambiar o publicar el paquete.

## Relación con JorgeX Stack

`jorgex-pi` se puede instalar directamente mediante el gestor de paquetes de Pi, pero su canal gestionado es JorgeX Stack. `package.json` es la autoridad de versión y `contract/parity.v2.json`, mediante `source.commit`, identifica el origen de la snapshot compartida. Los repos tienen responsabilidades distintas:

- **JorgeX Stack** es la fuente canónica de agentes, skills, system prompt y políticas compartidas, además del fleet manager que instala y verifica Pi.
- **JorgeX Pi** posee la traducción Pi-native, el bootstrap, contratos, companions, assets, runner JSON y lifecycle del paquete.
- El contenido compartido no se mantiene a mano en ambos sitios: `contract/parity.v2.json` fija el commit canónico de Stack y los generadores producen la snapshot, el fallback de política, los módulos de system prompt y la proyección Pi de `/lean-audit`.

Todo cambio debe incluir una revisión explícita de impacto cruzado:

- Si cambian agentes, skills, system prompt, permisos, Engram, browser routing o modelos, comprobar primero si la fuente debe cambiar en Stack y después regenerar/verificar la paridad en Pi.
- Si cambian versión, runner, contratos, capacidades, assets, dependencias, ownership, instalación, actualización, doctor o cleanup de Pi, comprobar si Stack debe actualizar su candidato congelado, fixtures, tests y `docs/references/pi-runtime.md`.
- Un cambio sin impacto en el otro repo debe dejar esa conclusión anotada en el PR; no se asume automáticamente que los repos son independientes.

`contract/runtime-agents.v1.json` identifica `pi-subagents` por nombre para la resolución runtime. Los campos `version` e `integrity` de los cinco nombres activos en `contract/components.v1.json` son una auditoría histórica del BUILD CI con lockfile congelado; no describen la versión npm instalada ni son un gate para la siguiente versión. Stack publicado resuelve dinámicamente Pi y verifica el árbol npm instalado en su canal gestionado.

### Diagnóstico local de capabilities

Mantener la proyección de `contract/schemas/quality-capabilities.v1.schema.json` registrada en `contract/parity.v2.json` bajo `qualityCapabilities`. El evento nativo `jorgex:quality-capabilities`, sus estados diagnósticos y la separación de receipts se describen en README, sección «Local quality-capability diagnostics»; no ampliar esa declaración a certificación de enforcement ni a un nuevo lifecycle del runner. En cambios coordinados, regenerar y re-pin al commit mergeado de Stack antes de publicar Pi.

## Canales de instalación y releases coordinadas

La instalación directa y la gestionada no son el mismo canal:

- **Directa:** ejecutar primero `engram setup pi` para instalar y registrar los paquetes oficiales externos; después instalar con `pi install npm:jorgex-pi` (o añadir una versión publicada explícita si se necesita seleccionar el paquete padre). Las seis dependencias runtime se resuelven desde npm durante la instalación y no forman un cierre bundled dentro del paquete. La instalación directa modifica el árbol npm activo in-place y no ofrece rollback transaccional de preactivación; `pi update` comprueba el paquete padre, pero no refresca dependencias cuando solo cambia una dependencia. Pi falla cerrado si el setup falta, está duplicado, malformado, ilegible o en conflicto, y no instala ni repara esos paquetes.
- **Gestionada:** Stack publicado resuelve deliberadamente el release estable de Pi, verifica su tarball y árbol/receipt antes de activarlo; `sync` y `doctor` comprueban el receipt offline sin resolver ni descargar. Publicar Pi no actualiza implícitamente una instalación Stack.

La versión declarada en `package.json` y la snapshot de Stack identificada por `contract/parity.v2.json` son autoridades independientes. La publicación de Pi y su uso por Stack son pasos separados: comprueba disponibilidad, contrato e integridad del release observado en npm antes de instalar; `src/lib/pi-runtime-pin.json` en Stack conserva referencias históricas y `src/lib/pi-runtime.ts` conserva el lifecycle. No deduzcas un nuevo par publicado de esta documentación.

Publicar Pi no actualiza automáticamente una instalación personal de JorgeX Stack. Para usar una capability nueva:

1. Fusionar, verificar y publicar la versión de `jorgex-pi`.
2. Completar y revisar el consumidor Stack compatible; la publicación Pi por sí sola no habilita un nuevo handoff.
3. Durante un `install`/`update` deliberado, Stack resuelve el release publicado, comprueba URL, tamaño, integridad, contrato y compatibilidad de la capability antes de activar el candidato exacto.
4. Conservar el receipt y estado anteriores cuando falle la validación o la proyección; nunca editar pines/fixtures históricos para simular adopción.

Con la App configurada y `JORGEX_AUTOMATION_ENABLED=true`, el coordinador de Stack solo propone la snapshot Pi del canon: no adopta automáticamente una release Pi publicada. Stack resuelve la versión oficial en cada instalación/actualización deliberada y verifica su artefacto antes de activar. Consultar el [runbook Stack ↔ Pi](https://github.com/jorgehn98/jorgex-stack/blob/main/docs/references/stack-pi-automation.md) y comprobar runs/PRs existentes antes de una propuesta manual. Sin opt-in, ante incompatibilidad o fallo explícito, recurrir a una PR manual con review y gates; si falta el artefacto publicado, persiste la dependencia externa. No editar pines ni hashes por rutina ni forzar fixtures: los cambios semánticos requieren revisión. El merge siempre exige orden de Jorge; la automatización no hace auto-merge ni instalaciones personales.

La instalación gestionada de una capability nueva requiere publicación Pi y un consumidor Stack compatible; la instalación directa usa un canal separado y resuelve sus dependencias desde npm en ese momento, sin la integridad de artefacto, staging ni rollback de Stack.

La verificación local de Stack compara los bytes descargados con tamaño e integridad **observados del proveedor** para el candidato resuelto. Es una comprobación local, no una raíz de confianza independiente: la attestation/provenance externa de npm queda fuera del runtime, y `provenance.commit` es informativo salvo verificación explícita de esa attestation.

El canal gestionado de Stack resuelve el `dist-tags.latest` publicado durante una instalación/actualización deliberada, pero instala el candidato **exacto verificado**, nunca el alias flotante, un checkout vivo o bytes sin integridad. El canal directo admite `pi install npm:jorgex-pi` sin selector y puede necesitar red para resolver Pi y sus dependencias; esa instalación no tiene las garantías de integridad, staging ni rollback de Stack.

Para una transición entre receipts, usa la versión de Stack que reconoce el receipt presente y no edites receipts, hashes ni estado manualmente. El receipt vigente y el candidato futuro se documentan en el checkpoint de adopción de Stack, no se anticipan aquí con comandos inventados.

```bash
# Ejemplo histórico de la transición 0.7.0 → 0.8.0; no describe el candidato F1 actual.
# Receipt Pi 0.7.0 → 0.8.0
pnpm dlx jorgex-stack@1.9.0 uninstall --agents pi
pnpm dlx jorgex-stack@1.9.2 install --agents pi

# Rollback desde receipt Pi 0.8.0 → 0.7.0
pnpm dlx jorgex-stack@1.9.2 uninstall --agents pi
pnpm dlx jorgex-stack@1.9.0 install --agents pi
```

La procedencia de la snapshot se consulta en `contract/parity.v2.json`; no repetir aquí SHA. El contrato v2 registra `assets/system-prompt/AGENTS.md`, `assets/system-prompt/context7.md`, los módulos de browser y `prompts/lean-audit.md`; no proyecta un protocolo Engram de JorgeX. `modular-system-prompts-v1` declara la recomposición marker-aware: Web Access se incluye cuando el bootstrap está sano y no hay conflicto; Context7 se registra en `session_start` mediante el event bus del `pi-mcp-adapter` externo; Playwright solo cuando su handoff resuelve `ready`; DevTools solo cuando el handoff estricto se registra por ese mismo bus. Playwright exige semver estable exacto y que el ejecutable absoluto devuelva esa versión con `--version`. DevTools conserva v1 histórico con `dlx` y semver exacto, y admite v2 local con comando Node absoluto, entry JS regular y los cuatro flags de privacidad en orden. El archivo sigue siendo `PI_CODING_AGENT_DIR/jorgex-pi/devtools.v1.json`; Pi valida forma/rutas/flags pero no descarga, verifica checksum ni autentica el launcher, que pertenecen al lifecycle Stack. Context7 y DevTools usan el gateway externo; JorgeX no incluye un adapter bundled, no usa `MCP_DIRECT_TOOLS` y no promete handshake ni readiness operativa. Durante la migración, Pi solo reconoce y elimina bloques heredados marcados `jorgex:engram-protocol`; no los usa como asset activo.
El comando Node del handoff v2 debe resolver al mismo ejecutable que usa el proceso Pi; si cambia el Node de Pi, Stack ha de re-verificar y proyectar el handoff antes de volver a activarlo.

### F1 Pi: acceso privado sin adopción implícita

La proyección generada conserva `inheritSkills: false` para cada agente. El generador `scripts/generate-runtime-agents.mjs` selecciona metadata y rutas privadas por rol para los 12 workers no-Engram; `engram` conserva su prompt de rol, sin selección de skills y sin declarar herramientas: prompt, tools, captura y hooks los aporta `gentle-engram` sin modificar. La ruta `../skills` permite resolver lo declarado sin activar las 17 skills globalmente; `codebase-analyst` conserva las skills backend `supabase` y `supabase-postgres-best-practices`. La snapshot coordinada contiene 17 árboles de skill y 89 archivos; la lista activa del paquete coincide con esa snapshot.

El seam verificable incluye el contrato público `resolveSubagentLaunchContract` de `pi-subagents`, observado como `0.54.0` en CI, usado por `tests/fixtures/discover-runtime-agents.mjs`, que comprueba selección, rutas, metadata y allowlist efectiva, y la prueba de proceso aislado `tests/subagent-engram-child.test.mjs`. Ese número es evidencia de CI, no el selector de una instalación directa. El agente `engram` no declara extensión child-only ni selector de herramientas JorgeX: `gentle-engram` es el propietario oficial e inyecta el prompt, las tools, la captura y los hooks sin modificación por JorgeX. Conserva la guía de rol que le indica no usar shell y `maxSubagentDepth: 0` impide subdelegar, pero no existe un filtro JorgeX de tools Engram. Esto prueba que el child recibe el provider oficial sin duplicación, no la ejecución de un modelo, la lectura del cuerpo completo de una skill, una conversación LLM completa, una ACL universal ni la compatibilidad de todos los runtimes. La selección privada de skills de F1 no define los defaults de modelo, permisos, receipts, HOME ni configuración del usuario.

El trabajo cross-repo no se cierra tras fusionar Pi: debe completar los PRs secuenciales requeridos en Stack y verificar el resultado final. De forma simétrica, un cambio de Stack tampoco se da por cerrado si deja pendiente la PR de Pi necesaria para publicar o adoptar su proyección.

Esta consolidación convierte el análisis en una decisión explícita antes de delegar, documenta únicamente las necesidades concretas, hace observable el progreso mediante resultados verificables y check-ins acotados, exige preflight antes de efectos externos costosos, reutiliza la verificación cuando siguen coincidiendo comando, configuración, entorno, entradas y contratos, limita los reintentos y reevalúa causa, alcance, ownership y seam antes de una segunda reparación si persisten bloqueantes o regresiones; los cambios materiales requieren aprobación antes de continuar. Aplica review selectiva sólo cuando el riesgo no queda cubierto por verificaciones deterministas, resume cada checkpoint ready con cambios y evidencia, continúa después de ready sólo de forma segura y aprobada, y mantiene los prompts como política sin crear modos nuevos. Consulta la [skill canónica `orchestrator`](skills/orchestrator/SKILL.md).

## Desarrollo y verificación

- Usar pnpm para instalar, probar, construir y empaquetar. Las excepciones npm son el `npm publish` ejecutado por trusted publishing y el npm interno que Pi usa para resolver una instalación directa de `jorgex-pi`.
- Comandos base: `pnpm install --frozen-lockfile`, `pnpm test` y `pnpm pack`. `pnpm build` es alias de `pnpm test`; ejecutar una sola vez, no ambos.
- Compatibilidad observada: un smoke real y aislado pasó con Pi `0.87.1` y las dependencias runtime resueltas en esa instalación. Es evidencia de ese host, no una promesa para otras versiones ni para futuras versiones de Pi; no ampliar la compatibilidad sin una prueba real.
- `openai-codex/gpt-5.6-sol` es el primary gestionado. `contextWindow=872000` es metadata/política local solicitada: la aceptación real del backend en sesiones OAuth debe smoke-testearse. No documentar `1.05M` para OAuth ni confundir `openai-codex` con el proveedor API `openai`.
- No tocar configuraciones, estado o memoria Engram del usuario fuera del lifecycle declarado. Pi gestiona la pareja Sol ausente o parcialmente coincidente en `PI_CODING_AGENT_DIR/settings.json` (`defaultProvider=openai-codex`, `defaultModel=gpt-5.6-sol`), el override `PI_CODING_AGENT_DIR/models.json` (`providers.openai-codex.modelOverrides.gpt-5.6-sol.contextWindow=872000`) y su receipt `PI_CODING_AGENT_DIR/jorgex-pi/sol-lifecycle.v1.json`; una mitad extranjera bloquea la siembra de la otra. El primer `sync` también siembra, solo en campos ausentes, `theme=JorgeX`, `quietStartup=true` y `hideThinkingBlock=true` en `settings.json`, y registra esa propiedad por separado en `PI_CODING_AGENT_DIR/jorgex-pi/experience-lifecycle.v1.json`; los valores preexistentes, incluso si coinciden, no se reclaman. Esa visita inicial evita resembrar campos borrados posteriormente; los reemplazos del usuario liberan ownership y `cleanup` solo elimina valores exactos que sigan siendo receipt-owned. También puede sembrar `PI_CODING_AGENT_DIR/extensions/pi-permission-system/config.json` solo si el archivo está ausente, con su receipt independiente `PI_CODING_AGENT_DIR/jorgex-pi/permissions-lifecycle.v1.json`; el comando explícito `upgrade` (capability `permissions-upgrade-v1`, vía `sync/install --upgrade-permissions` de Stack) reemplaza además solo la copia gestionada receipt-owned que difiera del default, con backup previo. Los estados preexistentes, inválidos o editados por el usuario se preservan y no se fusionan ni reimponen (la edición libera ownership). La política usa publicación exclusiva y backups durante cleanup; no declara un lock compartido con la UI nativa de permisos. Las settings de proyecto prevalecen y `defaultThinkingLevel` permanece intacto. El read-modify-write de Sol usa locks de configuración compatibles con Pi. Los receipts registran ownership solo de valores creados por JorgeX y cleanup conserva reemplazos del usuario. El bridge acepta primero un `ENGRAM_BIN` absoluto explícito y, si falta, el receipt exacto que JorgeX Stack deja en `~/.jorgex-stack/pi-receipt.json`; no usa `PATH` ni convierte ese hand-off en ownership de Pi. Los límites de ownership viven en `contract/assets.v1.json`.
- Mantener sincronizados `package.json`, el contrato raíz, el runner, README y cualquier metadato de release.
- No añadir dependencias ni activar companions sin revisar la resolución npm, la integridad observada en el lockfile CI y el lifecycle real aislado. El lockfile no convierte el selector runtime `*` en un pin impuesto a las instalaciones directas.

## Git y publicación

- Los cambios de comportamiento van por rama/worktree y PR; nunca se empujan directamente a `main`.
- Antes de ready: tests focales, suite completa, pack real, diff final y revisión del SHA candidato.
- El merge requiere orden explícito de Jorge.
- Trusted publishing autoriza npm, pero no sustituye los triggers ni la política de versionado del workflow. Los pushes a `main` publican versiones ausentes o incrementan el patch para cambios publicables; minor y major siguen siendo decisiones manuales dentro del PR. El workflow crea el tag después de publicar. No crear tags ni publicar manualmente salvo recuperación expresamente autorizada.
