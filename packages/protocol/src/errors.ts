import { z } from "zod";

/** Code families from ARCHITECTURE.md section 9.1. */
export const ERROR_FAMILIES = [
  "rpc",
  "runtime",
  "provider",
  "tool",
  "fs",
  "process",
  "preview",
  "visual",
  "git",
  "permission",
  "ext",
  "storage",
] as const;

export type ErrorFamily = (typeof ERROR_FAMILIES)[number];

/** A stable dotted code such as `fs.outside_workspace`. Never rename a code once shipped. */
export type JesutobitsErrorCode = `${ErrorFamily}.${string}`;

const ERROR_CODE_PATTERN = new RegExp(
  `^(?:${ERROR_FAMILIES.join("|")})\\.[a-z][a-z0-9_]*(?:\\.[a-z][a-z0-9_]*)*$`,
);

export function isJesutobitsErrorCode(value: string): value is JesutobitsErrorCode {
  return ERROR_CODE_PATTERN.test(value);
}

/** Codes defined so far. Add new codes here so the Workbench can match on them. */
export const ErrorCodes = {
  rpcParseError: "rpc.parse_error",
  rpcInvalidRequest: "rpc.invalid_request",
  rpcMethodNotFound: "rpc.method_not_found",
  rpcInvalidParams: "rpc.invalid_params",
  rpcMessageTooLarge: "rpc.message_too_large",
  rpcInternal: "rpc.internal",
  /** Host relay: the method is not on the Workbench allowlist (ADR-0003). */
  rpcMethodNotAllowed: "rpc.method_not_allowed",
  /** Host relay: no reply within the relay timeout. */
  rpcTimeout: "rpc.timeout",
  /** Host relay: the runtime is not running or not yet initialised. */
  runtimeUnavailable: "runtime.unavailable",
  runtimeProtocolMismatch: "runtime.protocol_mismatch",
  runtimeNotInitialized: "runtime.not_initialized",
  runtimeAlreadyInitialized: "runtime.already_initialized",
  runtimeShuttingDown: "runtime.shutting_down",
  /** The path resolves outside every workspace root, including through a link (SECURITY.md 5.2). */
  fsOutsideWorkspace: "fs.outside_workspace",
  /** The path is malformed or unsafe: NUL, reserved device name, stream, trailing dot. */
  fsInvalidPath: "fs.invalid_path",
  fsNotFound: "fs.not_found",
  fsNotAFile: "fs.not_a_file",
  fsNotADirectory: "fs.not_a_directory",
  fsAlreadyExists: "fs.already_exists",
  /** The file changed since it was read; the write was refused (HARNESS 6, FR-052). */
  fsConflict: "fs.conflict",
  fsTooLarge: "fs.too_large",
  /** The file is not text, so it cannot be read or written as text. */
  fsBinary: "fs.binary",
  fsPermissionDenied: "fs.permission_denied",
  /** No project is open, so there are no files to work on. */
  fsNoProject: "fs.no_project",
  /** Any other file-system failure; details carry the OS error code. */
  fsIo: "fs.io",
  /** A database upgrade failed and was rolled back; the database is open read-only. */
  storageMigrationFailed: "storage.migration_failed",
  /** The database was written by a newer Jesutobits; it is open read-only. */
  storageNewerDatabase: "storage.newer_database",
  /** The database was unreadable after an unclean shutdown; it was moved aside. */
  storageCorruptRecovered: "storage.corrupt_recovered",
  /** The database could not be opened at all. */
  storageUnavailable: "storage.unavailable",
  /** A write was refused because the database is open read-only. */
  storageReadOnly: "storage.read_only",
  /** No JSX element starts at the requested location (the file changed, or a bad loc). */
  visualElementNotFound: "visual.element_not_found",
  /** The property cannot be edited statically, for example a computed className. */
  visualNotEditable: "visual.not_editable",
} as const satisfies Record<string, JesutobitsErrorCode>;

export const UserActionSchema = z.enum([
  "retry",
  "open_settings",
  "check_credits",
  "approve",
  "reinstall",
  "report",
]);
export type UserAction = z.infer<typeof UserActionSchema>;

// A plain regex keeps the schema representable as JSON Schema; the cast narrows the
// inferred type to the template literal, which the regex guarantees.
export const JesutobitsErrorCodeSchema = z
  .string()
  .regex(ERROR_CODE_PATTERN, "Not a valid Jesutobits error code") as unknown as z.ZodType<
  JesutobitsErrorCode,
  string
>;

/** The serialisable shape every boundary-crossing error takes (ARCHITECTURE.md section 9.1). */
export const JesutobitsErrorDataSchema = z.object({
  code: JesutobitsErrorCodeSchema,
  /** Safe for UI. Must never contain secrets. */
  message: z.string(),
  retryable: z.boolean(),
  userAction: UserActionSchema.optional(),
  /** Redacted, for the timeline "details" view. */
  details: z.record(z.string(), z.unknown()).optional(),
  /** Internal chain, redacted. */
  cause: z.object({ code: z.string().optional(), message: z.string() }).optional(),
});
export type JesutobitsErrorData = z.infer<typeof JesutobitsErrorDataSchema>;

export interface JesutobitsErrorInit extends Pick<
  JesutobitsErrorData,
  "userAction" | "details" | "cause"
> {
  retryable?: boolean;
}

/** Throwable form of {@link JesutobitsErrorData}, used by services and the runtime. */
export class JesutobitsError extends Error implements JesutobitsErrorData {
  override readonly name = "JesutobitsError";
  readonly code: JesutobitsErrorCode;
  readonly retryable: boolean;
  readonly userAction?: JesutobitsErrorData["userAction"];
  readonly details?: JesutobitsErrorData["details"];
  override readonly cause?: JesutobitsErrorData["cause"];

  constructor(code: JesutobitsErrorCode, message: string, init: JesutobitsErrorInit = {}) {
    super(message);
    this.code = code;
    this.retryable = init.retryable ?? false;
    if (init.userAction !== undefined) this.userAction = init.userAction;
    if (init.details !== undefined) this.details = init.details;
    if (init.cause !== undefined) this.cause = init.cause;
  }

  static fromData(data: JesutobitsErrorData): JesutobitsError {
    return new JesutobitsError(data.code, data.message, data);
  }

  toData(): JesutobitsErrorData {
    const data: JesutobitsErrorData = {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
    if (this.userAction !== undefined) data.userAction = this.userAction;
    if (this.details !== undefined) data.details = this.details;
    if (this.cause !== undefined) data.cause = this.cause;
    return data;
  }

  toJSON(): JesutobitsErrorData {
    return this.toData();
  }
}

export function isJesutobitsError(value: unknown): value is JesutobitsError {
  return value instanceof JesutobitsError;
}
