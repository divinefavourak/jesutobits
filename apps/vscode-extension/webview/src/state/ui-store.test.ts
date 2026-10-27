import { describe, expect, it } from "vitest";
import { MockHostBridge } from "../host-bridge";
import { createUiStore } from "./ui-store";

describe("ui store", () => {
  it("composes from the extension's request and focuses the box, never sending", () => {
    const bridge = new MockHostBridge();
    const ui = createUiStore(bridge);

    bridge.requestCompose("About the <button> in src/App.tsx:4:7: ");

    expect(ui.getState().draft).toBe("About the <button> in src/App.tsx:4:7: ");
    expect(ui.getState().focusComposerRequest).toBe(1);
  });

  it("keeps what the user already typed after the element's context", () => {
    const bridge = new MockHostBridge();
    const ui = createUiStore(bridge);
    ui.getState().setDraft("make it bigger");

    ui.getState().compose("About the <h1>: ");

    expect(ui.getState().draft).toBe("About the <h1>: \n\nmake it bigger");
  });
});
