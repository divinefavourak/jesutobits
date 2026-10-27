import {
  BRIDGE_PROTOCOL,
  BridgeToWorkbenchMessageSchema,
  type BridgeToWorkbenchMessage,
  type WorkbenchToBridgeMessage,
} from "@jesutobits/protocol";

/** A per-preview-session secret (protocol bridge.ts): 128 random bits as hex. */
export function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The webview's side of the preview bridge (ADR-0010, VISUAL_EDITING.md section 9). The
 * preview is untrusted: a message counts only if it comes from this iframe's window and exact
 * origin, carries this session's nonce and matches the schema. The bridge can only report.
 */
export class BridgeClient {
  readonly #nonce = newNonce();
  readonly #frame: HTMLIFrameElement;
  readonly #origin: string;
  readonly #onMessage: (message: BridgeToWorkbenchMessage) => void;
  readonly #listener = (event: MessageEvent) => this.#receive(event);

  constructor(
    frame: HTMLIFrameElement,
    url: string,
    onMessage: (message: BridgeToWorkbenchMessage) => void,
  ) {
    this.#frame = frame;
    this.#origin = new URL(url).origin;
    this.#onMessage = onMessage;
    window.addEventListener("message", this.#listener);
  }

  /** Turns inspect mode on or off; also hands the bridge the session nonce. */
  setInspect(enabled: boolean): void {
    this.#send({ jesutobits: BRIDGE_PROTOCOL, nonce: this.#nonce, type: "inspect.set", enabled });
  }

  dispose(): void {
    window.removeEventListener("message", this.#listener);
  }

  #send(message: WorkbenchToBridgeMessage): void {
    this.#frame.contentWindow?.postMessage(message, this.#origin);
  }

  #receive(event: MessageEvent): void {
    if (event.source !== this.#frame.contentWindow || event.origin !== this.#origin) return;
    const parsed = BridgeToWorkbenchMessageSchema.safeParse(event.data);
    if (!parsed.success || parsed.data.nonce !== this.#nonce) return;
    this.#onMessage(parsed.data);
  }
}
