// NFR-019: a 100,000-file project opens without freezing. Generating the tree takes a while,
// so this runs only with JESUTOBITS_PERF=1 (nightly and on demand):
//
//   JESUTOBITS_PERF=1 pnpm exec vitest run packages/services/test/large-tree.perf.test.ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { nullLogger } from "@jesutobits/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FileIndex, WorkspaceService } from "../src/index.js";

const FILES = Number(process.env.JESUTOBITS_PERF_FILES ?? 100_000);
let root: string;

describe.runIf(process.env.JESUTOBITS_PERF === "1")("large tree (NFR-019)", () => {
  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), "jesutobits-large-tree-"));
    // Run as a script: a package may not import files outside itself (boundary rules).
    const script = fileURLToPath(new URL("../../../scripts/gen-large-tree.mjs", import.meta.url));
    execFileSync(process.execPath, [script, root, "--files", String(FILES)], { stdio: "inherit" });
  }, 600_000);

  afterAll(
    () => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }),
    600_000,
  );

  it("indexes every file without blocking the event loop for 100 ms", async () => {
    const ws = await WorkspaceService.open({ root, log: nullLogger });
    const delay = monitorEventLoopDelay({ resolution: 10 });
    delay.enable();
    const started = performance.now();
    const index = FileIndex.build(ws, nullLogger);
    await index.ready;
    const buildMs = performance.now() - started;
    delay.disable();
    const maxBlockMs = delay.max / 1e6;

    const queryStarted = performance.now();
    const results = index.query("module1file4", 50);
    const queryMs = performance.now() - queryStarted;

    const listStarted = performance.now();
    await ws.listDir("");
    const listMs = performance.now() - listStarted;

    process.stdout.write(
      `large tree: ${index.size} files indexed in ${Math.round(buildMs)} ms, longest event-loop block ${Math.round(maxBlockMs)} ms, query ${Math.round(queryMs)} ms, root listDir ${Math.round(listMs)} ms\n`,
    );
    expect(index.size).toBe(FILES + 1); // plus package.json
    expect(results.length).toBeGreaterThan(0);
    expect(maxBlockMs).toBeLessThan(100);
    expect(queryMs).toBeLessThan(500);
  }, 600_000);
});
