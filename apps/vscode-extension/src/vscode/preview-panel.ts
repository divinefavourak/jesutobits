// The preview panel (ROADMAP Phases 4 and 5): an editor tab beside the code with the running
// app in an iframe, a toolbar, and the visual-editing inspector. Same rules as the agent view
// (invariant 4): only postMessage, every message schema-checked by handlePanelMessage. The
// app inside the iframe is untrusted (invariant 8); its bridge reaches only this webview's
// script, which checks origin and nonce, and nothing it sends can write or approve.
import type { HostToWebview, RuntimeStatusUpdate } from "@jesutobits/protocol";
import * as vscode from "vscode";
import { handlePanelMessage, type PanelServices } from "../host/panel-messages.js";
import { webviewHtml } from "./agent-view.js";

/** Dev servers bind loopback only (PreviewManager). */
const PREVIEW_FRAMES = ["http://127.0.0.1:*", "http://localhost:*"];

export class PreviewPanel {
  readonly #extensionUri: vscode.Uri;
  readonly #services: PanelServices;
  readonly #status: () => RuntimeStatusUpdate;
  #panel: vscode.WebviewPanel | undefined;

  constructor(
    extensionUri: vscode.Uri,
    services: PanelServices,
    status: () => RuntimeStatusUpdate,
  ) {
    this.#extensionUri = extensionUri;
    this.#services = services;
    this.#status = status;
  }

  get isOpen(): boolean {
    return this.#panel !== undefined;
  }

  /** Opens the panel beside the editor, or brings it forward. */
  show(): void {
    if (this.#panel) {
      this.#panel.reveal(vscode.ViewColumn.Beside, true);
      return;
    }
    const root = vscode.Uri.joinPath(this.#extensionUri, "dist", "webview");
    const panel = vscode.window.createWebviewPanel(
      "jesutobits.preview",
      "Preview",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, localResourceRoots: [root], retainContextWhenHidden: true },
    );
    panel.iconPath = vscode.Uri.joinPath(this.#extensionUri, "media", "jesutobits.svg");
    panel.webview.html = webviewHtml(panel.webview, root, {
      entry: "preview",
      title: "Jesutobits Preview",
      frames: PREVIEW_FRAMES,
    });
    panel.webview.onDidReceiveMessage(async (data: unknown) => {
      const outcome = await handlePanelMessage(data, this.#services);
      if (!outcome) return;
      if (outcome.kind === "ready") this.post({ kind: "status", update: this.#status() });
      else this.post(outcome);
    });
    panel.onDidDispose(() => {
      if (this.#panel === panel) this.#panel = undefined;
    });
    this.#panel = panel;
  }

  post(message: HostToWebview): void {
    void this.#panel?.webview.postMessage(message);
  }
}
