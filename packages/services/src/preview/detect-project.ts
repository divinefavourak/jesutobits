import type { FileIndex } from "../workspace/file-index.js";
import type { WorkspaceService } from "../workspace/workspace-service.js";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";
export type PreviewStrategy = "vite-react" | "generic" | "static" | "none";
export type Styling = "tailwind-4" | "tailwind-3" | "inline" | "css-modules" | "css-in-js";
export type VisualEditingLevel = "full" | "inspect-only" | "unavailable";

export interface ProjectDetection {
  packageManager: { name: PackageManager; source: "packageManager field" | "lockfile" } | null;
  /** The scripts checks and previews care about, when present. */
  scripts: Partial<Record<"dev" | "start" | "build" | "test" | "lint" | "typecheck", string>>;
  previewStrategy: PreviewStrategy;
  /** For `static`: the folder with the site's `index.html` ("" is the root). */
  staticRoot: string | null;
  /** A meta-framework that rules out the instrumented adapter (Next.js, Remix...). */
  framework: string | null;
  styling: Styling | null;
  visualEditing: { level: VisualEditingLevel; reason: string };
}

interface PackageJson {
  packageManager?: unknown;
  scripts?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
}

const META_FRAMEWORKS: ReadonlyArray<readonly [string, string]> = [
  ["next", "Next.js"],
  ["@remix-run/react", "Remix"],
  ["@remix-run/dev", "Remix"],
  ["@react-router/dev", "React Router (framework mode)"],
  ["astro", "Astro"],
  ["@tanstack/react-start", "TanStack Start"],
  ["@tanstack/start", "TanStack Start"],
];
const LOCKFILES: ReadonlyArray<readonly [string, PackageManager]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["package-lock.json", "npm"],
];
const SCRIPT_NAMES = ["dev", "start", "build", "test", "lint", "typecheck"] as const;
/** Where a plain site keeps its `index.html`, in the order looked at. */
const STATIC_ROOTS = ["", "public", "src", "www", "site", "dist", "build"];
/** CSS files read when looking for Tailwind 4's `@import "tailwindcss"`. */
const MAX_CSS_FILES = 50;
const MAX_CSS_BYTES = 256 * 1024;

/**
 * What kind of project this is (J-05, VISUAL_EDITING.md section 3): package manager, the
 * scripts that matter, the preview strategy and how far visual editing can go. Reads files
 * only through WorkspaceService and writes nothing. `index` (when built) finds CSS Modules
 * and CSS files; without it those checks are skipped.
 */
export async function detectProject(
  workspace: WorkspaceService,
  index?: FileIndex,
): Promise<ProjectDetection> {
  const pkg = await readPackageJson(workspace);
  const packageManager = await detectPackageManager(workspace, pkg);
  if (!pkg) {
    const staticRoot = await findStaticRoot(workspace);
    return {
      packageManager,
      scripts: {},
      previewStrategy: staticRoot === null ? "none" : "static",
      staticRoot,
      framework: null,
      styling: null,
      visualEditing: {
        level: "unavailable",
        reason:
          staticRoot === null
            ? "There is no package.json or index.html in this folder."
            : "Visual editing supports React projects built with Vite 7 or newer.",
      },
    };
  }

  const scripts: ProjectDetection["scripts"] = {};
  for (const name of SCRIPT_NAMES) {
    const script = pkg.scripts?.[name];
    if (typeof script === "string") scripts[name] = script;
  }
  const deps = { ...pkg.devDependencies, ...pkg.dependencies } as Record<string, unknown>;
  const has = (name: string) => typeof deps[name] === "string";
  const major = (name: string) => majorVersion(deps[name]);

  const framework = META_FRAMEWORKS.find(([dep]) => has(dep))?.[1] ?? null;
  const vite = major("vite");
  const react = major("react");
  const isViteReact =
    framework === null &&
    has("vite") &&
    (vite === undefined || vite >= 7) &&
    has("react") &&
    (react === undefined || react >= 18) &&
    has("react-dom") &&
    (has("@vitejs/plugin-react") || has("@vitejs/plugin-react-swc"));

  if (!isViteReact) {
    const runnable = scripts.dev !== undefined || scripts.start !== undefined;
    const staticRoot = runnable ? null : await findStaticRoot(workspace);
    return {
      packageManager,
      scripts,
      previewStrategy: runnable ? "generic" : staticRoot !== null ? "static" : "none",
      staticRoot,
      framework,
      styling: null,
      visualEditing: {
        level: "unavailable",
        reason: framework
          ? `Visual editing supports React with Vite; this project uses ${framework}.`
          : runnable || staticRoot !== null
            ? "Visual editing supports React projects built with Vite 7 or newer."
            : "There is no dev or start script to run a preview.",
      },
    };
  }

  const styling = await detectStyling(workspace, index, has, major);
  const inspectOnly = styling === "css-modules" || styling === "css-in-js";
  return {
    packageManager,
    scripts,
    previewStrategy: "vite-react",
    staticRoot: null,
    framework: null,
    styling,
    visualEditing: inspectOnly
      ? {
          level: "inspect-only",
          reason:
            "Inspect-only: styles are defined in CSS files or CSS-in-JS, so the agent changes them.",
        }
      : {
          level: "full",
          reason: {
            "tailwind-4": "Visual editing available: React + Vite + Tailwind 4",
            "tailwind-3": "Visual editing available: React + Vite + Tailwind 3",
            inline: "Visual editing available: React + Vite (inline styles)",
          }[styling],
        },
  };
}

