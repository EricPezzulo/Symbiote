import type { Logger } from "./types.js";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

/** Keys whose values are never logged, plus a scrub for tokens embedded in URLs/strings. */
const SECRET_KEY = /key|secret|token|authorization|password/i;

export function scrub(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/([?&](?:token|apikey|api_key|key|x_cg_demo_api_key)=)[^&\s]+/gi, "$1***");
  }
  if (value instanceof Error) return scrub(value.message);
  return value;
}

export function createLogger(level: Level = "info", name = "worker", sink: (line: string) => void = console.log): Logger {
  const emit = (lvl: Level, msg: string, ctx?: Record<string, unknown>) => {
    if (LEVELS[lvl] < LEVELS[level]) return;
    const safe: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(ctx ?? {})) safe[k] = SECRET_KEY.test(k) ? "***" : scrub(v);
    sink(JSON.stringify({ t: new Date().toISOString(), level: lvl, name, msg: scrub(msg), ...safe }));
  };
  return {
    debug: (m, c) => emit("debug", m, c),
    info: (m, c) => emit("info", m, c),
    warn: (m, c) => emit("warn", m, c),
    error: (m, c) => emit("error", m, c),
    child: (n) => createLogger(level, `${name}.${n}`, sink),
  };
}

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger;
  },
};
