# compact-tools

Este repo mantiene una extensión visual Pi independiente. Stack posee el canon y el instalador del conjunto; aquí no se duplican skills, agentes, configuración ni lifecycle.

## Alcance

- `extensions/compact-tools.ts`: agrupación visual de actividad. No modificar transcript, preferencias de detalle/razonamiento o datos del usuario para esconder filas.
- Usar el tema activo y los componentes reales del host; consultar `DESIGN.md` antes de cambios visuales.
- No añadir bootstrap, wrappers de instalación, compatibilidad histórica, contratos publicados, receipts ni servicios. Host-provided packages son peers `*`, nunca dependencias runtime privadas.
- Conservar configuración ajena y secretos. La extensión lee su configuración opcional; no toca memoria, sesiones, credenciales o modelos.

## Trabajo y verificación

Usar pnpm con la versión declarada en package.json, preparada y comprobada antes de aislar el entorno. No instalar/sustituir toolchains implícitamente. Tests: `pnpm test`; distribución: `pnpm pack`. No hay build separado ni compilación para el archivo TS cargado por Pi.

Producción y tests pertenecen al mismo responsable. Reutilizar cobertura y añadir únicamente protección para un riesgo real no cubierto. La suite visual no debe quedar verde por omitir casos sin host. Probar en entorno aislado con cleanup y duración acotada; no arrancar sesiones personales.

El trabajo no trivial va en worktrees dentro de la raíz (`worktrees/`, excluido localmente), con rama del mismo nombre. Conservar trabajo ajeno. Una review proporcionada cuando el candidato esté estable; Ready al final, no un trigger de nuevas rondas. Merge solo con orden explícita.

## Publicación

Mantener la publicación normal y su aislamiento de permisos; pnpm para desarrollo/pack, npm solo para la publicación OIDC y su comprobación de versión dentro del workflow. El nuevo nombre necesita trusted publisher propio configurado en npm antes de publicar.

No publicar esta extensión bajo `jorgex-pi` ni reutilizar sus tags históricos. El workflow conserva auto-bump patch; minor/major se deciden en el PR. No tocar instalaciones personales, credenciales o paquetes ya publicados sin autorización.

Revisar impacto en Stack cuando cambien el nombre, configuración o uso de la extensión, sin recrear sincronización automática o snapshots del canon. La documentación operativa está en README; no duplicar aquí su procedimiento.
