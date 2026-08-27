# JorgeX Pi

Paquete Pi-native del harness JorgeX. Este archivo define la relación operativa con JorgeX Stack y las comprobaciones mínimas antes de cambiar o publicar el paquete.

## Relación con JorgeX Stack

`jorgex-pi` se puede instalar directamente mediante el gestor de paquetes de Pi, pero su canal gestionado es JorgeX Stack. En `0.4.0`, Pi fija la snapshot de Stack `5353c83c212a8603ab3e3bd5cac54dde4c75037c` mediante parity v2. Los repos tienen responsabilidades distintas:

- **JorgeX Stack** es la fuente canónica de agentes, skills, system prompt y políticas compartidas, además del fleet manager que instala y verifica Pi.
- **JorgeX Pi** posee la traducción Pi-native, el bootstrap, contratos, companions, assets, runner JSON y lifecycle del paquete.
- El contenido compartido no se mantiene a mano en ambos sitios: `contract/parity.v2.json` fija el commit canónico de Stack y los generadores producen la snapshot, los fallbacks de política/protocolo y la proyección Pi de `/lean-audit`.

Todo cambio debe incluir una revisión explícita de impacto cruzado:

- Si cambian agentes, skills, system prompt, permisos, Engram, browser routing o modelos, comprobar primero si la fuente debe cambiar en Stack y después regenerar/verificar la paridad en Pi.
- Si cambian versión, runner, contratos, capacidades, assets, dependencias, ownership, instalación, actualización, doctor o cleanup de Pi, comprobar si Stack debe actualizar su candidato congelado, fixtures, tests y `docs/references/pi-runtime.md`.
- Un cambio sin impacto en el otro repo debe dejar esa conclusión anotada en el PR; no se asume automáticamente que los repos son independientes.

## Canales de instalación y releases coordinadas

La instalación directa y la gestionada no son el mismo canal:

- **Directa:** `pi install npm:jorgex-pi@0.4.0` usa los assets y el prompt empaquetados. La extensión aplica fallbacks marker-aware: añade solo las secciones ausentes, conserva el prompt del usuario y no duplica marcadores ya proyectados por Stack.
- **Gestionada futura (PR02):** Stack deberá proyectar policy, skills, prompt y secciones condicionadas a las rutas de usuario de Pi, y filtrar los duplicados del paquete. Ese PR es posterior, separado y todavía no existe; no documentar su artefacto ni tratarlo como desplegado.

Publicar Pi no actualiza automáticamente JorgeX Stack. La adopción gestionada sigue este orden:

1. Fusionar, verificar y publicar la versión de `jorgex-pi`.
2. Abrir el PR separado y secuencial de adopción en Stack contra el artefacto exacto publicado, verificando URL, tamaño, SHA-256 y SHA-512 del tarball, fixture, lifecycle y rollback.
3. Esperar las **24 horas en npm** solo antes del consumo real por instalaciones gestionadas, salvo excepción explícita de Jorge documentada en ese PR.
4. Mantener el candidato anterior en Stack hasta que ese PR se fusione y verifique.

La ventana de 24 horas no bloquea desarrollo, PRs, merges, publicación ni validación de la adopción. La instalación directa puede seleccionar una versión publicada explícita y queda fuera de esa ventana.

Nunca enlazar ambos repos mediante `latest`, un checkout vivo o descargas sin integridad.

Los cambios compartidos recientes adoptados en esta línea son Stack PR #59 (contexto de trabajo de `xreview`, con regeneración de agentes afectados) y Stack PR #62 (hardening de `lean-code` y policy compartida). El contrato v2 también registra `assets/system-prompt/AGENTS.md`, `assets/system-prompt/engram-protocol.md` y `prompts/lean-audit.md`; el bridge se describe como `validated and registered as managed lazy bridge`, sin prometer handshake ni readiness operativa, y el protocolo Engram solo aparece cuando su estado es `managed`.

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
