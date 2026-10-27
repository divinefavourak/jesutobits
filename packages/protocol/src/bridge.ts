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

/**
 * The user clicked an element in inspect mode (VISUAL_EDITING.md section 5). Only a report:
 * the inspector shows it, and edits need the user's own action in Jesutobits (invariant 8).
 */
export const BridgeSelectedSchema = z.object({
  ...envelope,
  type: z.literal("inspect.selected"),
  /** The nearest instrumented element's `data-jesutobits-loc`, `src/Hero.tsx:24:7`. */
  loc: z.string().min(5).max(1024),
  tag: z.string().min(1).max(100),
  component: z.string().max(200).nullable(),
  /** The element's class attribute as rendered. */
  className: z.string().max(4000),
  /** The start of its text, for recognising it. */
  text: z.string().max(200),
});

/** Messages the bridge may send. All of them only report; none can request an action. */
export const BridgeToWorkbenchMessageSchema = z.discriminatedUnion("type", [
  BridgeHelloSchema,
  BridgeSelectedSchema,
]);
export type BridgeToWorkbenchMessage = z.infer<typeof BridgeToWorkbenchMessageSchema>;

export const InspectSetSchema = z.object({
  ...envelope,
  type: z.literal("inspect.set"),
  enabled: z.boolean(),
});

/** Messages the Workbench may send to the bridge. */
export const WorkbenchToBridgeMessageSchema = z.discriminatedUnion("type", [InspectSetSchema]);
export type WorkbenchToBridgeMessage = z.infer<typeof WorkbenchToBridgeMessageSchema>;
