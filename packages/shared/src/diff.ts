/**
 * Minimal line diffing (Myers' O(ND) algorithm) for showing what changed between two
 * texts: change counts for the timeline and unified diffs for review views. Lines are
 * split on "\n"; a trailing "\r" stays part of the line, and a missing final newline
 * makes the last line differ, as in GNU diff.
 */

export interface LineDiffCounts {
  added: number;
  removed: number;
}

/** Lines added and removed going from `before` to `after` (a minimal line diff). */
export function countLineChanges(before: string, after: string): LineDiffCounts {
  let added = 0;
  let removed = 0;
  for (const op of diffLines(before, after)) {
    if (op.type === "insert") added += op.count;
    else if (op.type === "delete") removed += op.count;
  }
  return { added, removed };
}

export interface UnifiedDiffOptions {
  /** Unchanged lines shown around each change; default 3. */
  context?: number;
  /** Names for the header; default "before" / "after". Prefixing with "a/" is the caller's job. */
  fromName?: string;
  toName?: string;
  /** Stop and append a line "... (diff shortened)" when the output would exceed this many characters; default unlimited. */
  maxChars?: number;
}

/** A unified diff (`--- from`, `+++ to`, `@@ -a,b +c,d @@` hunks). Empty string when the texts are equal. */
export function unifiedDiff(before: string, after: string, options?: UnifiedDiffOptions): string {
  const context = Math.max(0, options?.context ?? 3);
  const fromName = options?.fromName ?? "before";
  const toName = options?.toName ?? "after";
  const maxChars = options?.maxChars;
  const beforeSeq = splitLines(before);
  const afterSeq = splitLines(after);
  const ops = diffLines(before, after);
  if (!ops.some((op) => op.type !== "equal")) return "";

  const { blocks, entries } = render(
    ops,
    beforeSeq.lines,
    afterSeq.lines,
    beforeSeq.endsWithNewline,
    afterSeq.endsWithNewline,
  );
  const groups = mergeGroups(blocks, context);
  const parts: string[] = [`--- ${fromName}`, `+++ ${toName}`];
  let cursor = 0;
  for (const group of groups) {
    const first = group[0] as Block;
    const last = group[group.length - 1] as Block;
    const aStart = Math.max(first.aStart - context, 0);
    const aEnd = Math.min(last.aStart + last.aCount + context, beforeSeq.lines.length);
    const bStart = Math.max(first.bStart - context, 0);
    const bEnd = Math.min(last.bStart + last.bCount + context, afterSeq.lines.length);
    const body: string[] = [];
    while (cursor < entries.length) {
      const entry = entries[cursor] as Entry;
      const end = entry.tag === "+" ? bEnd : aEnd;
      const position = entry.tag === "+" ? entry.b : entry.a;
      if (position >= end) break;
      const start = entry.tag === "+" ? bStart : aStart;
      if (position >= start) {
        body.push(`${entry.tag}${entry.text}`);
        if (entry.marker) body.push("\\ No newline at end of file");
      }
      cursor++;
    }
    parts.push(`@@ -${range(aStart, aEnd - aStart)} +${range(bStart, bEnd - bStart)} @@`, ...body);
  }
  if (maxChars === undefined) return parts.join("\n");
  const kept: string[] = [];
  let length = 0;
  for (const part of parts) {
    const added = (kept.length === 0 ? 0 : 1) + part.length;
    if (length + added > maxChars) {
      kept.push("... (diff shortened)");
      return kept.join("\n");
    }
    kept.push(part);
    length += added;
  }
  return kept.join("\n");
}

/** The GNU diff hunk range: 1-based start, count omitted when 1, ",0" for an empty side. */
function range(start: number, count: number): string {
  if (count === 0) return `${start},0`;
  if (count === 1) return `${start + 1}`;
  return `${start + 1},${count}`;
}

interface LineSequence {
  lines: string[];
  endsWithNewline: boolean;
}

