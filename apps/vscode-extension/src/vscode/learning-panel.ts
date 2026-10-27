// The Learning Centre as an editor tab in the middle, as in the Studio design: short lessons
// on the user's own project. Same webview rules as the other panels (invariant 4).
import * as vscode from "vscode";
import { handlePanelMessage, type PanelServices } from "../host/panel-messages.js";
import { webviewHtml } from "./agent-view.js";

export class LearningPanel {
  readonly #extensionUri: vscode.Uri;
  readonly #services: PanelServices;
  #panel: vscode.WebviewPanel | undefined;

  constructor(extensionUri: vscode.Uri, services: PanelServices) {
    this.#extensionUri = extensionUri;
    this.#services = services;
  }

  /** Opens the tab in the active editor group, or brings it forward. */
  show(): void {
    if (this.#panel) {
      this.#panel.reveal();
      return;
    }
    const root = vscode.Uri.joinPath(this.#extensionUri, "dist", "webview");
    const panel = vscode.window.createWebviewPanel(
      "jesutobits.learning",
      "Learn",
      vscode.ViewColumn.Active,
      { enableScripts: true, localResourceRoots: [root], retainContextWhenHidden: true },
    );
    panel.iconPath = vscode.Uri.joinPath(this.#extensionUri, "media", "jesutobits.svg");
    panel.webview.html = webviewHtml(panel.webview, root, {
      entry: "learn",
      title: "Jesutobits Learning Centre",
    });
    panel.webview.onDidReceiveMessage(async (data: unknown) => {
      const outcome = await handlePanelMessage(data, this.#services);
      if (outcome && outcome.kind !== "ready") void panel.webview.postMessage(outcome);
    });
    panel.onDidDispose(() => {
      if (this.#panel === panel) this.#panel = undefined;
    });
    this.#panel = panel;
  }
}
