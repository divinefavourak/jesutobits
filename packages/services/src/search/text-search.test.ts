import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ErrorCodes } from "@jesutobits/protocol";
import { nullLogger } from "@jesutobits/shared";
import { FileIndex } from "../workspace/file-index.js";
import { WorkspaceService } from "../workspace/workspace-service.js";
import {
  searchText,
  type TextMatch,
  type TextSearchContext,
  type TextSearchOptions,
  type TextSearchOutcome,
} from "./text-search.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/** The repo root, for the bundled ripgrep sidecar the desktop build fetches. */
const ROOT_PATH = fileURLToPath(new URL("../../../..", import.meta.url));
const RG = path.join(
  ROOT_PATH,
  "apps/desktop/src-tauri/binaries",
  process.platform === "win32"
    ? "jesutobits-rg-x86_64-pc-windows-msvc.exe"
    : "jesutobits-rg-x86_64-unknown-linux-gnu",
);

/** A small project fixture shared by both engines. */
const FIXTURE: Record<string, string> = {
  "app.ts": "const needle = 'one';\n",
  "lib/depth/util.ts": "function find(needle: string): void {}\n",
  "readme.md": "needle two\n",
  // The multi-byte 'é' checks that columns stay characters, not bytes (both engines).
  "cols.txt": "héllo na needle then\n",
  "secret-file.txt": "needle three\n",
  "private-notes.txt": "needle four\n",
  "node_modules/pkg/index.js": "needle five\n",
  ".gitignore": "secret-file.txt\n",
  ".jesutobitsignore": "private-notes.txt\n",
};

const QUERY: TextSearchOptions = {
  query: "needle",
  isRegex: false,
  caseSensitive: false,
  limit: 200,
};

let base: string;
let ws: WorkspaceService;
let index: FileIndex;

beforeEach(async () => {
  // Canonical, so CI runners' 8.3 temp paths (RUNNER~1) match what WorkspaceService resolves.
  base = realpathSync.native(mkdtempSync(path.join(tmpdir(), "jesutobits-search-")));
  for (const [relative, content] of Object.entries(FIXTURE)) {
    const target = path.join(base, ...relative.split("/"));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  ws = await WorkspaceService.open({ root: base, log: nullLogger });
  index = FileIndex.build(ws, nullLogger);
  await index.ready;
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

/** Match paths with positions, sorted, for comparing the engines. */
const gist = (outcome: TextSearchOutcome): string[] =>
  outcome.matches.map((match: TextMatch) => `${match.path}:${match.line}:${match.column}`).sort();

describe("searchText", () => {
  describe("the JS fallback engine", () => {
    const run = (options: TextSearchOptions): Promise<TextSearchOutcome> =>
      searchText(options, { workspace: ws, files: () => index.list() });

    it("matches with path, 1-based line and 1-based character column", async () => {
      const outcome = await run(QUERY);
      expect(outcome.engine).toBe("fallback");
      expect(outcome.truncated).toBe(false);
      expect(gist(outcome)).toEqual([
        "app.ts:1:7",
        "cols.txt:1:10",
        "lib/depth/util.ts:1:15",
        "readme.md:1:1",
      ]);
      expect(outcome.matches[0]?.text).toBe("const needle = 'one';");
    });

    it("ignores case unless asked, then applies it", async () => {
      expect(gist(await run({ ...QUERY, query: "NEEDLE" }))).toEqual(gist(await run(QUERY)));
      expect(gist(await run({ ...QUERY, query: "NEEDLE", caseSensitive: true }))).toEqual([]);
    });

    it("takes a regular expression", async () => {
      const outcome = await run({ ...QUERY, query: "nède", isRegex: true });
      expect(outcome.matches).toEqual([]);
      expect(gist(await run({ ...QUERY, query: "needle|two", isRegex: true }))).toEqual(
        gist(await run(QUERY)),
      );
    });

    it("filters by glob", async () => {
      const outcome = await run({ ...QUERY, glob: "lib/**" });
      expect(gist(outcome)).toEqual(["lib/depth/util.ts:1:15"]);
    });

    it("cuts at the limit and says more existed", async () => {
      const outcome = await run({ ...QUERY, limit: 2 });
      expect(outcome.matches).toHaveLength(2);
      expect(outcome.truncated).toBe(true);
    });

    it("reports empty results and works with an empty file list", async () => {
      expect(await run({ ...QUERY, query: "absent-marker" })).toEqual({
        matches: [],
        truncated: false,
        engine: "fallback",
      });
      const nowhere = await searchText(QUERY, {
        workspace: ws,
        files: () => [],
      });
      expect(nowhere.matches).toEqual([]);
    });

    it("rejects an invalid regular expression with fs.invalid_query", async () => {
      await expect(run({ ...QUERY, query: "([unclosed", isRegex: true })).rejects.toMatchObject({
        code: ErrorCodes.fsInvalidQuery,
      });
    });
  });

  describe("the ripgrep engine", () => {
    const run = async (options: TextSearchOptions): Promise<TextSearchOutcome> => {
      const context: TextSearchContext = { workspace: ws, files: () => index.list(), ripgrep: RG };
      return searchText(options, context);
    };

    it.skipIf(!existsSync(RG))("finds the same matches as the fallback", async () => {
      const withRipgrep = await run(QUERY);
      expect(withRipgrep.engine).toBe("ripgrep");
      expect(gist(withRipgrep)).toEqual([
        "app.ts:1:7",
        "cols.txt:1:10",
        "lib/depth/util.ts:1:15",
        "readme.md:1:1",
      ]);
    });

    it.skipIf(!existsSync(RG))(
      "respects .gitignore, .jesutobitsignore and node_modules",
      async () => {
        const outcome = await run(QUERY);
        const paths = outcome.matches.map((match: TextMatch) => match.path);
        expect(paths).not.toContain("secret-file.txt");
        expect(paths).not.toContain("private-notes.txt");
        expect(paths).not.toContain("node_modules/pkg/index.js");
      },
    );

    it.skipIf(!existsSync(RG))(
      "keeps columns in characters after a multi-byte character earlier on the line",
      async () => {
        const outcome = await run({ ...QUERY, glob: "cols.txt" });
        expect(outcome.matches).toEqual([
          { path: "cols.txt", line: 1, column: 10, text: "héllo na needle then" },
        ]);
      },
    );

    it.skipIf(!existsSync(RG))("cuts at the limit and says more existed", async () => {
      const outcome = await run({ ...QUERY, limit: 2 });
      expect(outcome.matches).toHaveLength(2);
      expect(outcome.truncated).toBe(true);
    });

    it.skipIf(!existsSync(RG))("filters by glob and reports empty results", async () => {
      const outcome = await run({ ...QUERY, glob: "lib/**" });
      expect(outcome.matches).toHaveLength(1);
      expect(outcome.matches[0]?.path).toBe("lib/depth/util.ts");
      expect(await run({ ...QUERY, query: "absent-marker" })).toMatchObject({
        matches: [],
        truncated: false,
      });
    });

    it.skipIf(!existsSync(RG))(
      "rejects an invalid regular expression with fs.invalid_query",
      async () => {
        await expect(run({ ...QUERY, query: "([unclosed", isRegex: true })).rejects.toMatchObject({
          code: ErrorCodes.fsInvalidQuery,
        });
      },
    );

    it.skipIf(!existsSync(RG))("stops when the caller aborts the search", async () => {
      const controller = new AbortController();
      controller.abort();
      await expect(
        searchText(QUERY, {
          workspace: ws,
          files: () => index.list(),
          ripgrep: RG,
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ code: ErrorCodes.processCancelled });
    });
  });
});
