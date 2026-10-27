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
 * The bridge inside the preview (VISUAL_EDITING.md sections 5 and 9, ADR-0010). It only
 * reports: in inspect mode it outlines the instrumented element under the pointer and, on a
 * click, tells the Jesutobits panel which element it was. It obeys one message, `inspect.set`
 * from its parent window, and adopts that message's session nonce for everything it sends.
 * `window.__jesutobits` keeps the lookup and HMR record Spike S2 measures with.
 */
const BRIDGE = `
const PROTOCOL = 1;
let nonce = null;
let inspecting = false;
const state = (window.__jesutobits = {
  version: "1",
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

const overlay = document.createElement("div");
overlay.setAttribute("data-jesutobits-overlay", "");
Object.assign(overlay.style, {
  position: "fixed", pointerEvents: "none", zIndex: "2147483647", display: "none",
  border: "2px solid #6366F1", background: "rgba(99, 102, 241, 0.12)", boxSizing: "border-box",
});
const attach = () => document.body && !overlay.isConnected && document.body.appendChild(overlay);

function post(message) {
  if (nonce && window.parent !== window) {
    window.parent.postMessage({ jesutobits: PROTOCOL, nonce, ...message }, "*");
  }
}
const hostOf = (target) => (target instanceof Element ? target.closest("[data-jesutobits-loc]") : null);

window.addEventListener("message", (event) => {
  if (event.source !== window.parent) return;
  const data = event.data;
  if (!data || data.jesutobits !== PROTOCOL || data.type !== "inspect.set") return;
  if (typeof data.nonce !== "string" || !/^[0-9a-f]{32}$/.test(data.nonce)) return;
  if (typeof data.enabled !== "boolean") return;
  const first = nonce === null;
  nonce = data.nonce;
  if (first) post({ type: "bridge.hello", version: state.version, url: location.href.slice(0, 2048) });
  inspecting = data.enabled;
  attach();
  overlay.style.display = "none";
  document.documentElement.style.cursor = inspecting ? "crosshair" : "";
});

document.addEventListener("mousemove", (event) => {
  if (!inspecting) return;
  const host = hostOf(event.target);
  if (!host) {
    overlay.style.display = "none";
    return;
  }
  const rect = host.getBoundingClientRect();
  Object.assign(overlay.style, {
    display: "block", left: rect.left + "px", top: rect.top + "px",
    width: rect.width + "px", height: rect.height + "px",
  });
}, true);

document.addEventListener("click", (event) => {
  if (!inspecting) return;
  const host = hostOf(event.target);
  if (!host) return;
  event.preventDefault();
  event.stopPropagation();
  post({
    type: "inspect.selected",
    loc: host.getAttribute("data-jesutobits-loc"),
    tag: host.tagName.toLowerCase(),
    component: host.closest("[data-jesutobits-comp]")?.getAttribute("data-jesutobits-comp") ?? null,
    className: (host.getAttribute("class") ?? "").slice(0, 4000),
    text: (host.textContent ?? "").trim().replace(/\\s+/g, " ").slice(0, 200),
  });
}, true);
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
      return id === RESOLVED_BRIDGE ? BRIDGE : undefined;
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
