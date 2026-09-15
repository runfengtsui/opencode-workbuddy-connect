export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export type LogLevel = "debug" | "info" | "warn" | "error";

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const PREFIX = "[workbuddy] ";

function flag(name: string): string {
  return process.env[name]?.trim().toLowerCase() ?? "";
}

function debugOn(): boolean {
  return ["1", "true", "yes", "on"].includes(flag("WORKBUDDY_DEBUG"));
}

/**
 * Verbosity floor for opencode's own log file (see installLogSink). Default
 * `info` keeps the lifecycle trace on disk; `off` silences everything.
 */
function threshold(): number {
  const value = flag("WORKBUDDY_LOG");
  if (value === "off" || value === "none" || value === "0") return Number.POSITIVE_INFINITY;
  if (value === "debug" || value === "info" || value === "warn" || value === "error") return RANK[value];
  return debugOn() ? RANK.debug : RANK.info;
}

/** The opencode server writes this to the running instance's log file, which
 * keeps the terminal clear. Installed from the v1 server() hook -- the only
 * entry point that carries a client (v2's PluginContext has none) -- and every
 * lookup is optional so an older/newer SDK can never break a request. */
export interface LogClient {
  app?: {
    log?: (args: { body: { service: string; level: LogLevel; message: string; extra?: Record<string, unknown> } }) => unknown;
  };
}

let sink: ((level: LogLevel, message: string) => void) | undefined;

export function installLogSink(client?: LogClient): void {
  const app = client?.app;
  const log = app?.log;
  if (typeof log !== "function") return;
  sink = (level, message) => {
    try {
      Promise.resolve(log.call(app, { body: { service: "workbuddy", level, message } })).catch(() => {});
    } catch {
      /* logging must never break a request */
    }
  };
}

/**
 * Two destinations, deliberately different:
 *   - warn/error always reach stderr: something needs the user's attention.
 *   - everything at/above WORKBUDDY_LOG goes to opencode's log file, so the
 *     startup and per-request trace stays greppable without covering up the
 *     conversation. WORKBUDDY_DEBUG=1 mirrors the full trace to stderr too.
 */
function emit(level: LogLevel, message: string): void {
  const min = threshold();
  if (min === Number.POSITIVE_INFINITY) return;
  const rank = RANK[level];
  const toTerminal = debugOn() ? true : rank >= RANK.warn;
  const toLogFile = sink !== undefined && rank >= min;
  if (!toTerminal && !toLogFile) return;
  try {
    if (toTerminal) {
      const label = level === "debug" || level === "info" ? "" : `${level}: `;
      process.stderr.write(`${PREFIX}${label}${message}\n`);
    }
    if (toLogFile) sink?.(level, message);
  } catch {
    /* logging must never break a request */
  }
}

/** Routine lifecycle/trace detail -- opencode's log file, not the terminal. */
export function logPlugin(message: string): void {
  emit("debug", message);
}

export function logInfo(message: string): void {
  emit("info", message);
}

/** A degraded path the request survived (refresh failed, stale token spent). */
export function logWarn(message: string): void {
  emit("warn", message);
}

/** A failure that stops a login or a request. */
export function logError(message: string): void {
  emit("error", message);
}
