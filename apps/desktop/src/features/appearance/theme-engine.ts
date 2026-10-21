import type { AppSettings } from "@jesutobits/protocol";
import { compileTheme, type CompiledTheme } from "@jesutobits/extension-schema";
import { baseTheme, BUILTIN_THEMES, type ThemeEntry } from "./builtin-themes";

/** What the engine needs from the page; tests pass fakes. */
export interface ThemeTarget {
  setVariable(name: string, value: string): void;
  setAttribute(name: string, value: string): void;
}

export interface MediaQueries {
  matches(query: string): boolean;
  /** Calls `onChange` when any of the queries flips; returns a stop function. */
  watch(queries: readonly string[], onChange: () => void): () => void;
}

export interface AppliedTheme {
  theme: ThemeEntry;
  compiled: CompiledTheme;
  reduceMotion: boolean;
  /** How long compiling and applying took (UX budget: 200 ms for a theme switch). */
  ms: number;
}

const OS_QUERIES = [
  "(prefers-color-scheme: dark)",
  "(prefers-contrast: more)",
  "(forced-colors: active)",
  "(prefers-reduced-motion: reduce)",
] as const;

/**
 * Applies themes as CSS custom properties on the document (EXTENSION_SYSTEM.md section 4.1).
 * With "follow the OS", Windows' contrast themes pick High Contrast and the light/dark
 * setting picks Light or Dark; the engine re-applies when the OS setting changes. OS reduced
 * motion always wins (UX_AND_INTERFACE.md section 10).
 */
export class ThemeEngine {
  private appearance: AppSettings["appearance"] | undefined;
  private stopWatching: (() => void) | undefined;
  private onApplied: ((applied: AppliedTheme) => void) | undefined;

  constructor(
    private readonly target: ThemeTarget,
    private readonly media: MediaQueries,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** Applies the appearance settings now and whenever the OS preferences change. */
  start(
    appearance: AppSettings["appearance"],
    onApplied?: (applied: AppliedTheme) => void,
  ): AppliedTheme {
    this.onApplied = onApplied;
    this.stopWatching ??= this.media.watch(OS_QUERIES, () => {
      if (this.appearance) this.onApplied?.(this.apply(this.appearance));
    });
    return this.apply(appearance);
  }

  stop(): void {
    this.stopWatching?.();
    this.stopWatching = undefined;
  }

  /** The theme the settings select right now. Unknown IDs fall back to the base theme. */
  resolve(appearance: AppSettings["appearance"]): ThemeEntry {
    if (appearance.followOsTheme) {
      if (
        this.media.matches("(forced-colors: active)") ||
        this.media.matches("(prefers-contrast: more)")
      ) {
        return baseTheme("high-contrast");
      }
      return baseTheme(this.media.matches("(prefers-color-scheme: dark)") ? "dark" : "light");
    }
    return BUILTIN_THEMES.find((theme) => theme.id === appearance.theme) ?? baseTheme("dark");
  }

  apply(appearance: AppSettings["appearance"]): AppliedTheme {
    const started = this.now();
    this.appearance = appearance;
    const theme = this.resolve(appearance);
    const compiled = compileTheme(theme.tokens, baseTheme(theme.tokens.base).tokens);
    const reduceMotion =
      appearance.reduceMotion || this.media.matches("(prefers-reduced-motion: reduce)");

    for (const [name, value] of Object.entries(compiled.variables)) {
      this.target.setVariable(name, value);
    }
    if (reduceMotion) {
      this.target.setVariable("--jesutobits-duration-fast", "0ms");
      this.target.setVariable("--jesutobits-duration-normal", "0ms");
    }
    this.target.setVariable("--jesutobits-ui-scale", String(appearance.uiScale));
    this.target.setAttribute("data-theme", theme.id);
    this.target.setAttribute("data-theme-base", compiled.base);
    this.target.setAttribute("data-reduce-motion", String(reduceMotion));
    this.target.setVariable("color-scheme", compiled.colorScheme);

    return { theme, compiled, reduceMotion, ms: this.now() - started };
  }
}

/** The real page: CSS variables on <html>, and `matchMedia`. */
export function documentTarget(root: HTMLElement = document.documentElement): ThemeTarget {
  return {
    setVariable: (name, value) =>
      name === "color-scheme"
        ? (root.style.colorScheme = value)
        : root.style.setProperty(name, value),
    setAttribute: (name, value) => root.setAttribute(name, value),
  };
}

export function windowMedia(win: Window = window): MediaQueries {
  return {
    matches: (query) => win.matchMedia(query).matches,
    watch: (queries, onChange) => {
      const lists = queries.map((query) => win.matchMedia(query));
      for (const list of lists) list.addEventListener("change", onChange);
      return () => {
        for (const list of lists) list.removeEventListener("change", onChange);
      };
    },
  };
}
