// Tests the boundary rule against the real rule table, so a broken table fails CI.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RuleTester } from "eslint";
import tseslint from "typescript-eslint";
import { describe, it } from "vitest";
import { boundaryRules, isolatedFolders } from "./boundaries.mjs";
import importBoundaries from "./import-boundaries.mjs";
import noRawColors from "./no-raw-colors.mjs";

RuleTester.describe = describe;
RuleTester.it = it;

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const options = [{ root, rules: boundaryRules, isolate: isolatedFolders }];
const at = (path) => join(root, ...path.split("/"));

const tester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

const ok = (path, code) => ({ filename: at(path), code, options });
const bad = (path, code, messageId = "restricted") => ({
  filename: at(path),
  code,
  options,
  errors: [{ messageId }],
});

tester.run("import-boundaries", importBoundaries, {
  valid: [
    ok("packages/protocol/src/a.ts", 'import { z } from "zod";'),
    ok("packages/services/src/git/a.ts", 'import { x } from "@jesutobits/protocol";'),
    ok("packages/runtime/src/agent/a.ts", 'import { x } from "@jesutobits/services";'),
    ok("packages/runtime/test/harness/h.ts", 'import { spawn } from "node:child_process";'),
    ok("packages/services/src/workspace/a.ts", 'import { readFile } from "node:fs/promises";'),
    ok("packages/services/src/process/a.ts", 'import { spawn } from "node:child_process";'),
    ok("packages/services/src/git/a.test.ts", 'import { mkdtemp } from "node:fs/promises";'),
    ok("packages/runtime/src/storage/db.ts", 'import { DatabaseSync } from "node:sqlite";'),
    ok("packages/vite-plugin/src/a.ts", 'import type { MethodName } from "@jesutobits/protocol";'),
    ok("packages/vite-plugin/src/a.ts", 'import { type MethodName } from "@jesutobits/protocol";'),
    ok("apps/desktop/src/host-bridge/tauri.ts", 'import { invoke } from "@tauri-apps/api/core";'),
    ok("apps/desktop/src/features/editor/monaco.ts", 'import * as monaco from "monaco-editor";'),
    ok("packages/runtime/src/tools/fs/read.ts", 'import { x } from "../common/paths.js";'),
    ok("packages/runtime/src/tools/registry.ts", 'import { x } from "./fs/read.js";'),
    ok("apps/desktop/vite.config.ts", 'import { join } from "node:path";'),
    ok(
      "apps/desktop/e2e/fixtures.ts",
      'import { startRelay } from "../../../scripts/dev-relay.mjs";',
    ),
  ],
  invalid: [
    bad("packages/protocol/src/a.ts", 'import { x } from "@jesutobits/shared";'),
    bad("packages/shared/src/a.ts", 'import { readFile } from "node:fs";'),
    bad("packages/shared/src/a.ts", 'import { join } from "path";'),
    bad("packages/services/src/git/a.ts", 'import { x } from "@jesutobits/runtime";'),
    bad("packages/runtime/src/agent/a.ts", 'import { x } from "@jesutobits/desktop";'),
    bad("apps/desktop/src/features/agent/a.ts", 'import { x } from "@jesutobits/runtime";'),
    bad("apps/desktop/src/state/a.ts", 'import { readFile } from "node:fs";'),
    bad("packages/extension-cli/src/a.ts", 'import { x } from "@jesutobits/shared";'),
    bad(
      "packages/vite-plugin/src/a.ts",
      'import { PROTOCOL_VERSION } from "@jesutobits/protocol";',
    ),
    bad("packages/visual-bridge/src/a.ts", 'import type { Id } from "@jesutobits/shared";'),
    bad("apps/desktop/src/features/agent/a.ts", 'import { invoke } from "@tauri-apps/api/core";'),
    bad("apps/desktop/src/features/preview/a.ts", 'import * as monaco from "monaco-editor";'),
    bad(
      "apps/desktop/src/features/companion/a.ts",
      'import { DotLottie } from "@lottiefiles/dotlottie-web";',
    ),
    bad("packages/services/src/git/a.ts", 'import { readFile } from "node:fs/promises";'),
    bad("packages/runtime/src/agent/a.ts", 'import { writeFileSync } from "fs";'),
    bad("packages/runtime/src/agent/a.ts", 'import { spawn } from "node:child_process";'),
    bad("packages/services/src/preview/a.ts", 'import { spawn } from "child_process";'),
    bad("packages/runtime/src/sessions/a.ts", 'import { DatabaseSync } from "node:sqlite";'),
    bad("packages/runtime/src/agent/a.ts", 'import { request } from "node:https";'),
    bad("packages/runtime/src/agent/a.ts", 'const addon = await import("./binding.node");'),
    bad("packages/runtime/src/agent/a.ts", 'export { x } from "@jesutobits/desktop";'),
    bad(
      "packages/runtime/src/agent/a.ts",
      'import { x } from "../../../services/src/index.js";',
      "escapesPackage",
    ),
    bad(
      "apps/desktop/src/features/start/a.ts",
      'import { startRelay } from "../../../../../scripts/dev-relay.mjs";',
      "escapesPackage",
    ),
    bad(
      "apps/desktop/e2e/fixtures.ts",
      'import { x } from "../../../packages/runtime/src/index.js";',
      "escapesPackage",
    ),
    bad(
      "packages/runtime/src/tools/fs/read.ts",
      'import { x } from "../git/status.js";',
      "crossesSibling",
    ),
  ],
});

tester.run("no-raw-colors", noRawColors, {
  valid: [
    { code: 'const c = "var(--jb-color-accent)";' },
    { code: 'const cls = "bg-surface text-fg border-subtle";' },
    { code: 'const id = "#root";' },
  ],
  invalid: [
    { code: 'const c = "#ff8800";', errors: [{ messageId: "raw" }] },
    { code: "const c = `rgb(0 0 0 / 50%)`;", errors: [{ messageId: "raw" }] },
    { code: 'const cls = "p-2 bg-blue-500";', errors: [{ messageId: "raw" }] },
    { code: 'const cls = "text-[#333]";', errors: [{ messageId: "raw" }] },
    { code: "const el = <span>oklch(70% 0.1 200)</span>;", errors: [{ messageId: "raw" }] },
  ],
});
