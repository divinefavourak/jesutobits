import { z } from "zod";

/**
 * Workbench <-> preview bridge messages over `window.postMessage` (VISUAL_EDITING.md
 * section 9, ADR-0010). Every message carries `{ jesutobits: 1, type, nonce }`. The
 * receiver checks the exact sender origin, the per-preview-session nonce and this schema;
 * anything else is dropped. Types are added here as the bridge grows (Phases 4 and 5).
 */
export const BRIDGE_PROTOCOL = 1;

/** A per-preview-session secret: 128 random bits as 32 lowercase hex characters. */
export const BridgeNonceSchema = z.string().regex(/^[0-9a-f]{32}$/);

const envelope = { jesutobits: z.literal(BRIDGE_PROTOCOL), nonce: BridgeNonceSchema };

/** The bridge has booted inside the preview. */
export const BridgeHelloSchema = z.object({
  ...envelope,
  type: z.literal("bridge.hello"),
  version: z.string().min(1).max(64),
  url: z.string().max(2048),
});

/** Messages the bridge may send. All of them only report; none can request an action. */
export const BridgeToWorkbenchMessageSchema = z.discriminatedUnion("type", [BridgeHelloSchema]);
export type BridgeToWorkbenchMessage = z.infer<typeof BridgeToWorkbenchMessageSchema>;

export const InspectSetSchema = z.object({
  ...envelope,
  type: z.literal("inspect.set"),
  enabled: z.boolean(),
});

/** Messages the Workbench may send to the bridge. */
export const WorkbenchToBridgeMessageSchema = z.discriminatedUnion("type", [InspectSetSchema]);
export type WorkbenchToBridgeMessage = z.infer<typeof WorkbenchToBridgeMessageSchema>;
