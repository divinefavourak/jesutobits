import { get } from "node:http";
import type { PreviewStatus } from "@jesutobits/protocol";
import { nullLogger } from "@jesutobits/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PreviewManager } from "./preview-manager.js";
import { openToolTestProject, type ToolTestProject } from "../../test/tool-context.js";

/** A dev server that announces its address the way Vite does. */
const SERVER = `
const http = require("node:http");
const port = Number(process.env.PORT);
http.createServer((req, res) => res.end("hello")).listen(port, "127.0.0.1", () => {
  console.log("  VITE ready");
  console.log("  Local:   http://localhost:" + port + "/");
});
`;

let project: ToolTestProject;
let manager: PreviewManager;
let statuses: PreviewStatus[];

beforeEach(async () => {
  project = await openToolTestProject();
  statuses = [];
  saved = [];
  manager = new PreviewManager({
    guestDir: undefined,
    emit: (status) => statuses.push(status),
    mask: (text) => text.replaceAll("sk-or-secret", "[REDACTED]"),
    log: nullLogger,
  });
});

afterEach(async () => {
  await manager.stop();
  project.dispose();
});

let saved: string[][] = [];
const start = (trusted = true, extra: { savedCommand?: string[]; command?: string[] } = {}) =>
  manager.start(
    {
      id: "prj_1",
      root: project.root,
      trusted,
      workspace: project.workspace,
      index: project.index,
      ...(extra.savedCommand && { savedCommand: extra.savedCommand }),
      saveCommand: (command) => saved.push(command),
    },
    extra.command ? { command: extra.command } : {},
  );

const fetchText = (url: string) =>
  new Promise<string>((resolve, reject) => {
    get(url, (response) => {
      let body = "";
      response.on("data", (chunk) => (body += chunk));
      response.on("end", () => resolve(body));
    }).on("error", reject);
  });

const fetchStatus = (url: string) =>
  new Promise<number>((resolve, reject) => {
    get(url, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    }).on("error", reject);
  });

describe("PreviewManager", () => {
  it("runs the dev script on a loopback port and reports ready once it answers", async () => {
    project.write(
      "package.json",
      JSON.stringify({ name: "app", scripts: { dev: "node server.js" } }),
    );
    project.write("server.js", SERVER);

    const status = await start();

    expect(status.state).toBe("ready");
    expect(status.strategy).toBe("generic");
    expect(status.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(await fetchText(status.url!)).toBe("hello");
    expect(statuses.map((s) => s.state)).toEqual(["starting", "ready"]);
    expect(manager.status("prj_1").state).toBe("ready");
    expect(manager.status("prj_other").state).toBe("stopped");

    // Starting again joins the running preview.
    expect((await start()).url).toBe(status.url);

    await manager.stop();
    expect(manager.status("prj_1").state).toBe("stopped");
    await expect(fetchText(status.url!)).rejects.toThrow();
  }, 60_000);

  it("fails with the dev server's last output, secrets masked, when it exits", async () => {
    project.write(
      "package.json",
      JSON.stringify({
        name: "app",
        scripts: { dev: "node -e \"console.log('token sk-or-secret'); process.exit(1)\"" },
      }),
    );

    const status = await start();

    expect(status.state).toBe("failed");
    expect(status.detail).toMatch(/stopped|did not/);
    expect(status.log.join("\n")).toContain("[REDACTED]");
    expect(status.log.join("\n")).not.toContain("sk-or-secret");
  }, 60_000);

  it("refuses a project with nothing to run", async () => {
    project.write("package.json", JSON.stringify({ name: "app", scripts: { test: "x" } }));
    await expect(start()).rejects.toMatchObject({ code: "preview.unavailable" });
  });

  it("never runs anything in Restricted Mode", async () => {
    project.write(
      "package.json",
      JSON.stringify({ name: "app", scripts: { dev: "node server.js" } }),
    );
    await expect(start(false)).rejects.toMatchObject({ code: "preview.restricted" });
    expect(statuses).toEqual([]);
  });

  it("serves a plain site with live reload, and never its secret or hidden files", async () => {
    project.write("index.html", "<html><body><h1>Hi</h1></body></html>");
    project.write("about.html", "<p>About</p>");
    project.write("style.css", "h1 { color: red; }");
    project.write(".env", "TOKEN=sk-or-secret");
    project.write(".git/config", "[remote] url = https://token@example.com");

    const status = await start();

    expect(status).toMatchObject({ state: "ready", strategy: "static", command: "." });
    const page = await fetchText(status.url!);
    expect(page).toContain("<h1>Hi</h1>");
    expect(page).toContain("/__jesutobits/reload");
    expect(await fetchText(`${status.url}style.css`)).toBe("h1 { color: red; }");
    expect(await fetchText(`${status.url}about`)).toContain("About");
    expect(await fetchStatus(`${status.url}.env`)).toBe(403);
    expect(await fetchStatus(`${status.url}.git/config`)).toBe(403);
    expect(await fetchStatus(`${status.url}..%2F..%2Fsecret.txt`)).toBe(404);
    expect(await fetchStatus(`${status.url}missing.png`)).toBe(404);

    // Open pages hear about file changes.
    const reloaded = new Promise<string>((resolve, reject) => {
      get(`${status.url}__jesutobits/reload`, (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += chunk;
          if (body.includes("data: reload")) {
            resolve(body);
            response.destroy();
          }
        });
        manager.filesChanged("prj_1");
        setTimeout(() => manager.filesChanged("prj_1"), 50);
      }).on("error", reject);
    });
    expect(await reloaded).toContain("data: reload");
  });

  it("finds a site in public/ when there is no dev script", async () => {
    project.write("package.json", JSON.stringify({ name: "site", scripts: { test: "x" } }));
    project.write("public/index.html", "<p>Public</p>");
    const status = await start();
    expect(status).toMatchObject({ strategy: "static", command: "public" });
    expect(await fetchText(status.url!)).toContain("Public");
  });

  it("runs a given start command, saves it, and finds a backend's 'port N' line", async () => {
    project.write(
      "api.js",
      `require("node:http").createServer((q, r) => r.end("api")).listen(Number(process.env.PORT), "127.0.0.1", () => console.log("Server listening on port " + process.env.PORT));`,
    );

    const status = await start(true, { command: ["node", "api.js"] });

    expect(status).toMatchObject({ state: "ready", strategy: "command", command: "node api.js" });
    expect(await fetchText(status.url!)).toBe("api");
    expect(saved).toEqual([["node", "api.js"]]);
  }, 60_000);

  it("uses the saved command when nothing else can run the project", async () => {
    project.write("api.js", SERVER);
    const status = await start(true, { savedCommand: ["node", "api.js"] });
    expect(status).toMatchObject({ state: "ready", strategy: "command" });
    expect(saved).toEqual([]);
  }, 60_000);

  it("shows the output of a program that has no web page", async () => {
    manager = new PreviewManager({
      guestDir: undefined,
      emit: (status) => statuses.push(status),
      mask: (text) => text,
      log: nullLogger,
      quietAfterMs: 300,
    });
    project.write("game.js", `let n = 0; setInterval(() => console.log("frame " + n++), 50);`);

    const status = await start(true, { command: ["node", "game.js"] });

    expect(status).toMatchObject({ state: "running", strategy: "command", url: null });
    await new Promise((resolve) => setTimeout(resolve, 600));
    const latest = manager.status("prj_1");
    expect(latest.state).toBe("running");
    expect(latest.log.join("\n")).toContain("frame");
    expect(statuses.at(-1)?.log.length).toBeGreaterThan(status.log.length);
  }, 60_000);
});
