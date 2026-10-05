# Agrupación visual de herramientas

La extensión usa el tema activo de Pi y sus componentes nativos; no introduce marca, cabecera o paleta propia.

- Agrupar actividad contigua en una fila desplegable con contadores. Las respuestas de texto interrumpen el grupo y permanecen visibles.
- La cabecera resume cantidades y estados, no argumentos ni resultados potencialmente sensibles.
- Abrir un grupo conserva el detalle nativo de herramientas y la preferencia de ocultar razonamiento; no forzar ninguno.
- Errores visibles con el color nativo correspondiente; ancho ajustado al terminal.
- No modificar los componentes almacenados o el contexto del modelo. La agrupación es una proyección de presentación.
- Restaurar handlers propios al descargar/recargar, sin deshacer cambios posteriores de otra extensión. Sin animaciones, timers o procesos de fondo nuevos.

La cabecera JorgeX y su arte se mantienen fuera de este paquete, desde Stack. El diseño anterior sigue en el historial Git, no como una segunda fuente activa.
