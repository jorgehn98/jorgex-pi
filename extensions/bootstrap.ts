const companionIds = ["permission", "ask", "subagents"];
const companionTools = ["ask_user_question", "subagent", "subagent_wait"];

export function createBootstrap({ loadCompanion = loadDefaultCompanion, getPermissionsService: injectedLocator } = {}) {
  return async function bootstrap(pi) {
    let locateService = injectedLocator;
    const readySessions = new Set();
    const activatedSessions = new Set();
    let companionsHealthy = false;
    let bootstrapFailure;
    let failureNotified = false;

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
      if (bootstrapFailure && !failureNotified) {
        ctx?.ui?.notify?.(formatFailure(bootstrapFailure), "error");
        failureNotified = true;
      }
      hideCompanionTools(pi, companionTools);
    });

    pi.events.on("permissions:ready", (event) => {
      const sessionId = typeof event?.sessionId === "string" ? event.sessionId : undefined;
      if (!companionsHealthy || !sessionId || !locateService?.(sessionId)) return;

      readySessions.add(sessionId);
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
      if (!locateService) {
        try {
          locateService = await loadPermissionsLocator();
        } catch (error) {
          throw { phase: "load", companion: "permission", error };
        }
      }
      const factories = [];
      for (const companion of companionIds) {
        try {
          factories.push({ companion, factory: await loadCompanion(companion) });
        } catch (error) {
          throw { phase: "load", companion, error };
        }
      }
      for (const { companion, factory } of factories) {
        try {
          factory(pi);
        } catch (error) {
          throw { phase: "factory", companion, error };
        }
      }
      companionsHealthy = true;
    } catch (failure) {
      bootstrapFailure = normalizeFailure(failure);
    }

    pi.on("before_agent_start", (_agentEvent, ctx) => {
      const activeSession = readSessionId(ctx);
      if (!activeSession || !readySessions.has(activeSession)) {
        hideCompanionTools(pi, companionTools);
        return;
      }
      if (!activatedSessions.has(activeSession)) {
        pi.setActiveTools([...new Set([...pi.getActiveTools(), ...companionTools])]);
        activatedSessions.add(activeSession);
      }
      if (ctx?.hasUI === false) hideCompanionTools(pi, ["ask_user_question"]);
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

function normalizeFailure(failure) {
  if (failure?.phase && failure?.companion && "error" in failure) return failure;
  return { phase: "bootstrap", companion: "unknown", error: failure };
}

function formatFailure({ phase, companion, error }) {
  const message = error instanceof Error ? error.message : String(error);
  return `JorgeX companion ${companion} ${phase} failure: ${message}`;
}

export default createBootstrap();
