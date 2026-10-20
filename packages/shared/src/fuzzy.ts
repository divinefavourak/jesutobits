/**
 * Fuzzy matching for quick open (`Ctrl+P`) and the command palette (UX_AND_INTERFACE.md
 * section 5.3). The query's characters must appear in order, ignoring case. Matches score
 * higher at word starts (after `/`, `-`, `_`, `.`, a space, or a lower-to-upper case change)
 * and in runs, and a match inside the file name beats one spread across folders.
 */

export interface FuzzyMatch {
  score: number;
  /** Indexes into the candidate of the matched characters, for highlighting. */
  positions: number[];
}

const BOUNDARY_CHARS = new Set(["/", "\\", "-", "_", ".", " "]);

export function fuzzyMatch(query: string, candidate: string): FuzzyMatch | undefined {
  if (query === "") return { score: 0, positions: [] };
  const lastSeparator = Math.max(candidate.lastIndexOf("/"), candidate.lastIndexOf("\\"));
  const nameStart = lastSeparator + 1;
  // Prefer an alignment inside the file name; fall back to the whole path.
  const inName = align(query, candidate, nameStart);
  const positions = inName ?? align(query, candidate, 0);
  if (!positions) return undefined;

  let score = 0;
  let previous = -2;
  for (const position of positions) {
    score += 1;
    if (isBoundary(candidate, position)) score += 6;
    if (position === previous + 1) score += 4;
    if (position >= nameStart) score += 2;
    previous = position;
  }
  if (inName && positions[0] === nameStart) score += 6;
  // An exact file name (ignoring case and extension) is what the user meant.
  const name = candidate.slice(nameStart).toLowerCase();
  const lower = query.toLowerCase();
  if (name === lower || name.startsWith(`${lower}.`)) score += 20;
  // Among equals, shorter and shallower paths first.
  score -= candidate.length * 0.01;
  return { score, positions };
}

/**
 * Matches `query` as a subsequence of `candidate` from `start`, preferring for each
 * character a word-start occurrence when one comes before the next plain occurrence's run
 * ends. Returns undefined when there is no match.
 */
function align(query: string, candidate: string, start: number): number[] | undefined {
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  const positions: number[] = [];
  let from = start;
  for (let i = 0; i < q.length; i++) {
    const char = q[i] as string;
    const plain = c.indexOf(char, from);
    if (plain === -1) return undefined;
    let chosen = plain;
    // Continue a run if possible; otherwise jump to a word start of this character,
    // as long as the rest of the query still fits after it.
    const continuesRun = positions.length > 0 && plain === (positions.at(-1) as number) + 1;
    if (!continuesRun && !isBoundary(candidate, plain)) {
      for (let j = plain + 1; j < c.length; j++) {
        if (c[j] === char && isBoundary(candidate, j) && fits(q, i + 1, c, j + 1)) {
          chosen = j;
          break;
        }
      }
    }
    positions.push(chosen);
    from = chosen + 1;
  }
  return positions;
}

function fits(q: string, qi: number, c: string, from: number): boolean {
  let at = from;
  for (let i = qi; i < q.length; i++) {
    at = c.indexOf(q[i] as string, at);
    if (at === -1) return false;
    at += 1;
  }
  return true;
}

function isBoundary(text: string, index: number): boolean {
  if (index === 0) return true;
  const before = text[index - 1] as string;
  const char = text[index] as string;
  if (BOUNDARY_CHARS.has(before)) return true;
  return (
    before === before.toLowerCase() &&
    before !== before.toUpperCase() &&
    char !== char.toLowerCase()
  );
}

/** The best `limit` candidates for `query`, highest score first, stable for ties. */
export function fuzzyFilter<T>(
  query: string,
  items: Iterable<T>,
  text: (item: T) => string,
  limit: number,
): Array<{ item: T } & FuzzyMatch> {
  const results: Array<{ item: T; index: number } & FuzzyMatch> = [];
  let index = 0;
  for (const item of items) {
    const match = fuzzyMatch(query, text(item));
    if (match) results.push({ item, index, ...match });
    index++;
  }
  results.sort((a, b) => b.score - a.score || a.index - b.index);
  return results.slice(0, limit).map(({ item, score, positions }) => ({ item, score, positions }));
}
