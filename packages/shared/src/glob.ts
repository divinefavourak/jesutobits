/**
 * Glob patterns for `search_files` and `search_text` filters, matched against
 * project-relative `/` paths: `*` (within a segment), `**` (any number of segments), `?`,
 * `[abc]`, `{a,b}`. A pattern without `/` matches the file name at any depth, as in
 * `.gitignore` and ripgrep's `--glob`.
 */
export function globToRegExp(pattern: string, options: { caseSensitive?: boolean } = {}): RegExp {
  const anyDepth = !pattern.includes("/");
  const body = translate(pattern.replace(/^\.\//, "").replace(/^\//, ""));
  const source = anyDepth ? `^(?:.*/)?${body}$` : `^${body}$`;
  return new RegExp(source, options.caseSensitive === false ? "i" : "");
}

function translate(pattern: string): string {
  let out = "";
  let braces = 0;
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern.charAt(i);
    if (char === "*") {
      if (pattern.charAt(i + 1) === "*") {
        const slashAfter = pattern.charAt(i + 2) === "/";
        // `**/` is zero or more folders; a trailing `**` is anything below.
        out += slashAfter ? "(?:[^/]*/)*" : ".*";
        i += slashAfter ? 2 : 1;
      } else {
        out += "[^/]*";
      }
    } else if (char === "?") {
      out += "[^/]";
    } else if (char === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end === -1) {
        out += "\\[";
      } else {
        const set = pattern
          .slice(i + 1, end)
          .replace(/^!/, "^")
          .replace(/[\\]/g, "\\\\");
        out += `[${set}]`;
        i = end;
      }
    } else if (char === "{") {
      braces++;
      out += "(?:";
    } else if (char === "}" && braces > 0) {
      braces--;
      out += ")";
    } else if (char === "," && braces > 0) {
      out += "|";
    } else {
      out += char.replace(/[.+^$()|\\]/g, "\\$&");
    }
  }
  return out + ")".repeat(braces);
}

export function matchesGlob(path: string, pattern: string, caseSensitive = true): boolean {
  return globToRegExp(pattern, { caseSensitive }).test(path);
}
