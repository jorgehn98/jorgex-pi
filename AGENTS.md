# JorgeX Pi

Paquete Pi-native del harness JorgeX. Este archivo define la relación operativa con JorgeX Stack y las comprobaciones mínimas antes de cambiar o publicar el paquete.

## Relación con JorgeX Stack

`jorgex-pi` se puede instalar directamente mediante el gestor de paquetes de Pi, pero su canal gestionado es JorgeX Stack. `package.json` es la autoridad de versión y `contract/parity.v2.json`, mediante `source.commit`, identifica el origen de la snapshot compartida. Los repos tienen responsabilidades distintas:

- **JorgeX Stack** es la fuente canónica de agentes, skills, system prompt y políticas compartidas, además del fleet manager que instala y verifica Pi.
- **JorgeX Pi** posee la traducción Pi-native, el bootstrap, contratos, companions, assets, runner JSON y lifecycle del paquete.
- El contenido compartido no se mantiene a mano en ambos sitios: `contract/parity.v2.json` fija el commit canónico de Stack y los generadores producen la snapshot, los fallbacks de política/protocolo y la proyección Pi de `/lean-audit`.

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

El rollout histórico de `work-audit` comenzó con Stack 1.9.0 como canon y Pi 0.8.0 actualizando la snapshot y allowlist del paquete directo. Stack 1.9.7 ya está publicado y mantiene el receipt gestionado exacto `npm:jorgex-pi@0.8.4`; Pi 0.8.5 sigue siendo un candidato, cuya publicación y adopción se verifican en checkpoints posteriores.

Publicar Pi no actualiza automáticamente JorgeX Stack. Para una futura adopción gestionada, el flujo sigue este orden:

1. Fusionar, verificar y publicar la versión de `jorgex-pi`.
2. Abrir el PR separado y secuencial de adopción en Stack contra el artefacto exacto publicado, verificando URL, tamaño, SHA-256 y SHA-512 del tarball, fixture, lifecycle y rollback.
3. Esperar las **24 horas en npm** solo antes del consumo real por instalaciones gestionadas, salvo excepción explícita de Jorge documentada en ese PR.
4. Mantener el candidato anterior en Stack hasta que ese PR se fusione y verifique.

La ventana de madurez gestionada de **24 horas en npm** afecta únicamente a la instalación o consumo real del nuevo paquete Pi; no bloquea desarrollo, PRs, merges, publicación ni validación de la adopción. La adopción de Pi 0.8.5 queda para un PR separado y secuencial de Stack, que deberá verificar el artefacto publicado exacto, su tamaño, SHA-256, SHA-512, lifecycle y rollback. La instalación directa usa un canal separado, pero cualquier consumo antes de cumplir la ventana requiere una excepción explícita de Jorge; el canal directo no permite eludir esta política, que Pi no impone automáticamente.

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

La procedencia de la snapshot se consulta en `contract/parity.v2.json`; no repetir aquí SHA. El contrato v2 también registra `assets/system-prompt/AGENTS.md`, `assets/system-prompt/engram-protocol.md` y `prompts/lean-audit.md`; el bridge se describe como `validated and registered as managed lazy bridge`, sin prometer handshake ni readiness operativa, y el protocolo Engram solo aparece cuando su estado es `managed`.

### F2-A Pi: rutas short y standard

La proyección de Pi 0.8.5 incorpora el enrutado del orquestador a `short` o `standard` antes de iniciar el workflow. `short` exige objetivo claro, contrato afectado entendido, alcance acotado y verificación suficiente; `standard` se usa cuando el alcance, la incertidumbre, el riesgo o las necesidades de verificación requieren el workflow formal. Si una tarea short crece en cualquiera de esas dimensiones, se promueve a standard antes de continuar.

La ruta short standalone conserva un responsable principal y no crea PRD, plan, Spec formal, PRE ni POST por ceremonia. Si ya existe un SDD formal, conserva su scope, Spec, fila de plan y lifecycle aunque un paso acotado use short. La ruta standard mantiene PRD, plan, PRE, POST, change-first y entrega. Al elegir `standard`, carga [`standard-workflow.md`](skills/orchestrator/references/standard-workflow.md) resolviéndolo relativo a la skill `orchestrator`; si falta o no puede leerse, bloquea la ruta en vez de degradarla a `short`. Es política condicional: no implica que todas las tareas Pi ejecuten el workflow standard.

