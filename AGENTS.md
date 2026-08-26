# JorgeX Pi

Paquete Pi-native del harness JorgeX. Este archivo define la relación operativa con JorgeX Stack y las comprobaciones mínimas antes de cambiar o publicar el paquete.

## Relación con JorgeX Stack

`jorgex-pi` se puede instalar directamente mediante el gestor de paquetes de Pi, pero su canal principal es JorgeX Stack. Los repos tienen responsabilidades distintas:

- **JorgeX Stack** es la fuente canónica de agentes, skills, system prompt y políticas compartidas, además del fleet manager que instala y verifica Pi.
- **JorgeX Pi** posee la traducción Pi-native, el bootstrap, contratos, companions, assets, runner JSON y lifecycle del paquete.
- El contenido compartido no se mantiene a mano en ambos sitios: `contract/parity.v1.json` fija el commit canónico de Stack y los generadores producen la snapshot y la proyección Pi.

Todo cambio debe incluir una revisión explícita de impacto cruzado:

- Si cambian agentes, skills, system prompt, permisos, Engram, browser routing o modelos, comprobar primero si la fuente debe cambiar en Stack y después regenerar/verificar la paridad en Pi.
- Si cambian versión, runner, contratos, capacidades, assets, dependencias, ownership, instalación, actualización, doctor o cleanup de Pi, comprobar si Stack debe actualizar su candidato congelado, fixtures, tests y `docs/references/pi-runtime.md`.
- Un cambio sin impacto en el otro repo debe dejar esa conclusión anotada en el PR; no se asume automáticamente que los repos son independientes.

## Releases coordinadas

Publicar Pi no actualiza automáticamente JorgeX Stack. La adopción gestionada sigue este orden:

1. Fusionar, verificar y publicar la versión de `jorgex-pi`.
2. Esperar un mínimo de **24 horas en npm**, salvo excepción explícita de Jorge documentada en el PR.
3. Abrir un PR separado en Stack que fije la versión exacta y verifique URL, tamaño, SHA-256 y SHA-512 del tarball publicado, incluidos fixture, lifecycle y rollback.
4. Mantener el candidato anterior en Stack hasta que ese PR se fusione.

La instalación directa puede seleccionar una versión publicada explícita y queda fuera de la ventana gestionada por Stack. Nunca enlazar ambos repos mediante `latest`, un checkout vivo o descargas sin integridad.

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
