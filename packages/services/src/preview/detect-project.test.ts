import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { nullLogger } from "@jesutobits/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileIndex } from "../workspace/file-index.js";
import { WorkspaceService } from "../workspace/workspace-service.js";
import { detectProject, majorVersion } from "./detect-project.js";

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "jesutobits-detect-")));
});
afterEach(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

const write = (relative: string, content: string) => {
  mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  writeFileSync(path.join(root, relative), content);
};
const pkg = (json: object) => write("package.json", JSON.stringify(json));

async function detect() {
  const ws = await WorkspaceService.open({ root, log: nullLogger });
  const index = FileIndex.build(ws, nullLogger);
  await index.ready;
  return detectProject(ws, index);
}

const viteReact = {
  scripts: { dev: "vite", build: "vite build", test: "vitest run" },
  dependencies: { react: "^19.3.1", "react-dom": "^19.3.1" },
  devDependencies: { vite: "^8.3.4", "@vitejs/plugin-react": "^6.1.2" },
};

describe("detectProject (VISUAL_EDITING.md section 3)", () => {
  it("has nothing to offer without a package.json", async () => {
    expect(await detect()).toMatchObject({
      previewStrategy: "none",
      packageManager: null,
      visualEditing: { level: "unavailable" },
    });
  });

  it("picks vite-react with Tailwind 4 via the Vite plugin", async () => {
    pkg({
      ...viteReact,
      devDependencies: {
        ...viteReact.devDependencies,
        tailwindcss: "^4.3.3",
        "@tailwindcss/vite": "^4.3.3",
      },
    });
    write("pnpm-lock.yaml", "");
    const result = await detect();
    expect(result).toMatchObject({
      previewStrategy: "vite-react",
      styling: "tailwind-4",
      packageManager: { name: "pnpm", source: "lockfile" },
      scripts: { dev: "vite", build: "vite build", test: "vitest run" },
      visualEditing: {
        level: "full",
        reason: "Visual editing available: React + Vite + Tailwind 4",
      },
    });
  });

  it("finds Tailwind 4 from a CSS import when the plugin is not a dependency", async () => {
    pkg({ ...viteReact, devDependencies: { ...viteReact.devDependencies, tailwindcss: "^4.0.0" } });
    write("src/index.css", '@import "tailwindcss";\n');
    expect((await detect()).styling).toBe("tailwind-4");
  });

  it("recognises Tailwind 3 by its config file", async () => {
    pkg({ ...viteReact, devDependencies: { ...viteReact.devDependencies, tailwindcss: "^3.4.0" } });
    write("tailwind.config.js", "export default {};\n");
    expect((await detect()).styling).toBe("tailwind-3");
  });

  it("falls back to inline styles", async () => {
    pkg(viteReact);
    expect(await detect()).toMatchObject({ styling: "inline", visualEditing: { level: "full" } });
  });

  it("is inspect-only with CSS Modules or CSS-in-JS", async () => {
    pkg(viteReact);
    write("src/Button.module.css", ".x {}\n");
    expect(await detect()).toMatchObject({
      styling: "css-modules",
      visualEditing: { level: "inspect-only" },
    });

    rmSync(path.join(root, "src"), { recursive: true });
    pkg({
      ...viteReact,
      dependencies: { ...viteReact.dependencies, "styled-components": "^6.0.0" },
    });
    expect((await detect()).styling).toBe("css-in-js");
  });

  it("uses the generic adapter for meta-frameworks, naming them", async () => {
    pkg({ ...viteReact, dependencies: { ...viteReact.dependencies, next: "^16.0.0" } });
    expect(await detect()).toMatchObject({
      previewStrategy: "generic",
      framework: "Next.js",
      visualEditing: {
        level: "unavailable",
        reason: expect.stringContaining("Next.js") as unknown,
      },
    });
  });

  it("uses the generic adapter for an old Vite, and none without dev or start", async () => {
    pkg({ ...viteReact, devDependencies: { ...viteReact.devDependencies, vite: "^6.0.0" } });
    expect((await detect()).previewStrategy).toBe("generic");
    pkg({ scripts: { build: "tsc" } });
    expect((await detect()).previewStrategy).toBe("none");
  });

  it("prefers the packageManager field over lockfiles", async () => {
    pkg({ packageManager: "yarn@4.5.0" });
    write("package-lock.json", "{}");
    expect((await detect()).packageManager).toEqual({
      name: "yarn",
      source: "packageManager field",
    });
  });

  it("writes nothing", async () => {
    pkg(viteReact);
    const before = listing();
    await detect();
    expect(listing()).toEqual(before);
  });
});

function listing(): string[] {
  return (readdirSync(root, { recursive: true }) as string[]).sort();
}

describe("majorVersion", () => {
  it.each([
    ["^8.3.4", 8],
    ["~7.0", 7],
    [">=18", 18],
    ["19.3.1", 19],
    ["latest", undefined],
    ["workspace:*", undefined],
    [42, undefined],
  ] as const)("%j -> %j", (range, expected) => expect(majorVersion(range)).toBe(expected));
});