function splitLines(text: string): LineSequence {
  const endsWithNewline = text.endsWith("\n");
  if (text === "") return { lines: [], endsWithNewline: false };
  const lines = text.split("\n");
  if (endsWithNewline) lines.pop();
  return { lines, endsWithNewline };
}

type Op =
  | { type: "equal"; a: number; b: number; count: number }
  | { type: "delete"; a: number; count: number }
  | { type: "insert"; b: number; count: number };

function diffLines(before: string, after: string): Op[] {
  const beforeSeq = splitLines(before);
  const afterSeq = splitLines(after);
  const ids = new Map<string, number>();
  const a = identify(beforeSeq, ids);
  const b = identify(afterSeq, ids);
  return diffIds(a, b);
}

/**
 * Lines become integer ids so comparisons are cheap. Every line but the last is followed
 * by a newline, and the last line keeps one only when the text ends with one, so texts
 * differing just in the final newline differ on their last line.
 */
function identify(sequence: LineSequence, ids: Map<string, number>): number[] {
  return sequence.lines.map((line, index) => {
    const key = index < sequence.lines.length - 1 || sequence.endsWithNewline ? `${line}\n` : line;
    let id = ids.get(key);
    if (id === undefined) {
      id = ids.size;
      ids.set(key, id);
    }
    return id;
  });
}

/** The minimal edit script as runs of equal, deleted and inserted lines, in order. */
function diffIds(a: number[], b: number[]): Op[] {
  const ops: Op[] = [];
  const min = Math.min(a.length, b.length);
  let start = 0;
  while (start < min && a[start] === b[start]) start++;
  let aEnd = a.length;
  let bEnd = b.length;
  while (aEnd > start && bEnd > start && a[aEnd - 1] === b[bEnd - 1]) {
    aEnd--;
    bEnd--;
  }
  if (start > 0) ops.push({ type: "equal", a: 0, b: 0, count: start });
  const aMid = aEnd - start;
  const bMid = bEnd - start;
  if (aMid === 0 && bMid === 0) {
    // The sequences are equal.
  } else if (aMid === 0) {
    ops.push({ type: "insert", b: start, count: bMid });
  } else if (bMid === 0) {
    ops.push({ type: "delete", a: start, count: aMid });
  } else if (!myers(a.slice(start, aEnd), b.slice(start, bEnd), start, ops)) {
    // Too different to diff within the memory bound: everything in between changed.
    ops.push({ type: "delete", a: start, count: aMid }, { type: "insert", b: start, count: bMid });
  }
  const tail = a.length - aEnd;
  if (tail > 0) ops.push({ type: "equal", a: aEnd, b: bEnd, count: tail });
  return ops;
}

/**
 * The trail keeps one copy of the frontier per edit distance, so memory grows with D x (N + M).
 * Beyond this many numbers (about 80 MB) the caller treats the region as wholly changed.
 */
const MAX_TRAIL_CELLS = 10_000_000;

/**
 * Myers' O(ND) algorithm on the middle region, appending its edit script to `out`. Returns
 * false, appending nothing, when the texts are too different for MAX_TRAIL_CELLS.
 */
function myers(a: number[], b: number[], offset: number, out: Op[]): boolean {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const off = max;
  const v: number[] = new Array<number>(2 * max + 2).fill(0);
  const trail: number[][] = [];
  let d = 0;
  let found = false;
  outer: while (d <= max) {
    if ((d + 1) * v.length > MAX_TRAIL_CELLS) return false;
    trail.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!)) {
        x = v[off + k + 1]!;
      } else {
        x = v[off + k - 1]! + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break outer;
      }
    }
    d++;
  }
  if (!found) return false;
  const raw: Op[] = [];
  let x = n;
  let y = m;
  for (; d > 0; d--) {
    const previous = trail[d] as number[];
    const k = x - y;
    const insert = k === -d || (k !== d && previous[off + k - 1]! < previous[off + k + 1]!);
    const x0 = insert ? previous[off + k + 1]! : previous[off + k - 1]! + 1;
    const y0 = x0 - k;
    while (x > x0) {
      raw.push({ type: "equal", a: offset + x - 1, b: offset + y - 1, count: 1 });
      x--;
      y--;
    }
    if (insert) {
      raw.push({ type: "insert", b: offset + y0 - 1, count: 1 });
      y = y0 - 1;
    } else {
      raw.push({ type: "delete", a: offset + x0 - 1, count: 1 });
      x = x0 - 1;
    }
  }
  while (x > 0 && y > 0) {
    raw.push({ type: "equal", a: offset + x - 1, b: offset + y - 1, count: 1 });
    x--;
    y--;
  }
  raw.reverse();
  out.push(...coalesce(raw));
  return true;
}

