import { describe, expect, it } from "vitest";
import { IgnoreRules } from "./ignore-rules.js";

function rules(files: Record<string, string>) {
  const reads: string[] = [];
  const ignores = new IgnoreRules(async (relative) => {
    reads.push(relative);
    return files[relative];
  });
  return { ignores, reads };
}

describe("IgnoreRules", () => {
  it("ignores the built-in folders and everything in them", async () => {
    const { ignores } = rules({});
    expect(await ignores.isIgnored("node_modules", true)).toBe(true);
    expect(await ignores.isIgnored("node_modules/react/index.js", false)).toBe(true);
    expect(await ignores.isIgnored("packages/app/dist", true)).toBe(true);
    expect(await ignores.isIgnored(".git/HEAD", false)).toBe(true);
    expect(await ignores.isIgnored("src/build.ts", false)).toBe(false);
    expect(await ignores.isIgnored("", true)).toBe(false);
  });

  it("applies the root .gitignore and .jesutobitsignore", async () => {
    const { ignores } = rules({ ".gitignore": "*.log\n/tmp\n", ".jesutobitsignore": "fixtures/" });
    expect(await ignores.isIgnored("debug.log", false)).toBe(true);
    expect(await ignores.isIgnored("src/debug.log", false)).toBe(true);
    expect(await ignores.isIgnored("tmp", true)).toBe(true);
    expect(await ignores.isIgnored("src/tmp", true)).toBe(false);
    expect(await ignores.isIgnored("fixtures/a.ts", false)).toBe(true);
  });

  it("applies nested .gitignore files relative to their own folder", async () => {
    const { ignores } = rules({ "packages/web/.gitignore": "/out\n*.cache\n" });
    expect(await ignores.isIgnored("packages/web/out/index.html", false)).toBe(true);
    expect(await ignores.isIgnored("packages/web/src/a.cache", false)).toBe(true);
    expect(await ignores.isIgnored("packages/api/out/index.html", false)).toBe(false);
    expect(await ignores.isIgnored("out", true)).toBe(false);
  });

  it("lets a deeper .gitignore un-ignore a file", async () => {
    const { ignores } = rules({ ".gitignore": "*.env\n", "config/.gitignore": "!example.env\n" });
    expect(await ignores.isIgnored("config/prod.env", false)).toBe(true);
    expect(await ignores.isIgnored("config/example.env", false)).toBe(false);
  });

  it("matches folder-only patterns only for folders", async () => {
    const { ignores } = rules({ ".gitignore": "logs/\n" });
    expect(await ignores.isIgnored("logs", true)).toBe(true);
    expect(await ignores.isIgnored("logs", false)).toBe(false);
  });

  it("reads each ignore file once until invalidated", async () => {
    const { ignores, reads } = rules({ ".gitignore": "*.log" });
    await ignores.isIgnored("a.log", false);
    await ignores.isIgnored("b.log", false);
    expect(reads.filter((file) => file === ".gitignore")).toHaveLength(1);
    ignores.invalidate("");
    await ignores.isIgnored("c.log", false);
    expect(reads.filter((file) => file === ".gitignore")).toHaveLength(2);
  });
});
