# JorgeX Pi — diseño terminal

Este documento es la fuente de verdad visual de JorgeX Pi. Solo contiene reglas que puede aplicar una interfaz de terminal; el diseño web vive en JorgeX.pro.

## Identidad

- El símbolo canónico es `assets/brand/eye-logo.svg`, copia exacta del ojo de JorgeX.pro (SHA-256 `0bd562e7707995135a5751ecf055a032c8f12a3d0b1f373e2299a6b94c4dab5d`).
- La TUI no intenta mostrar SVG. Usa una representación Braille generada y revisada a partir de ese asset.
- El wordmark es `JorgeX Pi`. No se sustituye el ojo por el nombre ni se usa una estética distinta a la marca.
- El theme nativo es descubrible y opt-in: el paquete nunca cambia la preferencia del usuario.

## Tokens canónicos

El bloque JSON siguiente es machine-readable. Los tests exigen paridad con `themes/JorgeX.json`.

<!-- jorgex-pi:theme:start -->
```json
{
  "palette": {
    "background": "#060913",
    "surface": "#0B1120",
    "primary": "#22D3EE",
    "primaryStrong": "#06B6D4",
    "secondary": "#A78BFA",
    "secondaryStrong": "#8B5CF6",
    "text": "#F8FAFC",
    "textSecondary": "#E2E8F0",
    "muted": "#64748B",
    "success": "#10B981",
    "error": "#EF4444",
    "warning": "#F59E0B"
  }
}
```
<!-- jorgex-pi:theme:end -->

## Header

- Menos de 40 columnas: ojo compacto y versión de Pi; siempre estático.
- De 40 a 99: ojo compacto, `JorgeX Pi` y metadatos en una columna.
- Desde 100: ojo detallado a la izquierda, wordmark a la derecha y metadatos debajo.
- Datos permitidos: versión del runtime Pi, versión del paquete, agentes runnable, skills empaquetadas, basename del workspace y `PACKAGE LOADED`. Cada valor procede de su fuente real (`VERSION`, `package.json`, contrato de agentes o contexto de sesión).
- No se presentan modelo, Git, MCP, tools globales ni salud del sistema como si fueran datos completos.

## Movimiento

- Reveal/scan de izquierda a derecha, 800 ms, frames cada 40 ms y una sola pasada.
- Sin limpieza ANSI de pantalla, flashes ni loops.
- `JORGEX_PI_MOTION=reduce`, `CI`, `TERM=dumb` o una salida no TTY producen el frame final estático. `JORGEX_PI_MOTION=full` solo fuerza movimiento en una TTY.
- `NO_COLOR` elimina color, no cambia la política de movimiento.
- El componente es dueño de su timer: `dispose()` y `session_shutdown` lo cancelan de forma idempotente.

## Mantenimiento

Al cambiar la marca, primero se sustituye el SVG canónico; después se regenera/revisa el Braille y se actualiza el hash de procedencia. Al cambiar color, se edita este bloque y el test obliga a sincronizar el theme. Las versiones nunca se duplican aquí ni en el arte.