async function detectStyling(
  workspace: WorkspaceService,
  index: FileIndex | undefined,
  has: (name: string) => boolean,
  major: (name: string) => number | undefined,
): Promise<Styling> {
  if (has("styled-components") || has("@emotion/react") || has("@emotion/styled"))
    return "css-in-js";
  const files = index ? index.query("", Number.MAX_SAFE_INTEGER).map((result) => result.path) : [];
  if (files.some((file) => /\.module\.(css|scss|sass|less)$/i.test(file))) return "css-modules";

  const tailwind = major("tailwindcss");
  if (has("tailwindcss") && (tailwind === undefined || tailwind >= 4)) {
    if (has("@tailwindcss/vite")) return "tailwind-4";
    for (const file of files.filter((f) => f.endsWith(".css")).slice(0, MAX_CSS_FILES)) {
      const css = await workspace.readText(file, MAX_CSS_BYTES).catch(() => undefined);
      if (css && /@import\s+["']tailwindcss["']/.test(css.text)) return "tailwind-4";
    }
  }
  if (tailwind === 3) {
    const root = await workspace.listDir("");
    if (root.some((entry) => /^tailwind\.config\.(js|cjs|mjs|ts|cts|mts)$/.test(entry.name))) {
      return "tailwind-3";
    }
  }
  return "inline";
}

/** The first folder of STATIC_ROOTS with an `index.html`, or null. */
async function findStaticRoot(workspace: WorkspaceService): Promise<string | null> {
  for (const root of STATIC_ROOTS) {
    const entries = await workspace.listDir(root).catch(() => []);
    if (entries.some((entry) => entry.name.toLowerCase() === "index.html" && entry.kind === "file"))
      return root;
  }
  return null;
}

async function detectPackageManager(
  workspace: WorkspaceService,
  pkg: PackageJson | undefined,
): Promise<ProjectDetection["packageManager"]> {
  // Corepack's field wins: "pnpm@11.15.1".
  const declared =
    typeof pkg?.packageManager === "string" ? pkg.packageManager.split("@")[0] : undefined;
  if (declared === "npm" || declared === "pnpm" || declared === "yarn" || declared === "bun") {
    return { name: declared, source: "packageManager field" };
  }
  const root = await workspace.listDir("").catch(() => []);
  const names = new Set(root.map((entry) => entry.name));
  const found = LOCKFILES.find(([file]) => names.has(file));
  return found ? { name: found[1], source: "lockfile" } : null;
}

async function readPackageJson(workspace: WorkspaceService): Promise<PackageJson | undefined> {
  try {
    const parsed: unknown = JSON.parse(
      (await workspace.readText("package.json", 1024 * 1024)).text,
    );
    return parsed && typeof parsed === "object" ? (parsed as PackageJson) : undefined;
  } catch {
    return undefined;
  }
}

/** The major version a range allows at least: "^8.3.4" -> 8, ">=18" -> 18; unknown -> undefined. */
export function majorVersion(range: unknown): number | undefined {
  if (typeof range !== "string") return undefined;
  const match = /(?:^|[\s^~>=v])(\d+)(?:\.|$|\s)/.exec(range.trim());
  return match ? Number(match[1]) : undefined;
}
