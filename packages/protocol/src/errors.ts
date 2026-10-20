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
  runtimeProtocolMismatch: "runtime.protocol_mismatch",
  runtimeNotInitialized: "runtime.not_initialized",
  runtimeAlreadyInitialized: "runtime.already_initialized",
  runtimeShuttingDown: "runtime.shutting_down",
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
