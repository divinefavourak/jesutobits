import type { WorkspaceService } from "@jesutobits/services";

/** A project instructions file as the model sees it (FR-042). */
export interface InstructionFile {
  /** Project-relative. */
  path: string;
  text: string;
  /** Cut to the budget; the model and the timeline are told. */
  truncated: boolean;
}

const ROOT_FILES = ["AGENTS.md", ".jesutobits/instructions.md"];

/**
 * Loads the instructions files (AGENT_HARNESS.md section 4.2): `AGENTS.md` and
 * `.jesutobits/instructions.md` at the root, then the `AGENTS.md` of every folder between a
 * file the session touched and the root, nearest first. All share `maxChars`; what does
 * not fit is cut and marked. Missing or unreadable files are skipped.
 */
export async function loadInstructions(
  workspace: WorkspaceService,
  touchedPaths: Iterable<string>,
  maxChars: number,
): Promise<InstructionFile[]> {
  const nested: string[] = [];
  const seen = new Set<string>(ROOT_FILES);
  for (const path of touchedPaths) {
    const parts = path.split("/").slice(0, -1);
    // Nearest folder first, up to (not including) the root.
    for (let depth = parts.length; depth > 0; depth--) {
      const candidate = `${parts.slice(0, depth).join("/")}/AGENTS.md`;
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      nested.push(candidate);
    }
  }

  const files: InstructionFile[] = [];
  let left = maxChars;
  for (const path of [...ROOT_FILES, ...nested]) {
    if (left <= 0) break;
    let text: string;
    try {
      text = (await workspace.readText(path, 512 * 1024)).text;
    } catch {
      continue;
    }
    const truncated = text.length > left;
    files.push({ path, text: truncated ? text.slice(0, left) : text, truncated });
    left -= Math.min(text.length, left);
  }
  return files;
}
