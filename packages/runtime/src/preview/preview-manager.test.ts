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

const start = (trusted = true) =>
  manager.start({
    id: "prj_1",
    root: project.root,
    trusted,
    workspace: project.workspace,
    index: project.index,
  });

const fetchText = (url: string) =>
  new Promise<string>((resolve, reject) => {
    get(url, (response) => {
      let body = "";
      response.on("data", (chunk) => (body += chunk));
      response.on("end", () => resolve(body));
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
});
