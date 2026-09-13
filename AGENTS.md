# JorgeX Pi

Paquete Pi-native del harness JorgeX. Este archivo define la relación operativa con JorgeX Stack y las comprobaciones mínimas antes de cambiar o publicar el paquete.

## Relación con JorgeX Stack

`jorgex-pi` se puede instalar directamente mediante el gestor de paquetes de Pi, pero su canal gestionado es JorgeX Stack. `package.json` es la autoridad de versión y `contract/parity.v2.json`, mediante `source.commit`, identifica el origen de la snapshot compartida. Los repos tienen responsabilidades distintas:

- **JorgeX Stack** es la fuente canónica de agentes, skills, system prompt y políticas compartidas, además del fleet manager que instala y verifica Pi.
- **JorgeX Pi** posee la traducción Pi-native, el bootstrap, contratos, companions, assets, runner JSON y lifecycle del paquete.
- El contenido compartido no se mantiene a mano en ambos sitios: `contract/parity.v2.json` fija el commit canónico de Stack y los generadores producen la snapshot, los fallbacks de política/protocolo, los módulos de system prompt y la proyección Pi de `/lean-audit`.

Todo cambio debe incluir una revisión explícita de impacto cruzado:

- Si cambian agentes, skills, system prompt, permisos, Engram, browser routing o modelos, comprobar primero si la fuente debe cambiar en Stack y después regenerar/verificar la paridad en Pi.
- Si cambian versión, runner, contratos, capacidades, assets, dependencias, ownership, instalación, actualización, doctor o cleanup de Pi, comprobar si Stack debe actualizar su candidato congelado, fixtures, tests y `docs/references/pi-runtime.md`.
- Un cambio sin impacto en el otro repo debe dejar esa conclusión anotada en el PR; no se asume automáticamente que los repos son independientes.

### Diagnóstico local de capabilities

Mantener la proyección de `contract/schemas/quality-capabilities.v1.schema.json` registrada en `contract/parity.v2.json` bajo `qualityCapabilities`. El evento nativo `jorgex:quality-capabilities`, sus estados diagnósticos y la separación de receipts se describen en README, sección «Local quality-capability diagnostics»; no ampliar esa declaración a certificación de enforcement ni a un nuevo lifecycle del runner. En cambios coordinados, regenerar y re-pin al commit mergeado de Stack antes de publicar Pi.

## Canales de instalación y releases coordinadas

La instalación directa y la gestionada no son el mismo canal:

- **Directa:** después de publicar la versión seleccionada en `package.json`, instalarla explícitamente con `pi install npm:jorgex-pi@<published-version>`. La extensión aplica fallbacks marker-aware: añade solo las secciones ausentes, conserva el prompt del usuario y no duplica marcadores ya proyectados por Stack.
- **Gestionada:** Stack instala el candidato exacto que registra en su runtime, verifica su integridad, proyecta los recursos compartidos y filtra del registro del paquete las skills/prompts ya proyectados. Publicar una versión Pi no actualiza automáticamente ese candidato: su adopción requiere un cambio separado y secuencial en Stack contra el artefacto publicado exacto.

La versión declarada en `package.json` y la snapshot de Stack identificada por `contract/parity.v2.json` son autoridades independientes. La publicación de Pi y su adopción por Stack son pasos separados: comprueba la disponibilidad de la versión en npm y el pin de `src/lib/pi-runtime-pin.json` en Stack antes de instalar; `src/lib/pi-runtime.ts` conserva el lifecycle y los contratos. No deduzcas un nuevo par publicado de esta documentación.

Publicar Pi no actualiza automáticamente JorgeX Stack. Para la adopción gestionada posterior, el flujo sigue este orden:

1. Fusionar, verificar y publicar la versión de `jorgex-pi`.
2. Comprobar runs y PRs del coordinador antes de preparar manualmente el PR separado de adopción en Stack contra el artefacto exacto publicado, verificando URL, tamaño, SHA-256 y SHA-512 del tarball, `tests/fixtures/pi-runtime-artifacts.json`, lifecycle y rollback.
3. Consumir una versión solo después de publicar y verificar el artefacto exacto, su integridad, compatibilidad y procedencia.
4. Mantener el candidato anterior en Stack hasta que ese PR se fusione y verifique.

