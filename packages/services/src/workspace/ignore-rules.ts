import ignore, { type Ignore } from "ignore";

/** Always ignored (AGENT_HARNESS.md section 6), even without a .gitignore. */
const BUILT_IN = ["node_modules/", ".git/", "dist/", "build/", ".next/", "coverage/"];

/** Reads a project file as text, or undefined if it does not exist. */
export type ReadOptional = (relative: string) => Promise<string | undefined>;

/**
 * Which project paths are ignored: the built-ins, `.jesutobitsignore` at the root, and every
 * `.gitignore` from the root down to the path's folder, each relative to its own folder as
 * Git does. A path inside an ignored folder is ignored. Matchers are cached per folder;
 * `invalidate` drops a folder's matcher when its ignore file changes.
 */
export class IgnoreRules {
  private readonly matchers = new Map<string, Promise<Ignore | undefined>>();

  constructor(private readonly read: ReadOptional) {}

  /** `relative` uses `/` separators; "" is the root, which is never ignored. */
  async isIgnored(relative: string, isDirectory: boolean): Promise<boolean> {
    if (relative === "") return false;
    const names = relative.split("/");
    for (let depth = 1; depth <= names.length; depth++) {
      const isLast = depth === names.length;
      if (await this.matches(names, depth, isLast ? isDirectory : true)) return true;
    }
    return false;
  }

  /** Forget every matcher, after changes too many to track one by one. */
  clear(): void {
    this.matchers.clear();
  }

  /** Forget the matcher for a folder ("" for the root), after its ignore files changed. */
  invalidate(folder: string): void {
    this.matchers.delete(folder);
  }

  /** Whether `names[0..depth)` is ignored by the matchers of the folders above it. */
  private async matches(names: string[], depth: number, isDirectory: boolean): Promise<boolean> {
    let ignored = false;
    for (let level = 0; level < depth; level++) {
      const matcher = await this.matcher(names.slice(0, level).join("/"));
      if (!matcher) continue;
      const rest = names.slice(level, depth).join("/") + (isDirectory ? "/" : "");
      const result = matcher.test(rest);
      if (result.ignored) ignored = true;
      else if (result.unignored) ignored = false;
    }
    return ignored;
  }

  private matcher(folder: string): Promise<Ignore | undefined> {
    let matcher = this.matchers.get(folder);
    if (!matcher) {
      matcher = this.load(folder);
      this.matchers.set(folder, matcher);
    }
    return matcher;
  }

  private async load(folder: string): Promise<Ignore | undefined> {
    const prefix = folder === "" ? "" : `${folder}/`;
    const files = folder === "" ? [".gitignore", ".jesutobitsignore"] : [".gitignore"];
    const texts = await Promise.all(files.map((file) => this.read(`${prefix}${file}`)));
    const rules = texts.filter((text): text is string => text !== undefined);
    if (folder !== "" && rules.length === 0) return undefined;
    const matcher = ignore();
    if (folder === "") matcher.add(BUILT_IN);
    // `add` splits a string into lines, but takes each array element as one pattern.
    for (const text of rules) matcher.add(text);
    return matcher;
  }
}
