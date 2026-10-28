import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { posix } from "node:path";
import type { WorkspaceService } from "../workspace/workspace-service.js";

/** Live reload: the injected script listens here for "files changed". */
const RELOAD_PATH = "/__jesutobits/reload";
const RELOAD_SCRIPT = `<script>(() => { const events = new EventSource(${JSON.stringify(RELOAD_PATH)}); events.onmessage = () => location.reload(); })();</script>`;
/** Larger files are not served; a site's assets are far smaller. */
const MAX_FILE_BYTES = 50 * 1024 * 1024;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
};

export interface StaticServer {
  url: string;
  /** Project files changed: open pages reload. */
  reload(): void;
  close(): Promise<void>;
}

/**
 * Serves a plain site (an `index.html` with its CSS, JS and assets) for the preview, on a
 * loopback port only. Every file is read through WorkspaceService, so nothing outside the
 * project is reachable; files under a dot-folder (`.git`) and those `isSecret` names
 * (secret-pattern files, SECURITY.md section 6.2) are never served. HTML pages get a small
 * script that reloads them when project files change.
 */
export async function startStaticServer(
  workspace: WorkspaceService,
  root: string,
  port: number,
  isSecret: (relative: string) => boolean,
): Promise<StaticServer> {
  const listeners = new Set<ServerResponse>();

  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method !== "GET" && request.method !== "HEAD") {
        return plain(response, 405, "Only GET is served.");
      }
      if (url.pathname === RELOAD_PATH) {
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store",
          Connection: "keep-alive",
        });
        response.write(": connected\n\n");
        listeners.add(response);
        request.on("close", () => listeners.delete(response));
        return;
      }
      let requested: string;
      try {
        requested = decodeURIComponent(url.pathname);
      } catch {
        return plain(response, 400, "Bad address.");
      }
      const file = await resolveFile(workspace, root, requested);
      if (!file) return plain(response, 404, `Not found: ${requested}`);
      if (isSecret(file) || isHidden(file)) {
        return plain(
          response,
          403,
          "Jesutobits does not serve hidden or secret files in the preview.",
        );
      }
      const snapshot = await workspace.snapshot(file, MAX_FILE_BYTES).catch(() => null);
      if (!snapshot) return plain(response, 404, `Not found: ${requested}`);
      const type = TYPES[posix.extname(file).toLowerCase()] ?? "application/octet-stream";
      let body: Buffer = Buffer.from(snapshot.bytes);
      if (type.startsWith("text/html")) body = Buffer.from(withReload(body.toString("utf8")));
      response.writeHead(200, {
        "Content-Type": type,
        "Content-Length": body.length,
        "Cache-Control": "no-store",
      });
      response.end(request.method === "HEAD" ? undefined : body);
    })().catch(() => {
      if (!response.headersSent) plain(response, 500, "The file could not be read.");
      else response.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}/`,
    reload: () => {
      for (const listener of listeners) listener.write("data: reload\n\n");
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const listener of listeners) listener.end();
        listeners.clear();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/**
 * The project file for a request: `/` and folders serve their `index.html`, and `/about`
 * finds `about.html`. Undefined when nothing matches. Paths stay relative to `root`;
 * WorkspaceService refuses anything that escapes the project.
 */
async function resolveFile(
  workspace: WorkspaceService,
  root: string,
  requested: string,
): Promise<string | undefined> {
  const inside = posix.normalize(`/${requested}`).slice(1);
  const base = root === "" ? inside : posix.join(root, inside);
  const candidates = [base, posix.join(base, "index.html"), `${base}.html`];
  for (const candidate of candidates) {
    const relative = candidate.replace(/^\/+|\/+$/g, "");
    const info = await workspace.stat(relative === "" ? "." : relative).catch(() => undefined);
    if (info?.kind === "file") return relative;
  }
  return undefined;
}

/** `.git/config` and other dot-folders can hold credentials; `.well-known` is public. */
function isHidden(relative: string): boolean {
  return relative.split("/").some((part) => part.startsWith(".") && part !== ".well-known");
}

function withReload(html: string): string {
  const at = html.toLowerCase().lastIndexOf("</body>");
  return at === -1 ? html + RELOAD_SCRIPT : html.slice(0, at) + RELOAD_SCRIPT + html.slice(at);
}

function plain(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  response.end(message);
}
