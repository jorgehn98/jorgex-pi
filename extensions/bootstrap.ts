const companionIds = ["permission", "ask", "subagents"];

export function createBootstrap({ loadCompanion = loadDefaultCompanion, getPermissionsService: injectedLocator } = {}) {
  return async function bootstrap(pi) {
    let locateService = injectedLocator;
    const readySessions = new Set();
    const activatedSessions = new Set();
    const toolsBefore = new Set(pi.getActiveTools());
    let companionTools = [];
    let companionsHealthy = false;

    pi.on("tool_call", (_event, ctx) => {
      const sessionId = readSessionId(ctx);
      return sessionId && readySessions.has(sessionId)
        ? undefined
        : {
            block: true,
            terminate: true,
            reason: "JorgeX companions are unavailable until the session permission service is ready.",
          };
    });

    pi.on("session_start", (_event, ctx) => {
      const sessionId = readSessionId(ctx);
      if (sessionId) {
        readySessions.delete(sessionId);
        activatedSessions.delete(sessionId);
      }
      hideCompanionTools(pi, companionTools);
    });

    pi.events.on("permissions:ready", (event) => {
      const sessionId = typeof event?.sessionId === "string" ? event.sessionId : undefined;
      if (!companionsHealthy || !sessionId || !locateService?.(sessionId)) return;

      readySessions.add(sessionId);
      if (!activatedSessions.has(sessionId)) {
        pi.setActiveTools([...new Set([...pi.getActiveTools(), ...companionTools])]);
        activatedSessions.add(sessionId);
      }
    });

    pi.on("session_shutdown", (_event, ctx) => {
      const sessionId = readSessionId(ctx);
      if (sessionId) {
        readySessions.delete(sessionId);
        activatedSessions.delete(sessionId);
      }
      hideCompanionTools(pi, companionTools);
    });

    try {
      locateService ??= await loadPermissionsLocator();
      const factories = new Map();
      for (const id of companionIds) factories.set(id, await loadCompanion(id));
      for (const id of companionIds) factories.get(id)(pi);
      companionsHealthy = true;
    } catch {
      companionsHealthy = false;
    } finally {
      companionTools = pi.getActiveTools().filter((name) => !toolsBefore.has(name));
      hideCompanionTools(pi, companionTools);
    }

    pi.on("before_agent_start", (_agentEvent, ctx) => {
      const activeSession = readSessionId(ctx);
      if (!activeSession || !readySessions.has(activeSession)) hideCompanionTools(pi, companionTools);
      else if (ctx?.hasUI === false) hideCompanionTools(pi, ["ask_user_question"]);
    });
  };
}

async function loadDefaultCompanion(id) {
  if (id === "permission") {
    const serviceEntry = import.meta.resolve("@gotgenes/pi-permission-system");
    return (await import(new URL("./index.ts", serviceEntry).href)).default;
  }
  if (id === "ask") return (await import("@juicesharp/rpiv-ask-user-question")).default;
  if (id === "subagents") return (await import("pi-subagents")).default;
  throw new Error(`Unknown JorgeX companion: ${id}`);
}

async function loadPermissionsLocator() {
  return (await import("@gotgenes/pi-permission-system")).getPermissionsService;
}

function readSessionId(ctx) {
  const sessionId = ctx?.sessionId ?? ctx?.sessionManager?.getSessionId?.();
  return typeof sessionId === "string" && sessionId ? sessionId : undefined;
}

function hideCompanionTools(pi, hidden) {
  if (hidden.length === 0) return;
  const blocked = new Set(hidden);
  pi.setActiveTools(pi.getActiveTools().filter((name) => !blocked.has(name)));
}

export default createBootstrap();