function coalesce(ops: Op[]): Op[] {
  const merged: Op[] = [];
  for (const op of ops) {
    const last = merged[merged.length - 1];
    if (last !== undefined && last.type === op.type) {
      if (
        op.type === "equal" &&
        last.type === "equal" &&
        last.a + last.count === op.a &&
        last.b + last.count === op.b
      )
        last.count += op.count;
      else if (op.type === "delete" && last.type === "delete" && last.a + last.count === op.a)
        last.count += op.count;
      else if (op.type === "insert" && last.type === "insert" && last.b + last.count === op.b)
        last.count += op.count;
      else merged.push(op);
    } else {
      merged.push(op);
    }
  }
  return merged;
}

interface Block {
  aStart: number;
  aCount: number;
  bStart: number;
  bCount: number;
}

interface Entry {
  tag: " " | "-" | "+";
  text: string;
  a: number;
  b: number;
  marker: boolean;
}

/** Change blocks (maximal runs of edits) and the lines to print, deletes before inserts. */
function render(
  ops: Op[],
  aLines: string[],
  bLines: string[],
  aEndsNewline: boolean,
  bEndsNewline: boolean,
): { blocks: Block[]; entries: Entry[] } {
  const blocks: Block[] = [];
  const entries: Entry[] = [];
  let ai = 0;
  let bi = 0;
  let i = 0;
  while (i < ops.length) {
    const op = ops[i] as Op;
    if (op.type === "equal") {
      for (let j = 0; j < op.count; j++) {
        // Equal lines end the same way in both texts, so either side tells.
        const marker = ai + j === aLines.length - 1 && !aEndsNewline;
        entries.push({ tag: " ", text: aLines[ai + j] as string, a: ai + j, b: bi + j, marker });
      }
      ai += op.count;
      bi += op.count;
      i++;
      continue;
    }
    const aStart = ai;
    const bStart = bi;
    while (i < ops.length && (ops[i] as Op).type !== "equal") {
      const change = ops[i] as Op;
      if (change.type === "delete") ai += change.count;
      else bi += change.count;
      i++;
    }
    for (let index = aStart; index < ai; index++) {
      entries.push({
        tag: "-",
        text: aLines[index] as string,
        a: index,
        b: -1,
        marker: index === aLines.length - 1 && !aEndsNewline,
      });
    }
    for (let index = bStart; index < bi; index++) {
      entries.push({
        tag: "+",
        text: bLines[index] as string,
        a: -1,
        b: index,
        marker: index === bLines.length - 1 && !bEndsNewline,
      });
    }
    blocks.push({ aStart, aCount: ai - aStart, bStart, bCount: bi - bStart });
  }
  return { blocks, entries };
}

/** Hunks: change blocks whose context overlaps are merged into one group. */
function mergeGroups(blocks: Block[], context: number): Block[][] {
  const groups: Block[][] = [];
  for (const block of blocks) {
    const current = groups[groups.length - 1];
    const last = current === undefined ? undefined : (current[current.length - 1] as Block);
    if (
      current !== undefined &&
      last !== undefined &&
      block.aStart - (last.aStart + last.aCount) <= 2 * context
    ) {
      current.push(block);
    } else {
      groups.push([block]);
    }
  }
  return groups;
}
