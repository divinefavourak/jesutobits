import { z } from "zod";
import { JesutobitsErrorDataSchema } from "./errors.js";

/**
 * JSON-RPC 2.0 envelope, one message per line (NDJSON) over stdio (ADR-0003).
 * The Host parses only `jsonrpc`, `id` and `method`; payloads are validated by the receiver.
 */
export const JSONRPC_VERSION = "2.0";

/** ADR-0003 decision 7: larger payloads are paged by the method, never fragmented. */
export const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

/** Standard JSON-RPC codes, plus one application code whose `data` is a JesutobitsError. */
export const RpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  /** A method ran and failed. `error.data` carries the JesutobitsError. */
  ApplicationError: -32000,
} as const;

export const RequestIdSchema = z.union([z.string().min(1).max(128), z.number().int()]);
export type RequestId = z.infer<typeof RequestIdSchema>;

export const MethodNameSchema = z
  .string()
  .regex(/^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)+$/, "Method names are dotted camelCase");

/** Jesutobits uses named params only, so `params` is an object when present. */
export const ParamsSchema = z.record(z.string(), z.unknown());

const jsonrpc = z.literal(JSONRPC_VERSION);

export const RpcRequestSchema = z.object({
  jsonrpc,
  id: RequestIdSchema,
  method: MethodNameSchema,
  params: ParamsSchema.optional(),
});
export type RpcRequest = z.infer<typeof RpcRequestSchema>;

export const RpcNotificationSchema = z.object({
  jsonrpc,
  method: MethodNameSchema.or(z.literal("event")),
  params: ParamsSchema.optional(),
});
export type RpcNotification = z.infer<typeof RpcNotificationSchema>;

export const RpcErrorObjectSchema = z.object({
  code: z.number().int(),
  message: z.string(),
  data: JesutobitsErrorDataSchema.optional(),
});
export type RpcErrorObject = z.infer<typeof RpcErrorObjectSchema>;

export const RpcSuccessSchema = z
  .object({ jsonrpc, id: RequestIdSchema, result: z.unknown() })
  .refine((m) => "result" in m, { message: "Missing result" });
export type RpcSuccess = z.infer<typeof RpcSuccessSchema>;

export const RpcFailureSchema = z.object({
  jsonrpc,
  /** `null` only when the request id could not be read (parse error, invalid request). */
  id: RequestIdSchema.nullable(),
  error: RpcErrorObjectSchema,
});
export type RpcFailure = z.infer<typeof RpcFailureSchema>;

export type RpcResponse = RpcSuccess | RpcFailure;
export type RpcMessage = RpcRequest | RpcNotification | RpcResponse;

export type ClassifiedMessage =
  | { kind: "request"; message: RpcRequest }
  | { kind: "notification"; message: RpcNotification }
  | { kind: "success"; message: RpcSuccess }
  | { kind: "failure"; message: RpcFailure }
  | { kind: "invalid"; id: RequestId | null; issues: string };

function readId(value: unknown): RequestId | null {
  if (typeof value !== "object" || value === null || !("id" in value)) return null;
  const parsed = RequestIdSchema.safeParse(value.id);
  return parsed.success ? parsed.data : null;
}

/** Sorts an already-parsed JSON value into the envelope kinds, without validating params. */
export function classifyMessage(value: unknown): ClassifiedMessage {
  const isObject = typeof value === "object" && value !== null && !Array.isArray(value);
  if (isObject && "method" in value && "id" in value) {
    const parsed = RpcRequestSchema.safeParse(value);
    if (parsed.success) return { kind: "request", message: parsed.data };
    return { kind: "invalid", id: readId(value), issues: z.prettifyError(parsed.error) };
  }
  if (isObject && "method" in value) {
    const parsed = RpcNotificationSchema.safeParse(value);
    if (parsed.success) return { kind: "notification", message: parsed.data };
    return { kind: "invalid", id: null, issues: z.prettifyError(parsed.error) };
  }
  if (isObject && "error" in value) {
    const parsed = RpcFailureSchema.safeParse(value);
    if (parsed.success) return { kind: "failure", message: parsed.data };
    return { kind: "invalid", id: readId(value), issues: z.prettifyError(parsed.error) };
  }
  if (isObject && "result" in value) {
    const parsed = RpcSuccessSchema.safeParse(value);
    if (parsed.success) return { kind: "success", message: parsed.data };
    return { kind: "invalid", id: readId(value), issues: z.prettifyError(parsed.error) };
  }
  return { kind: "invalid", id: readId(value), issues: "Not a JSON-RPC 2.0 message" };
}
