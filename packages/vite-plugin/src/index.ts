import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Plugin } from "vite";
import { instrumentJsx, type InstrumentResult } from "./instrument.js";

export {
  COMP_ATTRIBUTE,
  instrumentJsx,
  LOC_ATTRIBUTE,
  type InstrumentResult,
} from "./instrument.js";

export interface VisualEditOptions {
  /** Absolute project root. Only files inside it are instrumented. */
  root: string;
  /** Project-relative path prefixes (forward slashes) to leave alone, e.g. `src/vendor/`. */
  exclude?: string[];
}

/** Served to the page through `transformIndexHtml` (ADR-0009, decision 4). */
export const BRIDGE_PATH = "/@jesutobits/bridge";
const RESOLVED_BRIDGE = "\0jesutobits:bridge";

/**
 * Spike S2 stand-in for `@jesutobits/visual-bridge`: records HMR updates and resolves an
 * element to its nearest instrumented ancestor, the same lookup the real bridge uses
 * (VISUAL_EDITING.md section 5.1). Phase 4 replaces it with the real bundle.
 */
const BRIDGE_STUB = `
const state = (window.__jesutobits = {
  version: "s2-stub",
  hmrUpdates: [],
  resolve(element) {
    const host = element?.closest?.("[data-jesutobits-loc]");
    if (!host) return null;
    return {
      loc: host.getAttribute("data-jesutobits-loc"),
      tag: host.tagName.toLowerCase(),
      component: host.closest("[data-jesutobits-comp]")?.getAttribute("data-jesutobits-comp") ?? null,
    };
  },
});
if (import.meta.hot) {
  import.meta.hot.on("vite:afterUpdate", (payload) => {
    state.hmrUpdates.push({ at: Date.now(), files: payload.updates.map((u) => u.path) });
  });
}
`;

/** Normalises Vite ids (`C:/x/y.tsx?v=1`) and returns the project-relative posix path. */
function projectPath(id: string, root: string): string | undefined {
  const [path = ""] = id.split("?", 1);
  if (!/\.[jt]sx$/.test(path) || path.includes("/node_modules/") || path.startsWith("\0")) {
    return undefined;
  }
  const rel = relative(root, resolve(path));
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return undefined;
  return rel.split(sep).join("/");
}

/** Dev-server-only plugin that instruments JSX for visual editing. */
export function jesutobitsVisualEdit(options: VisualEditOptions): Plugin {
  const root = resolve(options.root);
  const exclude = options.exclude ?? [];
  // Latest result per file, so the cache stays one entry per module however many edits.
  const cache = new Map<string, { hash: string; result: InstrumentResult | null }>();

  return {
    name: "jesutobits:visual-edit",
    apply: "serve",
    // Before @vitejs/plugin-react, so the JSX is still JSX.
    enforce: "pre",

    resolveId(id) {
      return id === BRIDGE_PATH ? RESOLVED_BRIDGE : undefined;
    },

    load(id) {
      return id === RESOLVED_BRIDGE ? BRIDGE_STUB : undefined;
    },

    transformIndexHtml() {
      return [{ tag: "script", attrs: { type: "module", src: BRIDGE_PATH }, injectTo: "head" }];
    },

    transform: {
      // Inline plugins are appended after the project's own (Spike S2), so `enforce: "pre"`
      // alone would put this behind the project's pre plugins. Hook-level `order: "pre"`
      // runs this transform before every default-order transform hook, so JSX arrives
      // uncompiled even if a project plugin compiles JSX early.
      order: "pre",
      handler(code, id) {
        const file = projectPath(id, root);
        if (!file || exclude.some((prefix) => file.startsWith(prefix))) return undefined;

        // An unchanged file is not parsed again (section 6.1).
        const hash = createHash("sha1").update(code).digest("hex");
        let entry = cache.get(file);
        if (entry?.hash !== hash) {
          entry = { hash, result: instrumentJsx(code, file, file.endsWith(".tsx")) };
          cache.set(file, entry);
        }
        return entry.result ? { code: entry.result.code, map: entry.result.map } : undefined;
      },
    },
  };
}
