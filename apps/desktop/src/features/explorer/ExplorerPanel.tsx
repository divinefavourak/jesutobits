import type { DirEntry } from "@jesutobits/protocol";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { useStore } from "zustand";
import { t } from "../../i18n";
import { useProjects, useWorkbench } from "../../state/workbench-context";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { ChevronDownIcon, ChevronRightIcon } from "../../ui/icons";
import { ContextMenu, type MenuItem } from "../../ui/Menu";
import { rowKey, visibleRows, type ExplorerRow } from "./explorer-rows";
import { parentOf, type ExplorerState } from "./explorer-store";

/** Rows drawn above and below the visible ones, so scrolling does not show gaps. */
const OVERSCAN = 8;
/** Row height in rem; rows are positioned, not measured, so only visible ones exist. */
const ROW_REM = 1.75;

/** The file explorer (UX_AND_INTERFACE.md section 5.1, FR-072). */
export function ExplorerPanel() {
  const { explorer } = useWorkbench();
  const state = useStore(explorer);
  const projectPath = useProjects((projects) => projects.active?.path ?? "");
  const [menu, setMenu] = useState<{ entry: DirEntry; at: { x: number; y: number } } | null>(null);
  const [trashing, setTrashing] = useState<DirEntry | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const root = state.dirs[""];

  /** New files go in the selected folder, or next to the selected file. */
  const targetFolder = () => {
    const selected = state.selected;
    if (selected === null) return "";
    const entry = findEntry(state, selected);
    return entry?.kind === "directory" ? selected : parentOf(selected);
  };

  const focusTree = () => requestAnimationFrame(() => treeRef.current?.focus());
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch (error) {
      explorer.setState({ error: t("explorer.copyFailed", { reason: String(error) }) });
    }
  };

  const menuItems = (entry: DirEntry): MenuItem[] => {
    const folder = entry.kind === "directory" ? entry.path : parentOf(entry.path);
    return [
      {
        label: t("explorer.newFile"),
        onSelect: () => explorer.getState().startEdit({ kind: "newFile", parent: folder }),
      },
      {
        label: t("explorer.newFolder"),
        onSelect: () => explorer.getState().startEdit({ kind: "newFolder", parent: folder }),
      },
      {
        label: t("explorer.rename"),
        onSelect: () => explorer.getState().startEdit({ kind: "rename", path: entry.path }),
      },
      { label: t("explorer.trash"), onSelect: () => setTrashing(entry) },
      {
        label: t("explorer.copyPath"),
        onSelect: () => void copy(absolutePath(projectPath, entry.path)),
      },
      { label: t("explorer.copyRelativePath"), onSelect: () => void copy(entry.path) },
      { label: t("explorer.reveal"), onSelect: () => void explorer.getState().reveal(entry.path) },
    ];
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap gap-1 border-b border-border px-1 py-1">
        <Button
          variant="ghost"
          onClick={() => explorer.getState().startEdit({ kind: "newFile", parent: targetFolder() })}
        >
          {t("explorer.newFile")}
        </Button>
        <Button
          variant="ghost"
          onClick={() =>
            explorer.getState().startEdit({ kind: "newFolder", parent: targetFolder() })
          }
        >
          {t("explorer.newFolder")}
        </Button>
        <Button variant="ghost" onClick={() => explorer.getState().refresh()}>
          {t("explorer.refresh")}
        </Button>
        <Button variant="ghost" onClick={() => explorer.getState().collapseAll()}>
          {t("explorer.collapseAll")}
        </Button>
      </div>

      {state.error && (
        <div
          role="alert"
          className="m-1 flex items-start justify-between gap-2 rounded-md border border-danger bg-danger-subtle px-2 py-1 text-text"
        >
          <p className="m-0">{t("explorer.failed", { reason: state.error })}</p>
          <Button variant="ghost" onClick={() => explorer.getState().dismissError()}>
            {t("errors.dismiss")}
          </Button>
        </div>
      )}

      {root?.entries?.length === 0 && !state.editing ? (
        <p className="m-0 p-3 text-text-muted">{t("explorer.empty")}</p>
      ) : (
        <Tree
          treeRef={treeRef}
          state={state}
          onMenu={(entry, at) => setMenu({ entry, at })}
          onTrash={setTrashing}
        />
      )}

      {menu && (
        <ContextMenu
          label={t("explorer.menu", { name: menu.entry.name })}
          items={menuItems(menu.entry)}
          at={menu.at}
          onClose={() => {
            setMenu(null);
            focusTree();
          }}
        />
      )}

      <Dialog
        open={trashing !== null}
        title={t("explorer.trash.title", { name: trashing?.name ?? "" })}
        focusSelf
        onCancel={() => {
          setTrashing(null);
          focusTree();
        }}
        description={
          <>
            {trashing?.kind === "directory" && <p className="m-0">{t("explorer.trash.folder")}</p>}
            <p className="m-0">{t("explorer.trash.body")}</p>
          </>
        }
      >
        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            onClick={() => {
              setTrashing(null);
              focusTree();
            }}
          >
            {t("explorer.trash.cancel")}
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              const target = trashing;
              setTrashing(null);
              focusTree();
              if (target) void explorer.getState().trash(target.path);
            }}
          >
            {t("explorer.trash.confirm")}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

