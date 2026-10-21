import type { DirEntry } from "@jesutobits/protocol";
import type { ExplorerState } from "./explorer-store";

export type ExplorerRow =
  | {
      type: "entry";
      entry: DirEntry;
      /** aria-level: 1 for the project folder's children. */
      level: number;
      /** Folders only. */
      expanded: boolean;
      setSize: number;
      posInSet: number;
      renaming: boolean;
    }
  /** The inline name field for a new file or folder, first in its folder. */
  | { type: "create"; kind: "newFile" | "newFolder"; parent: string; level: number }
  /** A folder still listing, or whose listing failed. */
  | { type: "status"; parent: string; level: number; status: "loading" | "error"; message: string };

/**
 * The rows the tree shows, top to bottom: the project folder's entries and, under each
 * expanded folder, its own (depth first). Only these rows exist, so a project with 100,000
 * files costs what is expanded, not what is on disk (NFR-019).
 */
export function visibleRows(
  state: Pick<ExplorerState, "dirs" | "expanded" | "editing">,
): ExplorerRow[] {
  const rows: ExplorerRow[] = [];
  const visit = (parent: string, level: number) => {
    const listing = state.dirs[parent];
    const editing = state.editing;
    if (editing && editing.kind !== "rename" && editing.parent === parent) {
      rows.push({ type: "create", kind: editing.kind, parent, level });
    }
    if (!listing?.entries) {
      if (listing?.error) {
        rows.push({ type: "status", parent, level, status: "error", message: listing.error });
      } else {
        rows.push({ type: "status", parent, level, status: "loading", message: "" });
      }
      return;
    }
    if (listing.error) {
      rows.push({ type: "status", parent, level, status: "error", message: listing.error });
    }
    const entries = listing.entries;
    entries.forEach((entry, index) => {
      const folder = entry.kind === "directory";
      const expanded = folder && state.expanded[entry.path] === true;
      rows.push({
        type: "entry",
        entry,
        level,
        expanded,
        setSize: entries.length,
        posInSet: index + 1,
        renaming: editing?.kind === "rename" && editing.path === entry.path,
      });
      if (expanded) visit(entry.path, level + 1);
    });
  };
  visit("", 1);
  return rows;
}

/** The path a row stands for, used as its identity and for keyboard moves. */
export function rowKey(row: ExplorerRow): string {
  if (row.type === "entry") return row.entry.path;
  return `${row.type}:${row.parent}`;
}
