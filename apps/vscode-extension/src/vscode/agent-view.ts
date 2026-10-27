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
  /** Text to compose once the view has loaded (it may not have been opened yet). */
  #pendingCompose: string | undefined;
  /** The theme picker was asked for before the view loaded. */
  #pendingLook = false;

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
    view.webview.html = webviewHtml(view.webview, root, {
      entry: "main",
      title: "Jesutobits Agent",
    });
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
      if (this.#pendingCompose !== undefined) {
        this.post({ kind: "compose", text: this.#pendingCompose });
        this.#pendingCompose = undefined;
      }
      if (this.#pendingLook) {
        this.post({ kind: "openLook" });
        this.#pendingLook = false;
      }
    });
    view.onDidDispose(() => {
      if (this.#view === view) this.#view = undefined;
    });
  }

  /** Fills the message box, now or as soon as the view has loaded. */
  openLook(): void {
    if (this.#view) this.post({ kind: "openLook" });
    else this.#pendingLook = true;
  }

  compose(text: string): void {
    if (this.#view) this.post({ kind: "compose", text });
    else this.#pendingCompose = text;
  }

  /** Sends to the panel if it is open; a closed panel catches up on its next "ready". */
  post(message: HostToWebview): void {
    void this.#view?.webview.postMessage(message);
  }
}

/**
 * The HTML of a Jesutobits webview: one script (by nonce) and one stylesheet from `root`, and
 * nothing else. `frames` adds frame sources, for the preview's loopback dev server only.
 */
/** Body text and headings (webview/src/styles/fonts.css), as emitted to dist/webview. */
const PRELOADED_FONTS = ["dm-sans-400", "dm-sans-500", "space-grotesk-500"];

export function webviewHtml(
  webview: vscode.Webview,
  root: vscode.Uri,
  options: { entry: string; title: string; frames?: string[] },
): string {
  const nonce = randomBytes(18).toString("base64");
  const script = webview.asWebviewUri(vscode.Uri.joinPath(root, `${options.entry}.js`));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(root, `${options.entry}.css`));
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource}`,
    `font-src ${webview.cspSource}`,
    `img-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
    ...(options.frames ? [`frame-src ${options.frames.join(" ")}`] : []),
  ].join("; ");
  // The weights every panel paints first, fetched with the stylesheet rather than after it,
  // so the first paint is already in the Studio fonts (no visible swap).
  const preloads = PRELOADED_FONTS.map((name) => {
    const font = webview.asWebviewUri(vscode.Uri.joinPath(root, `${name}.woff2`));
    return `<link rel="preload" href="${font.toString()}" as="font" type="font/woff2" crossorigin>`;
  }).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
${preloads}
<link rel="stylesheet" href="${style.toString()}">
<title>${options.title}</title>
</head>
<body>
<div id="root"></div>
<script type="module" nonce="${nonce}" src="${script.toString()}"></script>
</body>
</html>`;
}
