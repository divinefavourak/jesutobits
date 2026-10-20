import { isJesutobitsError } from "@jesutobits/protocol";
import { isLevelEnabled, type LogFields, type Logger, type LogLevel } from "@jesutobits/shared";
import type { SecretRegistry } from "./secret-registry.js";

/** Longest `msg` written; the Host keeps lines up to 64 KiB (`logging/mod.rs`). */
const MAX_MESSAGE_LENGTH = 16 * 1024;
/** Lines longer than this lose their extra fields rather than being dropped by the Host. */
const MAX_LINE_LENGTH = 60 * 1024;

export interface LoggerOptions {
  /** Writes one line, without its newline, to stderr. Must never be stdout (ADR-0003). */
  write(line: string): void;
  level: LogLevel;
  secrets: SecretRegistry;
}

/**
 * JSON-lines logger for the runtime (ARCHITECTURE.md section 10). Lines go to stderr; the
 * Host stamps `ts` and `component` and writes them to `runtime.jsonl`. Every string,
 * including nested fields, passes through the `SecretRegistry` first.
 */
export function createLogger(options: LoggerOptions, bound: LogFields = {}): Logger {
  const log = (level: LogLevel, msg: string, fields?: LogFields): void => {
    if (!isLevelEnabled(level, options.level)) return;
    try {
      options.write(formatLine(options.secrets, level, msg, { ...bound, ...fields }));
    } catch {
      // Logging must never throw into the caller.
    }
  };
  return {
    error: (msg, fields) => log("error", msg, fields),
    warn: (msg, fields) => log("warn", msg, fields),
    info: (msg, fields) => log("info", msg, fields),
    debug: (msg, fields) => log("debug", msg, fields),
    trace: (msg, fields) => log("trace", msg, fields),
    child: (fields) => createLogger(options, { ...bound, ...fields }),
  };
}

function formatLine(
  secrets: SecretRegistry,
  level: LogLevel,
  msg: string,
  fields: LogFields,
): string {
  const extra: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    // The Host owns these.
    if (key === "ts" || key === "component" || key === "level" || key === "msg") continue;
    extra[key] = serialisable(value);
  }
  const masked = secrets.maskValue(extra) as LogFields;
  // Mask before cutting, so a secret across the cut cannot leave a partial value.
  const text = truncate(secrets.mask(msg), MAX_MESSAGE_LENGTH);
  const line = JSON.stringify({ level, msg: text, ...masked });
  if (line.length <= MAX_LINE_LENGTH) return line;
  const module = typeof masked.module === "string" ? masked.module : undefined;
  return JSON.stringify({ level, msg: text, module, fieldsDropped: true });
}

/** Errors become plain objects; JesutobitsErrors keep their safe, serialisable form. */
function serialisable(value: unknown): unknown {
  if (isJesutobitsError(value)) return value.toData();
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  // Masking rebuilds objects from their entries, which would turn a Date into {}.
  if (value instanceof Date) return value.toISOString();
  return value;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…[truncated]`;
}
