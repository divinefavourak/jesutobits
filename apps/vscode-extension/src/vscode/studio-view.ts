// The Studio sidebar (Figma Make "Jesutobits AI Coding Workspace", the Studio's left column):
// a webview view in the Explorer side bar with New project, Recent projects, the Learning
// Centre, the "Big ideas start small" card and the agent's real state. Same rules as the agent
// view (invariant 4): only postMessage, every message checked by handlePanelMessage.
import type { HostToWebview, Project, RuntimeStatusUpdate } from "@jesutobits/protocol";
import * as vscode from "vscode";
import { handlePanelMessage, type PanelServices } from "../host/panel-messages.js";
import { webviewHtml } from "./agent-view.js";

export const STUDIO_VIEW_ID = "jesutobits.studio";

export class StudioViewProvider implements vscode.WebviewViewProvider {
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
    view.webview.html = webviewHtml(view.webview, root, {
      entry: "studio",
      title: "Jesutobits Studio",
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
    });
    view.onDidDispose(() => {
      if (this.#view === view) this.#view = undefined;
    });
  }

  /** Sends to the view if it is open; a closed view catches up on its next "ready". */
  post(message: HostToWebview): void {
    void this.#view?.webview.postMessage(message);
  }
}