Con la App configurada y `JORGEX_AUTOMATION_ENABLED=true`, el coordinador de Stack reconcilia en `main` o dispatch la snapshot Pi del canon y la adopción en Stack, con no-op si no hay cambios; el notificador Pi lo despierta tras verificar la publicación. Consultar el [runbook Stack ↔ Pi](https://github.com/jorgehn98/jorgex-stack/blob/main/docs/references/stack-pi-automation.md) y evitar duplicar propuestas existentes. Sin opt-in, ante incompatibilidad o fallo explícito, recurrir al preparador local y una PR manual con review y gates; si falta el artefacto, persiste la dependencia externa. No editar pines ni hashes por rutina ni forzar fixtures: los cambios semánticos requieren revisión. El merge siempre exige orden de Jorge; la automatización no hace auto-merge ni instalaciones personales.

La instalación o consumo queda disponible tras la publicación y adopción verificadas. La instalación directa usa un canal separado, pero ambos canales deben conservar el pin exacto, la integridad y la compatibilidad.

La verificación local de Stack comprueba que los bytes descargados coinciden con el tamaño y los SHA-256/SHA-512 fijados para el candidato aceptado. Es una comprobación local del artefacto, no una raíz de confianza independiente: la attestation/provenance externa de npm queda fuera del runtime, y `provenance.commit` es informativo salvo verificación explícita de esa attestation.

Nunca enlazar ambos repos mediante `latest`, un checkout vivo o descargas sin integridad.

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

La procedencia de la snapshot se consulta en `contract/parity.v2.json`; no repetir aquí SHA. El contrato v2 también registra `assets/system-prompt/AGENTS.md`, `assets/system-prompt/engram-protocol.md`, `assets/system-prompt/context7.md`, los módulos de browser y `prompts/lean-audit.md`. `modular-system-prompts-v1` declara la recomposición marker-aware: Web Access se incluye cuando el bootstrap está sano y no hay conflicto; Context7 se incluye únicamente tras su registro correcto en el bridge; Playwright solo cuando su handoff resuelve `ready`; DevTools solo cuando el bridge gestionado registra su servidor y configuración válidos. Context7 usa el transporte HTTP del adaptador aislado, pero su estado registrado no promete handshake ni readiness operativa. El bridge se describe como `validated and registered as managed lazy bridge`, y el protocolo Engram solo aparece cuando su estado es `managed`.

### F1 Pi: acceso privado sin adopción implícita

La proyección generada conserva `inheritSkills: false` para cada agente. El generador `scripts/generate-runtime-agents.mjs` selecciona metadata y rutas privadas por rol para los 12 workers no-Engram; `engram` queda read-only, sin selección de skills y con sólo sus herramientas de lectura de memoria. La ruta `../skills` permite resolver lo declarado sin activar las 17 skills globalmente; `codebase-analyst` conserva las skills backend `supabase` y `supabase-postgres-best-practices`. La snapshot coordinada contiene 17 árboles de skill y 89 archivos; la lista activa del paquete coincide con esa snapshot.

El seam verificable es el contrato público `resolveSubagentLaunchContract` de `pi-subagents@0.54.0`, usado por `tests/fixtures/discover-runtime-agents.mjs`: sirve para comprobar selección, rutas, metadata y allowlist efectiva. No debe interpretarse como prueba de ejecución de un modelo, lectura del cuerpo completo de una skill, ACL universal o compatibilidad de todos los runtimes. La selección privada de skills de F1 no define los defaults de modelo, permisos, receipts, HOME ni configuración del usuario.

El trabajo cross-repo no se cierra tras fusionar Pi: debe completar los PRs secuenciales requeridos en Stack y verificar el resultado final. De forma simétrica, un cambio de Stack tampoco se da por cerrado si deja pendiente la PR de Pi necesaria para publicar o adoptar su proyección.

Esta consolidación convierte el análisis en una decisión explícita antes de delegar, documenta únicamente las necesidades concretas, hace observable el progreso mediante resultados verificables y check-ins acotados, exige preflight antes de efectos externos costosos, reutiliza la verificación cuando siguen coincidiendo comando, configuración, entorno, entradas y contratos, limita los reintentos y reevalúa causa, alcance, ownership y seam antes de una segunda reparación si persisten bloqueantes o regresiones; los cambios materiales requieren aprobación antes de continuar. Aplica review selectiva sólo cuando el riesgo no queda cubierto por verificaciones deterministas, resume cada checkpoint ready con cambios y evidencia, continúa después de ready sólo de forma segura y aprobada, y mantiene los prompts como política sin crear modos nuevos. Consulta la [skill canónica `orchestrator`](skills/orchestrator/SKILL.md).

## Desarrollo y verificación

- Usar pnpm para instalar, probar, construir y empaquetar. La única excepción npm es el `npm publish` ejecutado por trusted publishing.
- Comandos base: `pnpm install --frozen-lockfile`, `pnpm test` y `pnpm pack`. `pnpm build` es alias de `pnpm test`; ejecutar una sola vez, no ambos.
- Pi soportado: únicamente las versiones explícitas declaradas en `contract/jorgex-pi.v1.json` (`0.84.2` y `0.85.1`); no interpretar la lista como un intervalo ni incluir `0.85.0` por proximidad. No ampliar compatibilidad sin una prueba real.
- `openai-codex/gpt-5.6-sol` es el primary gestionado. `contextWindow=872000` es metadata/política local solicitada: la aceptación real del backend en sesiones OAuth debe smoke-testearse. No documentar `1.05M` para OAuth ni confundir `openai-codex` con el proveedor API `openai`.
- No tocar configuraciones, estado o memoria Engram del usuario fuera del lifecycle declarado. Pi gestiona la pareja Sol ausente o parcialmente coincidente en `PI_CODING_AGENT_DIR/settings.json` (`defaultProvider=openai-codex`, `defaultModel=gpt-5.6-sol`), el override `PI_CODING_AGENT_DIR/models.json` (`providers.openai-codex.modelOverrides.gpt-5.6-sol.contextWindow=872000`) y su receipt `PI_CODING_AGENT_DIR/jorgex-pi/sol-lifecycle.v1.json`; una mitad extranjera bloquea la siembra de la otra. El primer `sync` también siembra, solo en campos ausentes, `theme=JorgeX`, `quietStartup=true` y `hideThinkingBlock=true` en `settings.json`, y registra esa propiedad por separado en `PI_CODING_AGENT_DIR/jorgex-pi/experience-lifecycle.v1.json`; los valores preexistentes, incluso si coinciden, no se reclaman. Esa visita inicial evita resembrar campos borrados posteriormente; los reemplazos del usuario liberan ownership y `cleanup` solo elimina valores exactos que sigan siendo receipt-owned. También puede sembrar `PI_CODING_AGENT_DIR/extensions/pi-permission-system/config.json` únicamente si el archivo está ausente, con su receipt independiente `PI_CODING_AGENT_DIR/jorgex-pi/permissions-lifecycle.v1.json`; los estados preexistentes, inválidos o editados por el usuario se preservan y no se reimponen. La política usa publicación exclusiva y backups durante cleanup; no declara un lock compartido con la UI nativa de permisos. Las settings de proyecto prevalecen y `defaultThinkingLevel` permanece intacto. El read-modify-write de Sol usa locks de configuración compatibles con Pi. Los receipts registran ownership solo de valores creados por JorgeX y cleanup conserva reemplazos del usuario. El bridge acepta primero un `ENGRAM_BIN` absoluto explícito y, si falta, el receipt exacto que JorgeX Stack deja en `~/.jorgex-stack/pi-receipt.json`; no usa `PATH` ni convierte ese hand-off en ownership de Pi. Los límites de ownership viven en `contract/assets.v1.json`.
- Mantener sincronizados `package.json`, el contrato raíz, el runner, README y cualquier metadato de release.
- No añadir dependencias ni activar companions sin pin exacto, integridad auditada, cierre empaquetado y lifecycle real aislado.

## Git y publicación

- Los cambios de comportamiento van por rama/worktree y PR; nunca se empujan directamente a `main`.
- Antes de ready: tests focales, suite completa, pack real, diff final y revisión del SHA candidato.
- El merge requiere orden explícito de Jorge.
- Trusted publishing autoriza npm, pero no sustituye los triggers ni la política de versionado del workflow. Los pushes a `main` publican versiones ausentes o incrementan el patch para cambios publicables; minor y major siguen siendo decisiones manuales dentro del PR. El workflow crea el tag después de publicar. No crear tags ni publicar manualmente salvo recuperación expresamente autorizada.
