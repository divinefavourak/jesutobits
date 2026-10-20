import {
  BRIDGE_PROTOCOL,
  BridgeToWorkbenchMessageSchema,
  type BridgeToWorkbenchMessage,
  type WorkbenchToBridgeMessage,
} from "@jesutobits/protocol";

/**
 * The Workbench end of the preview bridge (ADR-0010, VISUAL_EDITING.md section 9).
 * A message is accepted only if it comes from the preview iframe's own window, from the
 * exact preview origin, matches the schema, and carries this session's nonce. Everything
 * the bridge says is untrusted data; nothing here can trigger a privileged action.
 */

export type RejectReason = "source" | "origin" | "schema" | "nonce";

export interface ExpectedSender {
  /** The preview iframe's `contentWindow`. */
  window: unknown;
  /** Exact origin, for example `http://127.0.0.1:5173`. */
  origin: string;
  nonce: string;
}

export interface IncomingMessage {
  source: unknown;
  origin: string;
  data: unknown;
}

export type AcceptResult =
  { accepted: true; message: BridgeToWorkbenchMessage } | { accepted: false; reason: RejectReason };

export function acceptBridgeMessage(
  event: IncomingMessage,
  expected: ExpectedSender,
): AcceptResult {
  if (event.source !== expected.window) return { accepted: false, reason: "source" };
  if (event.origin !== expected.origin) return { accepted: false, reason: "origin" };
  const parsed = BridgeToWorkbenchMessageSchema.safeParse(event.data);
  if (!parsed.success) return { accepted: false, reason: "schema" };
  if (parsed.data.nonce !== expected.nonce) return { accepted: false, reason: "nonce" };
  return { accepted: true, message: parsed.data };
}

/** 128 random bits as hex, matching `BridgeNonceSchema`. */
export function createBridgeNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Distributes the `Omit` over each message type in the union. */
type WithoutEnvelope<T> = T extends unknown ? Omit<T, "jesutobits" | "nonce"> : never;

export interface PreviewFrameChannel {
  send(message: WithoutEnvelope<WorkbenchToBridgeMessage>): void;
  readonly rejected: Readonly<Record<RejectReason, number>>;
  dispose(): void;
}

export function connectPreviewFrame(options: {
  frame: HTMLIFrameElement;
  origin: string;
  nonce: string;
  onMessage(message: BridgeToWorkbenchMessage): void;
}): PreviewFrameChannel {
  const rejected: Record<RejectReason, number> = { source: 0, origin: 0, schema: 0, nonce: 0 };

  const listener = (event: MessageEvent) => {
    const result = acceptBridgeMessage(event, {
      window: options.frame.contentWindow,
      origin: options.origin,
      nonce: options.nonce,
    });
    if (result.accepted) options.onMessage(result.message);
    else rejected[result.reason] += 1;
  };
  window.addEventListener("message", listener);

  return {
    send(message) {
      // Exact target origin, never "*": if the frame has navigated elsewhere, nothing is sent.
      options.frame.contentWindow?.postMessage(
        { ...message, jesutobits: BRIDGE_PROTOCOL, nonce: options.nonce },
        options.origin,
      );
    },
    rejected,
    dispose: () => window.removeEventListener("message", listener),
  };
}
