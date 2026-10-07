# compact-tools

Extensión de Pi que agrupa la actividad y las llamadas a herramientas en bloques desplegables. Solo cambia la presentación: no modifica el contexto, las respuestas ni los tokens enviados al modelo.

## Uso

Una vez publicado el paquete:

```sh
pi install npm:compact-tools
```

Pi gestiona instalación, actualización y retirada mediante sus comandos nativos. No hace falta Stack para usar esta extensión. El conjunto de configuración, skills, subagentes, cabecera y extensiones de JorgeX sí se instala desde Stack; este paquete no instala ni configura ese conjunto.

Los grupos muestran contadores de lecturas, ediciones y actividad, con ejecuciones pendientes y errores. Pulsar la cabecera abre o cierra el grupo. El detalle de cada herramienta y la visibilidad del razonamiento siguen las preferencias nativas de Pi; abrir un grupo no las cambia. Las respuestas de texto permanecen fuera del grupo.

No se añade ningún comando, herramienta para el modelo, tema o servicio. Solo actúa en la TUI; no transforma sesiones RPC/JSON.

## Configuración opcional

Sin configuración, está habilitada. Para deshabilitarla sin quitar el paquete, escribir en `<agent-dir>/extensions/compact-tools/config.json` (por defecto `~/.pi/agent/extensions/compact-tools/config.json`):

```json
{ "enabled": false }
```

Usar `true` para habilitarla y recargar Pi. Una configuración inválida muestra un aviso y mantiene el rendering nativo. La extensión solo lee este archivo; no escribe settings, sesiones ni credenciales.

## Límites

La agrupación utiliza componentes y campos internos de la TUI porque el host examinado no ofrece una API pública para agrupar filas del transcript. Si no encuentra el contenedor esperado, deja la vista nativa. Al descargar/recargar restaura los handlers que todavía le pertenecen.

No se promete compatibilidad con todos los Pi históricos o futuros. El desarrollo usa el host oficial y tests sobre sus componentes reales; los peers del paquete son proporcionados por Pi, sin copias privadas. Véase [DESIGN.md](https://github.com/jorgehn98/jorgex-pi/blob/main/DESIGN.md) para el alcance visual.

## Desarrollo

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm test
pnpm pack --pack-destination <directorio-temporal-propio>
```

Los tests usan el host de desarrollo de `node_modules`; `PI_TEST_HOST` permite señalar otro árbol de módulos ya preparado. Si falta el host, fallan explícitamente en lugar de omitir las comprobaciones. No necesitan cuenta/modelo ni sesiones personales. Limpiar los temporales y paquetes de comprobación propios.

## Publicación

La publicación automática de `compact-tools` necesita su propio **trusted publisher** en npm para `jorgehn98/jorgex-pi`, workflow `publish.yml`, con permiso de publicación directa. Cambiar el repositorio o el workflow no configura ese permiso externo; corresponde al titular.

La versión se prepara en el PR; major/minor requieren decisión explícita de Jorge. Al merge en main se publica automáticamente una versión nueva. Si la versión ya está publicada y tiene tag válido, no se crea otra release ni patch automático por cambios de docs/código.

Validación con `contents:read`: SHA inmutable, suite nativa `node:test` y un solo `pnpm pack`, sin build separado. Ese tarball, su identidad y su SRI SHA-512 pasan por artifact a publicación OIDC (`id-token:write`, sin escritura de repositorio), sin instalar dependencias, ejecutar tests o reempaquetar. `npm publish --ignore-scripts --provenance` publica esos bytes. Solo tras confirmar `dist.integrity` en npm se crea `compact-tools-v<versión>` sobre el mismo SHA, mediante un job `contents:write` sin checkout ni ejecución de producto. No hay App de bump ni GitHub release adicional.

**Recuperación:** `workflow_dispatch` sobre main exige `release_sha` de 40 hex, ancestro de main. Para una versión existente se reconstruye el tarball y se compara SRI antes de etiquetar; existencia sola no acredita bytes. Nunca republish, mover tags ni retroceder `latest`: versiones nuevas históricas/candidatos obsoletos se bloquean. Un push ordinario con versión publicada sin tag exige recuperación explícita. Reruns de publicación consultan npm y omiten publish si los bytes ya coinciden; reruns de tag conservan el SHA confirmado. Revisiones históricas sin este script/contrato no tienen compatibilidad garantizada.

Solo 404 significa versión ausente; auth/red/metadata inválida fallan cerrado. Un rerun con versión aún ausente falla cerrado: esperar metadata y aclarar el resultado anterior antes de iniciar otra publicación. Tras publicar, el readback sondea npm cada 15 s hasta acumular 5 minutos de espera y solo espera mientras el registro responda 404 por propagación; cualquier otro resultado (auth, HTTP no-ok, metadata inválida, integridad distinta o error de red) falla cerrado en el intento que lo observa. Agotar la espera deja el readback pendiente y no justifica republish. Si GitHub rechaza realmente el tag (por ejemplo 403), la publicación queda parcial y recuperable con la SHA exacta, sin elevar tokens. No veto genérico por mezclar workflows y producto ni garantía para cualquier referencia histórica. No cancelar publicaciones mutables. No coordinador Stack↔Pi.

Los tags son independientes de los históricos `jorgex-pi`. No modificar/despublicar ese paquete ni `0.0.0-stage`, instalaciones personales o datos del usuario. Trusted Publisher, App/secrets antiguos y rulesets son configuración externa del titular; este cambio no los administra ni acredita.

Merge, publicación manual y cambios de instalación personal requieren autorización explícita. Licencia [MIT](LICENSE).
