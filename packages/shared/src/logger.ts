/**
 * The logging contract for runtime-side code (ARCHITECTURE.md section 10). `runtime/log`
 * implements it; `services` receives one by injection, because it may not depend on the
 * runtime and may not use `console` (stdout carries the protocol, ADR-0003).
 */

export type LogLevel = "error" | "warn" | "info" | "debug" | "trace";

/** Extra structured fields: correlation IDs (`projectId`, `turnId`, ...), durations, `err`. */
export type LogFields = Record<string, unknown>;

export interface Logger {
  error(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  debug(msg: string, fields?: LogFields): void;
  trace(msg: string, fields?: LogFields): void;
  /** A logger that adds `fields` to every line, for example `{ module: "workspace" }`. */
  child(fields: LogFields): Logger;
}

const LEVELS: readonly LogLevel[] = ["error", "warn", "info", "debug", "trace"];

export function parseLogLevel(text: string | undefined, fallback: LogLevel = "info"): LogLevel {
  return LEVELS.includes(text as LogLevel) ? (text as LogLevel) : fallback;
}

/** True when a line at `level` passes a logger set to `threshold`. */
export function isLevelEnabled(level: LogLevel, threshold: LogLevel): boolean {
  return LEVELS.indexOf(level) <= LEVELS.indexOf(threshold);
}

/** A logger that drops everything, for tests and optional dependencies. */
export const nullLogger: Logger = {
  error() {},
  warn() {},
  info() {},
  debug() {},
  trace() {},
  child() {
    return nullLogger;
  },
};
