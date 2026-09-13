import { getPermissionsService } from "@gotgenes/pi-permission-system";

export default function permissionsObserver(pi) {
  pi.on("session_start", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const service = getPermissionsService(sessionId);
    pi.events.emit("permissions-fixture:service", service
      ? {
          path: service.checkPermission("path", ".env"),
          tool: service.getToolPermission("git_read"),
        }
      : undefined);
  });
}