function Tree({
  treeRef,
  state,
  onMenu,
  onTrash,
}: {
  treeRef: RefObject<HTMLDivElement | null>;
  state: ExplorerState;
  onMenu: (entry: DirEntry, at: { x: number; y: number }) => void;
  onTrash: (entry: DirEntry) => void;
}) {
  const { explorer } = useWorkbench();
  const rows = useMemo(
    () => visibleRows(state),
    // visibleRows reads only these three.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.dirs, state.expanded, state.editing],
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(600);
  const [rowHeight, setRowHeight] = useState(22);
  const prefix = useId();

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const measure = () => {
      setViewport(element.clientHeight || 600);
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 13;
      setRowHeight(Math.round(rem * ROW_REM));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const entryIndexes = rows.flatMap((row, index) => (row.type === "entry" ? [index] : []));
  const selectedIndex = rows.findIndex(
    (row) => row.type === "entry" && row.entry.path === state.selected,
  );
  const activeIndex = selectedIndex === -1 ? (entryIndexes[0] ?? -1) : selectedIndex;
  const active = rows[activeIndex];
  const rowId = (index: number) => `${prefix}-row-${index}`;

  /** Keeps a row inside the scrolled view, so the active descendant exists in the DOM. */
  const reveal = (index: number) => {
    const element = scrollRef.current;
    if (!element) return;
    const top = index * rowHeight;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (top + rowHeight > element.scrollTop + element.clientHeight) {
      element.scrollTop = top + rowHeight - element.clientHeight;
    }
  };

  useEffect(() => {
    if (activeIndex >= 0) reveal(activeIndex);
    // Only when the active row changes, not on every scroll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIndex]);

  const selectIndex = (index: number | undefined) => {
    const row = index === undefined ? undefined : rows[index];
    if (row?.type === "entry") explorer.getState().select(row.entry.path);
  };

  const activate = (row: ExplorerRow) => {
    if (row.type !== "entry") return;
    if (row.entry.kind === "directory") explorer.getState().toggle(row.entry.path);
    else explorer.getState().open(row.entry.path);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!active || active.type !== "entry") return;
    const position = entryIndexes.indexOf(activeIndex);
    const folder = active.entry.kind === "directory";
    switch (event.key) {
      case "ArrowDown":
        selectIndex(entryIndexes[position + 1]);
        break;
      case "ArrowUp":
        selectIndex(entryIndexes[position - 1]);
        break;
      case "Home":
        selectIndex(entryIndexes[0]);
        break;
      case "End":
        selectIndex(entryIndexes.at(-1));
        break;
      case "ArrowRight":
        if (folder && !active.expanded) explorer.getState().expand(active.entry.path);
        else if (folder) selectIndex(entryIndexes[position + 1]);
        break;
      case "ArrowLeft":
        if (folder && active.expanded) explorer.getState().collapse(active.entry.path);
        else if (parentOf(active.entry.path) !== "")
          explorer.getState().select(parentOf(active.entry.path));
        break;
      case "Enter":
        activate(active);
        break;
      case "F2":
        explorer.getState().startEdit({ kind: "rename", path: active.entry.path });
        break;
      case "Delete":
        onTrash(active.entry);
        break;
      case "ContextMenu":
      case "F10": {
        if (event.key === "F10" && !event.shiftKey) return;
        const rect = scrollRef.current?.getBoundingClientRect();
        onMenu(active.entry, {
          x: (rect?.left ?? 0) + 24,
          y: (rect?.top ?? 0) + (activeIndex + 1) * rowHeight - (scrollRef.current?.scrollTop ?? 0),
        });
        break;
      }
      default:
        return;
    }
    event.preventDefault();
  };

  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + viewport) / rowHeight) + OVERSCAN);
  const editRow = rows.findIndex(
    (row) => row.type === "create" || (row.type === "entry" && row.renaming),
  );

  return (
    <div
      ref={scrollRef}
      className="relative min-h-0 flex-1 overflow-auto"
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
    >
      <div className="relative" style={{ height: rows.length * rowHeight }}>
        <div
          ref={treeRef}
          role="tree"
          aria-label={t("explorer.tree")}
          tabIndex={0}
          aria-activedescendant={active ? rowId(activeIndex) : undefined}
          onKeyDown={onKeyDown}
          className="group absolute inset-0 focus-visible:outline-none"
        >
          {rows.slice(first, last).map((row, offset) => {
            const index = first + offset;
            return (
              <Row
                key={rowKey(row)}
                id={rowId(index)}
                row={row}
                top={index * rowHeight}
                height={rowHeight}
                active={index === activeIndex}
                onClick={() => {
                  if (row.type !== "entry") return;
                  treeRef.current?.focus();
                  explorer.getState().select(row.entry.path);
                  activate(row);
                }}
                onContextMenu={(at) => {
                  if (row.type !== "entry") return;
                  explorer.getState().select(row.entry.path);
                  onMenu(row.entry, at);
                }}
              />
            );
          })}
        </div>
        {editRow !== -1 && rows[editRow] && (
          <NameField
            row={rows[editRow]}
            top={editRow * rowHeight}
            height={rowHeight}
            onDone={() => requestAnimationFrame(() => treeRef.current?.focus())}
          />
        )}
      </div>
    </div>
  );
}

