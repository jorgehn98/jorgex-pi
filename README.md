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

El nombre `compact-tools` necesita su propio **trusted publisher** en la configuración de npm para `jorgehn98/jorgex-pi`, workflow `publish.yml`, antes de publicar. Cambiar el repositorio o el workflow no configura ese permiso externo. La primera publicación requiere resolver ese prerrequisito con el titular; no se han publicado bytes por escribir esta documentación.

Los pushes a main usan la política existente: publican una versión todavía ausente o incrementan automáticamente patch si cambió contenido distribuido. Minor/major siguen siendo decisiones humanas. Validación sin permisos de escritura, bump de manifest separado, publicación del tarball con OIDC y tag posterior. El job de publicación no instala dependencias ni vuelve a ejecutar la suite validada: el bump solo cambia la versión del manifest.

Los tags usan `compact-tools-v<versión>`, distintos de los antiguos tags de `jorgex-pi`. No se modifica ni despublica el antiguo paquete. El input `release_sha` del workflow permite recuperación explícita desde una SHA de main de este nuevo paquete; las revisiones del paquete anterior se rechazan. No cancelar una publicación mutable ni republish para recuperar notificaciones: no hay coordinador Stack↔Pi.

Merge, publicación manual y cambios de instalación personal requieren autorización explícita. Licencia [MIT](LICENSE).