### F1 Pi: acceso privado sin adopción implícita

La proyección generada conserva `inheritSkills: false` para cada agente. El generador `scripts/generate-runtime-agents.mjs` selecciona metadata y rutas privadas por rol para los 13 workers no-Engram; `engram` queda read-only, sin selección de skills y con sólo sus herramientas de lectura de memoria. La ruta `../skills` permite resolver lo declarado sin activar las 18 skills globalmente. La snapshot coordinada contiene 18 árboles de skill y 98 archivos; la lista activa del paquete sigue siendo deliberadamente más estrecha.

El seam verificable es el contrato público `resolveSubagentLaunchContract` de `pi-subagents@0.54.0`, usado por `tests/fixtures/discover-runtime-agents.mjs`: sirve para comprobar selección, rutas, metadata y allowlist efectiva. No debe interpretarse como prueba de ejecución de un modelo, lectura del cuerpo completo de una skill, ACL universal o compatibilidad de todos los runtimes. F1 tampoco cambia defaults de modelo, permisos, receipts, HOME o configuración del usuario.

El trabajo cross-repo no se cierra tras fusionar Pi: debe completar los PRs secuenciales requeridos en Stack y verificar el resultado final. De forma simétrica, un cambio de Stack tampoco se da por cerrado si deja pendiente la PR de Pi necesaria para publicar o adoptar su proyección.

## Desarrollo y verificación

- Usar pnpm para instalar, probar, construir y empaquetar. La única excepción npm es el `npm publish` ejecutado por trusted publishing.
- Comandos base: `pnpm install --frozen-lockfile`, `pnpm test`, `pnpm build` y `pnpm pack`.
- Pi soportado: exactamente la versión declarada en `contract/jorgex-pi.v1.json`; no ampliar compatibilidad sin una prueba real.
- No tocar configuraciones, estado o memoria Engram del usuario fuera del lifecycle declarado. Pi gestiona únicamente la pareja Sol ausente o parcialmente coincidente en `PI_CODING_AGENT_DIR/settings.json` (`defaultProvider=openai-codex`, `defaultModel=gpt-5.6-sol`), el override `PI_CODING_AGENT_DIR/models.json` (`providers.openai-codex.modelOverrides.gpt-5.6-sol.contextWindow=872000`) y su receipt `PI_CODING_AGENT_DIR/jorgex-pi/sol-lifecycle.v1.json`; una mitad extranjera bloquea la siembra de la otra. El read-modify-write usa locks de configuración compatibles con Pi. El receipt registra ownership por campo, contenedor y archivo; cleanup solo elimina valores receipt-owned que sigan siendo exactos y conserva reemplazos del usuario. El bridge acepta primero un `ENGRAM_BIN` absoluto explícito y, si falta, el receipt exacto que JorgeX Stack deja en `~/.jorgex-stack/pi-receipt.json`; no usa `PATH` ni convierte ese hand-off en ownership de Pi. Los límites de ownership viven en `contract/assets.v1.json`.
- `openai-codex/gpt-5.6-sol` es el primary gestionado. `contextWindow=872000` es metadata/política local solicitada: la aceptación real del backend en sesiones OAuth debe smoke-testearse. No documentar `1.05M` para OAuth ni confundir `openai-codex` con el proveedor API `openai`.
- Mantener sincronizados `package.json`, el contrato raíz, el runner, README y cualquier metadato de release.
- No añadir dependencias ni activar companions sin pin exacto, integridad auditada, cierre empaquetado y lifecycle real aislado.

## Git y publicación

- Los cambios de comportamiento van por rama/worktree y PR; nunca se empujan directamente a `main`.
- Antes de ready: tests focales, suite completa, pack real, diff final y revisión del SHA candidato.
- El merge requiere orden explícito de Jorge.
- Trusted publishing autoriza npm, pero no sustituye los triggers ni la política de versionado del workflow. Los pushes a `main` publican versiones ausentes o incrementan el patch para cambios publicables; minor y major siguen siendo decisiones manuales dentro del PR. El workflow crea el tag después de publicar. No crear tags ni publicar manualmente salvo recuperación expresamente autorizada.