function indent(level: number): number {
  return 4 + (level - 1) * 12;
}

function Row({
  id,
  row,
  top,
  height,
  active,
  onClick,
  onContextMenu,
}: {
  id: string;
  row: ExplorerRow;
  top: number;
  height: number;
  active: boolean;
  onClick: () => void;
  onContextMenu: (at: { x: number; y: number }) => void;
}) {
  const style = { top, height, paddingLeft: indent(row.level) };
  if (row.type === "create") {
    // The name field covers this slot; it is not a tree item.
    return null;
  }
  if (row.type === "status") {
    return (
      <div
        id={id}
        role="treeitem"
        aria-level={row.level}
        aria-disabled="true"
        aria-selected="false"
        style={style}
        className={`absolute inset-x-0 flex items-center truncate pl-5 ${
          row.status === "error" ? "text-danger" : "text-text-muted"
        }`}
      >
        {row.status === "loading"
          ? t("explorer.loading")
          : t("explorer.listFailed", { reason: row.message })}
      </div>
    );
  }
  const { entry } = row;
  const folder = entry.kind === "directory";
  const notes = [
    entry.link ? t("explorer.link") : null,
    entry.outside ? t("explorer.outside") : null,
  ].filter(Boolean);
  return (
    <div
      id={id}
      role="treeitem"
      aria-level={row.level}
      aria-setsize={row.setSize}
      aria-posinset={row.posInSet}
      aria-expanded={folder ? row.expanded : undefined}
      aria-selected={active}
      style={style}
      onClick={onClick}
      onContextMenu={(event) => {
        event.preventDefault();
        onContextMenu({ x: event.clientX, y: event.clientY });
      }}
      className={`absolute inset-x-0 flex cursor-pointer select-none items-center gap-1 whitespace-nowrap pr-2 ${
        active
          ? "bg-item-active group-focus-visible:outline group-focus-visible:outline-2 group-focus-visible:-outline-offset-2 group-focus-visible:outline-focus"
          : "hover:bg-item-hover"
      } ${row.renaming ? "invisible" : ""}`}
    >
      <span aria-hidden="true" className="inline-flex w-4 shrink-0 justify-center text-text-muted">
        {folder && (row.expanded ? <ChevronDownIcon /> : <ChevronRightIcon />)}
      </span>
      <span className={`truncate ${entry.ignored ? "italic text-text-muted" : "text-text"}`}>
        {entry.name}
      </span>
      {entry.ignored && <span className="sr-only">{`, ${t("explorer.ignored")}`}</span>}
      {notes.length > 0 && (
        <span className="truncate text-xs text-text-muted">({notes.join(", ")})</span>
      )}
    </div>
  );
}

/** The inline name field for New file, New folder and Rename. Enter saves, Esc cancels. */
function NameField({
  row,
  top,
  height,
  onDone,
}: {
  row: ExplorerRow;
  top: number;
  height: number;
  onDone: () => void;
}) {
  const { explorer } = useWorkbench();
  const inputRef = useRef<HTMLInputElement>(null);
  const renaming = row.type === "entry" ? row.entry : null;
  const [value, setValue] = useState(renaming?.name ?? "");
  const committing = useRef(false);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    // Select the name without its extension, as file managers do.
    const dot = renaming && renaming.kind !== "directory" ? renaming.name.lastIndexOf(".") : -1;
    input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
  }, [renaming]);

  const label =
    row.type === "create"
      ? t(row.kind === "newFile" ? "explorer.newFileName" : "explorer.newFolderName")
      : t("explorer.renameTo", { name: renaming?.name ?? "" });

  const commit = async () => {
    if (committing.current) return;
    committing.current = true;
    await explorer.getState().commitEdit(value);
    committing.current = false;
    if (!explorer.getState().editing) onDone();
  };

  return (
    <input
      ref={inputRef}
      aria-label={label}
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          void commit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          explorer.getState().cancelEdit();
          onDone();
        }
      }}
      onBlur={() => {
        if (explorer.getState().editing) void commit();
      }}
      style={{ top, height, left: indent(row.level) + 20 }}
      className="absolute right-1 rounded-sm border border-focus bg-surface px-1 text-text"
    />
  );
}

function findEntry(state: Pick<ExplorerState, "dirs">, path: string): DirEntry | undefined {
  return state.dirs[parentOf(path)]?.entries?.find((entry) => entry.path === path);
}

/** The project's absolute path joined with a relative one, with the project's separators. */
export function absolutePath(projectPath: string, relative: string): string {
  if (relative === "") return projectPath;
  const separator = projectPath.includes("\\") ? "\\" : "/";
  const base = projectPath.endsWith(separator) ? projectPath.slice(0, -1) : projectPath;
  return `${base}${separator}${relative.split("/").join(separator)}`;
}
