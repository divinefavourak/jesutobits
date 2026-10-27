/*
 * A deliberately small CommonMark-ish parser for untrusted text (SECURITY.md section 8).
 * It never produces HTML, only an AST for Markdown.tsx. Scanners are hand written (no
 * nested-quantifier regex on message text) with a work budget for hostile input.
 */
export type TableAlign = "left" | "center" | "right" | null;
export type TaskState = "done" | "todo";
export type Inline =
  | { type: "text"; value: string }
  | { type: "code"; value: string }
  | { type: "strong"; children: Inline[] }
  | { type: "em"; children: Inline[] }
  | { type: "strike"; children: Inline[] }
  | { type: "link"; href: string; children: Inline[] }
  | { type: "image"; src: string; alt: string };
export type ListItem = { blocks: Block[]; task: TaskState | null };
export type Block =
  | { type: "paragraph"; children: Inline[] }
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; children: Inline[] }
  | { type: "codeBlock"; lang: string | null; value: string }
  | { type: "blockquote"; children: Block[] }
  | { type: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { type: "table"; align: TableAlign[]; header: Inline[][]; rows: Inline[][][] }
  | { type: "thematicBreak" };
const MAX_BLOCK_DEPTH = 24; // nested quotes/lists beyond this are flattened into a paragraph
const MAX_INLINE_DEPTH = 8; // deeper links/emphasis keep their content as plain text
const PUNCT = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;
const SPACE = /\s/;

/* ------------------------------------------------------------------ inline parsing ------ */

/** Appends text, merging adjacent text so plain runs stay one node. */
function pushText(out: Inline[], value: string): void {
  if (value === "") return;
  const last = out[out.length - 1];
  if (last?.type === "text") last.value += value;
  else out.push({ type: "text", value });
}

function findClosingBackticks(text: string, from: number, width: number): number {
  let index = from;
  while (index < text.length) {
    if (text[index] !== "`") {
      index += 1;
      continue;
    }
    let run = 1;
    while (text[index + run] === "`") run += 1;
    if (run === width) return index;
    index += run;
  }
  return -1;
}

/** Index of the last backtick of a code span starting at `index`, or `index` if unclosed. */
function skipCodeSpan(text: string, index: number): number {
  let width = 1;
  while (text[index + width] === "`") width += 1;
  const close = findClosingBackticks(text, index + width, width);
  return close < 0 ? index : close + width - 1;
}

/** Index of the `]` ending a label; -1 when it is not a link end; -2 when scanning stops. */
function findLabelEnd(text: string, from: number, tick: () => boolean): number {
  let depth = 0;
  for (let index = from; index < text.length; index += 1) {
    if (!tick()) return -2;
    const char = text[index];
    if (char === "\\") index += 1;
    else if (char === "`") index = skipCodeSpan(text, index);
    else if (char === "[") depth += 1;
    else if (char === "]") {
      if (depth === 0) return text[index + 1] === "(" ? index : -1;
      depth -= 1;
    }
  }
  return -2;
}

function findUrlEnd(text: string, from: number, tick: () => boolean): number {
  let depth = 0;
  for (let index = from; index < text.length; index += 1) {
    if (!tick()) return -1;
    if (text[index] === "\\") index += 1;
    else if (text[index] === "(") depth += 1;
    else if (text[index] === ")") {
      if (depth === 0) return index;
      depth -= 1;
    }
  }
  return -1;
}

/** Trims a destination and unwraps the optional `<...>` form. */
function cleanUrl(raw: string): string {
  const url = raw.trim();
  return url.startsWith("<") && url.endsWith(">") ? url.slice(1, -1).trim() : url;
}

function flanking(before: string, after: string, char: string): { open: boolean; close: boolean } {
  const beforeSpace = SPACE.test(before);
  const afterSpace = SPACE.test(after);
  const beforePunct = PUNCT.test(before);
  const afterPunct = PUNCT.test(after);
  const left = !afterSpace && (!afterPunct || beforeSpace || beforePunct);
  const right = !beforeSpace && (!beforePunct || afterSpace || afterPunct);
  if (char !== "_") return { open: left, close: right };
  // Intraword underscores (snake_case_name) are inert.
  return { open: left && (!right || beforePunct), close: right && (!left || afterPunct) };
}

/** Finds the run of `char` that closes an opener, skipping nested opener runs. */
function findCloser(
  text: string,
  from: number,
  char: string,
  tick: () => boolean,
): { start: number; length: number } | null {
  let depth = 0;
  for (let index = from; index < text.length; index += 1) {
    if (!tick()) return null;
    if (text[index] === "\\") index += 1;
    else if (text[index] === "`") index = skipCodeSpan(text, index);
    else if (text[index] === char) {
      let run = 1;
      while (text[index + run] === char) run += 1;
      if (char === "~" && run < 2) {
        index += run - 1;
        continue;
      }
      const marks = flanking(
        index > 0 ? (text[index - 1] ?? " ") : " ",
        text[index + run] ?? " ",
        char,
      );
      if (marks.close && depth === 0) return { start: index, length: run };
      if (marks.close) depth -= 1;
      else if (marks.open) depth += 1;
      index += run - 1;
    }
  }
  return null;
}

function parseInline(text: string, depth: number): Inline[] {
  const out: Inline[] = [];
  const length = text.length;
  let index = 0;
  let budget = length * 4 + 1_000;
  const tick = (): boolean => (budget -= 1) > 0;
  while (index < length) {
    const char = text[index] ?? "";
    const next = text[index + 1];
    if (char === "\\") {
      const escaped = next !== undefined && PUNCT.test(next);
      pushText(out, escaped ? (next as string) : "\\");
      index += escaped ? 2 : 1;
      continue;
    }
    if (char === "`") {
      let width = 1;
      while (text[index + width] === "`") width += 1;
      const close = findClosingBackticks(text, index + width, width);
      if (close < 0) {
        pushText(out, "`".repeat(width));
        index += width;
        continue;
      }
      let value = text.slice(index + width, close);
      if (
        value.length >= 2 &&
        value.startsWith(" ") &&
        value.endsWith(" ") &&
        value.trim() !== ""
      ) {
        value = value.slice(1, -1);
      }
      out.push({ type: "code", value });
      index = close + width;
      continue;
    }
    const isImage = char === "!" && next === "[";
    if (char === "[" || isImage) {
      const labelStart = isImage ? index + 2 : index + 1;
      const labelEnd = findLabelEnd(text, labelStart, tick);
      if (labelEnd >= 0) {
        const urlEnd = findUrlEnd(text, labelEnd + 2, tick);
        if (urlEnd >= 0) {
          const label = text.slice(labelStart, labelEnd);
          const href = cleanUrl(text.slice(labelEnd + 2, urlEnd));
          const children: Inline[] =
            depth < MAX_INLINE_DEPTH
              ? parseInline(label, depth + 1)
              : [{ type: "text", value: label }];
          if (isImage) out.push({ type: "image", src: href, alt: inlineText(children) });
          else out.push({ type: "link", href, children });
          index = urlEnd + 1;
          continue;
        }
      }
      // Not a link: the opening bracket is ordinary text.
    }
    if (char === "*" || char === "_" || char === "~") {
      let run = 1;
      while (text[index + run] === char) run += 1;
      if ((char !== "~" || run >= 2) && depth < MAX_INLINE_DEPTH) {
        const before = index > 0 ? (text[index - 1] ?? " ") : " ";
        const after = text[index + run] ?? " ";
        const close = flanking(before, after, char).open
          ? findCloser(text, index + run, char, tick)
          : null;
        if (close) {
          const inner = parseInline(text.slice(index + run, close.start), depth + 1);
          const use = char === "~" ? 2 : run >= 2 && close.length >= 2 ? 2 : 1;
          let node: Inline =
            use === 2
              ? char === "~"
                ? { type: "strike", children: inner }
                : { type: "strong", children: inner }
              : { type: "em", children: inner };
          let openLeft = run - use;
          let closeLeft = close.length - use;
          while (char !== "~" && openLeft >= 2 && closeLeft >= 2) {
            node = { type: "strong", children: [node] };
            openLeft -= 2;
            closeLeft -= 2;
          }
          if (char !== "~" && openLeft === 1 && closeLeft === 1) {
            node = { type: "em", children: [node] }; // ***x*** => em(strong(x))
            openLeft = 0;
            closeLeft = 0;
          }
          pushText(out, char.repeat(openLeft));
          out.push(node);
          pushText(out, char.repeat(closeLeft));
          index = close.start + close.length;
          continue;
        }
      }
      pushText(out, char.repeat(run));
      index += run;
      continue;
    }
    pushText(out, char);
    index += 1;
  }
  return out;
}

/** The visible text of a run of inline nodes (image alt text, link labels). */
export function inlineText(nodes: Inline[]): string {
  let out = "";
  for (const node of nodes) {
    if (node.type === "text" || node.type === "code") out += node.value;
    else if (node.type === "image") out += node.alt;
    else out += inlineText(node.children);
  }
  return out;
}

/* ------------------------------------------------------------------- block parsing ------ */
const HEADING = /^( {0,3})(#{1,6})(?:[ \t]+(.*))?$/;
const LIST_ITEM = /^( {0,3})([-+*]|(\d{1,9})[.)])([ \t]+|$)(.*)$/;
const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const QUOTE = /^ {0,3}>[ \t]?/;
const TASK = /^\[([ xX])\][ \t]+(.*)$/;
const ALIGN_CELL = /^:?-+:?$/;
type Fence = { char: string; length: number; info: string };
type Item = {
  indent: number;
  ordered: boolean;
  start: number;
  contentIndent: number;
  content: string;
};

const isBlank = (line: string): boolean => line.trim() === "";
function leadingSpaces(line: string): number {
  let count = 0;
  for (const char of line) {
    if (char === " ") count += 1;
    else if (char === "\t") count += 4;
    else break;
  }
  return count;
}

function stripIndent(line: string, count: number): string {
  let removed = 0;
  let index = 0;
  while (index < line.length && removed < count) {
    const char = line[index];
    if (char === " ") removed += 1;
    else if (char === "\t") removed += 4;
    else break;
    index += 1;
  }
  return line.slice(index);
}

function matchFence(line: string): Fence | null {
  const match = FENCE_OPEN.exec(line);
  if (!match) return null;
  const marker = match[2] ?? "";
  return { char: marker[0] ?? "`", length: marker.length, info: (match[3] ?? "").trim() };
}

function findFenceClose(lines: string[], from: number, end: number, open: Fence): number {
  for (let index = from; index < end; index += 1) {
    const marker = FENCE_CLOSE.exec(lines[index] ?? "")?.[1] ?? "";
    if (marker[0] === open.char && marker.length >= open.length) return index;
  }
  return -1;
}

function matchHeading(line: string): { level: 1 | 2 | 3 | 4 | 5 | 6; text: string } | null {
  const match = HEADING.exec(line);
  if (!match) return null;
  const level = (match[2] ?? "").length as 1 | 2 | 3 | 4 | 5 | 6;
  return { level, text: (match[3] ?? "").replace(/[ \t]+#+[ \t]*$/, "").trim() };
}

function isThematicBreak(line: string): boolean {
  const trimmed = line.trim();
  const char = trimmed[0];
  if (char !== "-" && char !== "*" && char !== "_") return false;
  let count = 0;
  for (const current of trimmed) {
    if (current === char) count += 1;
    else if (current !== " " && current !== "\t") return false;
  }
  return count >= 3;
}

function matchQuote(line: string): string | null {
  const match = QUOTE.exec(line);
  return match ? line.slice(match[0].length) : null;
}

function matchListItem(line: string): Item | null {
  const match = LIST_ITEM.exec(line);
  if (!match) return null;
  const indent = (match[1] ?? "").length;
  const markerWidth = (match[2] ?? "").length;
  const spaces = (match[4] ?? "").length;
  let content = match[5] ?? "";
  let contentIndent = indent + markerWidth + Math.max(spaces, 1);
  if (spaces > 4) {
    content = `${" ".repeat(spaces - 1)}${content}`;
    contentIndent = indent + markerWidth + 1;
  }
  return {
    indent,
    ordered: match[3] !== undefined,
    start: match[3] === undefined ? 0 : Number.parseInt(match[3], 10) || 1,
    contentIndent,
    content,
  };
}

function splitRow(line: string): string[] {
  const text = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return text.split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, "|"));
}

function tableAlignments(line: string): TableAlign[] | null {
  if (!line.includes("|")) return null;
  const cells = splitRow(line);
  if (cells.length === 0) return null;
  const align: TableAlign[] = [];
  for (const cell of cells) {
    const value = cell.trim();
    if (!ALIGN_CELL.test(value)) return null;
    const left = value.startsWith(":");
    const right = value.endsWith(":");
    align.push(left && right ? "center" : left ? "left" : right ? "right" : null);
  }
  return align;
}

function tryParseTable(
  lines: string[],
  start: number,
  end: number,
  depth: number,
): { block: Block; next: number } | null {
  if (start + 1 >= end) return null;
  const headerLine = lines[start] ?? "";
  if (!headerLine.includes("|")) return null;
  const align = tableAlignments(lines[start + 1] ?? "");
  if (!align) return null;
  const header = splitRow(headerLine);
  if (header.length !== align.length) return null;
  const rows: Inline[][][] = [];
  let index = start + 2;
  while (index < end) {
    const line = lines[index] ?? "";
    if (isBlank(line) || !line.includes("|")) break;
    const cells = splitRow(line);
    rows.push(header.map((_, column) => parseInline((cells[column] ?? "").trim(), depth + 1)));
    index += 1;
  }
  return {
    block: {
      type: "table",
      align,
      header: header.map((cell) => parseInline(cell.trim(), depth + 1)),
      rows,
    },
    next: index,
  };
}

function parseList(
  lines: string[],
  start: number,
  end: number,
  first: Item,
  depth: number,
): { block: Block; next: number } {
  const items: ListItem[] = [];
  let index = start;
  while (index < end) {
    while (index < end && isBlank(lines[index] ?? "")) index += 1;
    if (index >= end) break;
    const item = matchListItem(lines[index] ?? "");
    if (!item || item.ordered !== first.ordered || item.indent !== first.indent) break;
    let content = item.content;
    let task: TaskState | null = null;
    const taskMatch = TASK.exec(content);
    if (taskMatch) {
      task = (taskMatch[1] ?? "").toLowerCase() === "x" ? "done" : "todo";
      content = taskMatch[2] ?? "";
    }
    const itemLines: string[] = [content];
    let cursor = index + 1;
    while (cursor < end) {
      const line = lines[cursor] ?? "";
      if (isBlank(line)) {
        let next = cursor + 1;
        while (next < end && isBlank(lines[next] ?? "")) next += 1;
        if (next >= end || leadingSpaces(lines[next] ?? "") < item.contentIndent) break;
        itemLines.push("");
        cursor += 1;
        continue;
      }
      if (leadingSpaces(line) < item.contentIndent) break;
      itemLines.push(stripIndent(line, item.contentIndent));
      cursor += 1;
    }
    while (itemLines.length > 0 && isBlank(itemLines[itemLines.length - 1] ?? "")) itemLines.pop();
    items.push({ blocks: parseBlocks(itemLines, 0, itemLines.length, depth + 1), task });
    index = cursor;
  }
  return {
    block: { type: "list", ordered: first.ordered, start: first.start, items },
    next: index,
  };
}

function parseBlocks(lines: string[], start: number, end: number, depth: number): Block[] {
  if (depth > MAX_BLOCK_DEPTH) {
    const text = lines.slice(start, end).join(" ").trim();
    return text ? [{ type: "paragraph", children: parseInline(text, 0) }] : [];
  }
  const blocks: Block[] = [];
  let index = start;
  while (index < end) {
    const line = lines[index] ?? "";
    if (isBlank(line)) {
      index += 1;
      continue;
    }
    const fence = matchFence(line);
    if (fence) {
      const close = findFenceClose(lines, index + 1, end, fence);
      const value = lines.slice(index + 1, close < 0 ? end : close).join("\n");
      const lang = fence.info.length > 0 ? (fence.info.split(/\s+/)[0] ?? null) : null;
      blocks.push({ type: "codeBlock", lang, value });
      index = close < 0 ? end : close + 1;
      continue;
    }
    const heading = matchHeading(line);
    if (heading) {
      const children = parseInline(heading.text, 0);
      blocks.push({ type: "heading", level: heading.level, children });
      index += 1;
      continue;
    }
    if (isThematicBreak(line)) {
      blocks.push({ type: "thematicBreak" });
      index += 1;
      continue;
    }
    if (matchQuote(line) !== null) {
      const inner: string[] = [];
      while (index < end) {
        const stripped = matchQuote(lines[index] ?? "");
        if (stripped === null) break;
        inner.push(stripped);
        index += 1;
      }
      blocks.push({ type: "blockquote", children: parseBlocks(inner, 0, inner.length, depth + 1) });
      continue;
    }
    const item = matchListItem(line);
    if (item) {
      const parsed = parseList(lines, index, end, item, depth);
      blocks.push(parsed.block);
      index = parsed.next;
      continue;
    }
    const table = tryParseTable(lines, index, end, depth);
    if (table) {
      blocks.push(table.block);
      index = table.next;
      continue;
    }
    const paragraph: string[] = [line.trim()];
    let cursor = index + 1;
    while (cursor < end) {
      const next = lines[cursor] ?? "";
      const starts =
        matchFence(next) !== null ||
        HEADING.test(next) ||
        isThematicBreak(next) ||
        QUOTE.test(next) ||
        matchListItem(next) !== null;
      if (isBlank(next) || starts) break;
      paragraph.push(next.trim());
      cursor += 1;
    }
    blocks.push({ type: "paragraph", children: parseInline(paragraph.join(" ").trim(), 0) });
    index = cursor;
  }
  return blocks;
}

/** Parses untrusted Markdown into a plain AST. Never throws and never emits HTML. */
export function parseMarkdown(text: string): Block[] {
  if (typeof text !== "string" || text.length === 0) return [];
  const lines = text.split(/\r\n|\r|\n/);
  return parseBlocks(lines, 0, lines.length, 0);
}
