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
  /** The Host refused a second folder dialog while one is open. */
  runtimeDialogOpen: "runtime.dialog_open",
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
  /** The OS refused to move the path to the trash (ADR-0014); it was left in place. */
  fsTrashFailed: "fs.trash_failed",
  /** The OS file manager could not be opened at the path (`fs.reveal`). */
  fsRevealFailed: "fs.reveal_failed",
  /** No project is open, so there are no files to work on. */
  fsNoProject: "fs.no_project",
  /** Any other file-system failure; details carry the OS error code. */
  fsIo: "fs.io",
  /** The program is not installed or not on PATH. */
  processNotFound: "process.not_found",
  /** The program could not be started (permissions, a broken shim). */
  processSpawnFailed: "process.spawn_failed",
  /** The command ran longer than its timeout and was stopped. */
  processTimeout: "process.timeout",
  /** The command was cancelled and stopped. */
  processCancelled: "process.cancelled",
  /** The command line is malformed (empty argv, NUL, a working folder outside the project). */
  processInvalidCommand: "process.invalid_command",
  /** A database upgrade failed and was rolled back; the database is open read-only. */
  storageMigrationFailed: "storage.migration_failed",
  /** The database was written by a newer Jesutobits; it is open read-only. */
  storageNewerDatabase: "storage.newer_database",
  /** The database was unreadable after an unclean shutdown; it was moved aside. */
  storageCorruptRecovered: "storage.corrupt_recovered",
  /** The database could not be opened at all. */
  storageUnavailable: "storage.unavailable",
  /** A settings or UI-state update failed validation (the Host's settings store). */
  storageInvalidSettings: "storage.invalid_settings",
  /** A settings file could not be written. */
  storageWriteFailed: "storage.write_failed",
  /** Startup notice: settings.json is from a newer version and is read-only. */
  storageSettingsNewer: "storage.settings_newer",
  /** Startup notice: settings.json could not be read and was moved aside. */
  storageSettingsCorrupt: "storage.settings_corrupt",
  /** A write was refused because the database is open read-only. */
  storageReadOnly: "storage.read_only",
  /** No session with that ID in the active project. */
  runtimeSessionNotFound: "runtime.session_not_found",
  /** No turn with that ID, or it belongs to another project. */
  runtimeTurnNotFound: "runtime.turn_not_found",
  /** The session already has a turn running; one turn at a time per session. */
  runtimeTurnActive: "runtime.turn_active",
  /** The request does not fit the turn's state, for example resuming a turn not paused. */
  runtimeTurnState: "runtime.turn_state",
  /** No open question with that ID (answered, or closed with its turn). */
  runtimeQuestionNotPending: "runtime.question_not_pending",
  /** A limit from AGENT_HARNESS.md section 3.4 ended the turn. */
  runtimeLimitReached: "runtime.limit_reached",
  /** The loop guard stopped the turn (AGENT_HARNESS.md section 3.6). */
  runtimeLoopDetected: "runtime.loop_detected",
  /** No pending approval with that ID: answered, expired or never issued (SECURITY.md 4.5). */
  permissionNotPending: "permission.not_pending",
  /** The answer is not one the request offered. */
  permissionInvalidDecision: "permission.invalid_decision",
  /** The provider rejected the key (HTTP 401), also after fetching it again. */
  providerAuth: "provider.auth",
  /** No key is stored for the provider. */
  providerNoCredentials: "provider.no_credentials",
  providerInsufficientCredits: "provider.insufficient_credits",
  providerRateLimited: "provider.rate_limited",
  providerContextLength: "provider.context_length",
  providerInvalidRequest: "provider.invalid_request",
  providerContentFilter: "provider.content_filter",
  providerUnavailable: "provider.unavailable",
  providerTimeout: "provider.timeout",
  providerNetwork: "provider.network",
  providerUnknown: "provider.unknown",
  /** No model was chosen and settings name no default. */
  providerNoModel: "provider.no_model",
  /** The model cannot call tools, so it can only be used in Ask mode (HARNESS 2.3). */
  providerModelUnsupported: "provider.model_unsupported",
  /** A checkpoint's stored copy is missing, so the file cannot be restored. */
  storageCheckpointMissing: "storage.checkpoint_missing",
  /** The OS credential store is not available (DATA_AND_PERSISTENCE.md section 2). */
  storageSecretsUnavailable: "storage.secrets_unavailable",
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
