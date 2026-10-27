// The agent panel: a webview view running the React panel from dist/webview (ADR-0015). It
// gets no Node or VS Code API, only `postMessage`, a CSP that allows nothing but its own
// script (by nonce) and stylesheet, and the extension's dist/webview folder as its only
// resource root (invariant 4, NFR-008).
import { randomBytes } from "node:crypto";
import type { HostToWebview, Project, RuntimeStatusUpdate } from "@jesutobits/protocol";
import * as vscode from "vscode";
import { handlePanelMessage, type PanelServices } from "../host/panel-messages.js";

export const AGENT_VIEW_ID = "jesutobits.agent";

export class AgentViewProvider implements vscode.WebviewViewProvider {
  readonly #extensionUri: vscode.Uri;
  readonly #services: PanelServices;
  readonly #current: () => { status: RuntimeStatusUpdate; project: Project | null };
  #view: vscode.WebviewView | undefined;

  constructor(
    extensionUri: vscode.Uri,
    services: PanelServices,
    current: () => { status: RuntimeStatusUpdate; project: Project | null },
  ) {
    this.#extensionUri = extensionUri;
    this.#services = services;
    this.#current = current;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.#view = view;
    const root = vscode.Uri.joinPath(this.#extensionUri, "dist", "webview");
    view.webview.options = { enableScripts: true, localResourceRoots: [root] };
    view.webview.html = panelHtml(view.webview, root);
    view.webview.onDidReceiveMessage(async (data: unknown) => {
      const outcome = await handlePanelMessage(data, this.#services);
      if (!outcome) return;
      if (outcome.kind !== "ready") {
        this.post(outcome);
        return;
      }
      const { status, project } = this.#current();
      this.post({ kind: "status", update: status });
      this.post({ kind: "project", project });
    });
    view.onDidDispose(() => {
      if (this.#view === view) this.#view = undefined;
    });
  }

  /** Sends to the panel if it is open; a closed panel catches up on its next "ready". */
  post(message: HostToWebview): void {
    void this.#view?.webview.postMessage(message);
  }
}

function panelHtml(webview: vscode.Webview, root: vscode.Uri): string {
  const nonce = randomBytes(18).toString("base64");
  const script = webview.asWebviewUri(vscode.Uri.joinPath(root, "main.js"));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(root, "main.css"));
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource}`,
    `font-src ${webview.cspSource}`,
    `img-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${style.toString()}">
<title>Jesutobits Agent</title>
</head>
<body>
<div id="root"></div>
<script type="module" nonce="${nonce}" src="${script.toString()}"></script>
</body>
</html>`;
}
