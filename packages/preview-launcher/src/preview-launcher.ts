// Preview launcher (VISUAL_EDITING.md section 4.8). Runs with the user's own Node in the
// project root, starts the project's own Vite through its JavaScript API with the Jesutobits
// plugin added inline, and never touches the project's vite.config (ADR-0009, RN-23).
//
//   node preview-launcher.js --root <dir> --port <n> --plugin <path to plugin bundle>
//
// Machine-readable lines on stdout start with "@@jesutobits " followed by JSON:
//   {"event":"plugins","names":[...]}   resolved plugin order (RN-24 evidence)
//   {"event":"ready","url":"http://127.0.0.1:<port>/"}
//   {"event":"error","code":"...","message":"..."}
// Node built-ins only: this runs inside the user's toolchain.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MIN_VITE_MAJOR = 7;

function emit(event: Record<string, unknown>): void {
  process.stdout.write(`@@jesutobits ${JSON.stringify(event)}\n`);
}

function fail(code: string, message: string): never {
  emit({ event: "error", code, message });
  process.exit(2);
}

function arg(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (!value) fail("launcher.bad_arguments", `Missing --${name}`);
  return value;
}

/** Picks the ESM entry from a package.json `exports` value. */
function importEntry(exports: unknown): string | undefined {
  if (typeof exports === "string") return exports;
  if (typeof exports !== "object" || exports === null) return undefined;
  const map = exports as Record<string, unknown>;
  for (const key of [".", "import", "default", "node"]) {
    if (key in map) {
      const entry = importEntry(map[key]);
      if (entry) return entry;
    }
  }
  return undefined;
}

interface ViteModule {
  createServer(config: Record<string, unknown>): Promise<{
    listen(): Promise<unknown>;
    close(): Promise<void>;
    config: { plugins: ReadonlyArray<{ name: string }> };
    resolvedUrls: { local: string[] } | null;
  }>;
}

const root = resolve(arg("root"));
const port = Number(arg("port"));
const pluginPath = resolve(arg("plugin"));

// Resolve Vite from the project, not from Jesutobits: the preview uses the project's toolchain.
let vitePackageJson: string;
try {
  vitePackageJson = createRequire(join(root, "package.json")).resolve("vite/package.json");
} catch {
  fail("preview.vite_not_found", `Vite is not installed in ${root}`);
}
const vitePackage = JSON.parse(readFileSync(vitePackageJson, "utf8")) as {
  version: string;
  exports?: unknown;
  module?: string;
};
const major = Number(vitePackage.version.split(".")[0]);
if (!(major >= MIN_VITE_MAJOR)) {
  fail("preview.unsupported_vite", `Vite ${vitePackage.version} is older than ${MIN_VITE_MAJOR}`);
}
const entry = importEntry(vitePackage.exports) ?? vitePackage.module;
if (!entry) fail("preview.vite_not_found", "Could not find Vite's ESM entry");

const vite = (await import(
  pathToFileURL(join(dirname(vitePackageJson), entry)).href
)) as ViteModule;
const { jesutobitsVisualEdit } = (await import(pathToFileURL(pluginPath).href)) as {
  jesutobitsVisualEdit(options: { root: string }): unknown;
};

const server = await vite.createServer({
  root,
  // configFile is left unset, so Vite loads the project's own config and merges ours in.
  clearScreen: false,
  server: { host: "127.0.0.1", port, strictPort: true },
  plugins: [jesutobitsVisualEdit({ root })],
});
await server.listen();

emit({
  event: "plugins",
  vite: vitePackage.version,
  names: server.config.plugins.map((p) => p.name),
});
emit({ event: "ready", url: server.resolvedUrls?.local[0] ?? `http://127.0.0.1:${port}/` });

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await server.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
// The supervisor holds stdin open; EOF means it is gone (same rule as the runtime, ADR-0002).
process.stdin.on("end", () => void shutdown());
process.stdin.resume();
