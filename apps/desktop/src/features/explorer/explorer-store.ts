import { fsChangedEvent, type DirEntry } from "@jesutobits/protocol";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { HostBridge } from "../../host-bridge";
import type { ProjectStore } from "../../state/project-store";

export interface DirListing {
  /** Null until the first listing arrives. */
  entries: DirEntry[] | null;
  loading: boolean;
  /** Why the last listing failed, from the runtime. */
  error: string | null;
}

export type ExplorerEdit =
  { kind: "rename"; path: string } | { kind: "newFile" | "newFolder"; parent: string };

export interface ExplorerState {
  /** Listings by project-relative folder path; "" is the project folder. */
  dirs: Record<string, DirListing>;
  /** Expanded folders. The project folder is always shown expanded. */
  expanded: Record<string, true>;
  selected: string | null;
  /** The inline name field, when one is open. */
  editing: ExplorerEdit | null;
  /** Why the last file action failed, in the runtime's words. */
  error: string | null;

  /** Lists one folder, again if it was listed before. */
  load(path: string): Promise<void>;
  toggle(path: string): void;
  expand(path: string): void;
  collapse(path: string): void;
  collapseAll(): void;
  select(path: string | null): void;
  /** Selects a file and opens it in the editor. */
  open(path: string): void;
  /** Lists every loaded folder again. */
  refresh(): void;
  startEdit(edit: ExplorerEdit): void;
  cancelEdit(): void;
  /** Creates or renames with the typed name; the field stays open on failure. */
  commitEdit(name: string): Promise<void>;
  trash(path: string): Promise<void>;
  reveal(path: string): Promise<void>;
  dismissError(): void;
}

export type ExplorerStore = StoreApi<ExplorerState>;

/** Waits this long after an `fs.changed` batch for more before listing again. */
export const REFRESH_DELAY_MS = 50;

export function parentOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

export function joinPath(parent: string, name: string): string {
  return parent === "" ? name : `${parent}/${name}`;
}

const EMPTY = { dirs: {}, expanded: {}, selected: null, editing: null, error: null };

/**
 * The file tree of the open project (UX_AND_INTERFACE.md section 5.1). Folders are listed
 * only when shown (NFR-019) and listed again when `fs.changed` reports changes in them or
 * the project is reopened after a runtime restart. Every change goes through the runtime's
 * `fs.*` methods (invariant 4).
 */
export function createExplorerStore(
  bridge: HostBridge,
  projects: ProjectStore,
  options: { open?: (path: string) => void } = {},
): ExplorerStore {
  let projectId: string | null = null;
  let generation = 0;
  let due = new Set<string>();
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;

  const store = createStore<ExplorerState>()((set, get) => {
    /** Runs a file action; a failure becomes `error` and the action reports false. */
    const act = async (work: () => Promise<unknown>): Promise<boolean> => {
      set({ error: null });
      try {
        await work();
        return true;
      } catch (error) {
        set({ error: messageOf(error) });
        return false;
      }
    };

    return {
      ...EMPTY,

      load: async (path) => {
        const forProject = projectId;
        set((state) => ({
          dirs: {
            ...state.dirs,
            [path]: { entries: state.dirs[path]?.entries ?? null, loading: true, error: null },
          },
        }));
        try {
          const { entries } = await bridge.rpc("fs.listDir", { path });
          if (projectId !== forProject) return;
          set((state) => ({
            dirs: { ...state.dirs, [path]: { entries, loading: false, error: null } },
          }));
        } catch (error) {
          if (projectId !== forProject) return;
          const code = (error as { code?: string }).code;
          if (path !== "" && (code === "fs.not_found" || code === "fs.not_a_directory")) {
            // The folder went away: forget it and what was under it.
            set((state) => forget(state, path));
            return;
          }
          set((state) => ({
            dirs: {
              ...state.dirs,
              [path]: {
                entries: state.dirs[path]?.entries ?? null,
                loading: false,
                error: messageOf(error),
              },
            },
          }));
        }
      },

      toggle: (path) => (get().expanded[path] ? get().collapse(path) : get().expand(path)),
      expand: (path) => {
        set((state) => ({ expanded: { ...state.expanded, [path]: true } }));
        if (!get().dirs[path]?.entries) void get().load(path);
      },
      collapse: (path) =>
        set((state) => {
          const { [path]: _removed, ...expanded } = state.expanded;
          return { expanded };
        }),
      collapseAll: () => set({ expanded: {} }),
      select: (path) => set({ selected: path }),
      open: (path) => {
        set({ selected: path });
        options.open?.(path);
      },
      refresh: () => {
        for (const path of Object.keys(get().dirs)) void get().load(path);
      },

      startEdit: (edit) => {
        set({ editing: edit, error: null });
        if (edit.kind !== "rename" && edit.parent !== "") get().expand(edit.parent);
      },
      cancelEdit: () => set({ editing: null }),
      commitEdit: async (rawName) => {
        const edit = get().editing;
        const name = rawName.trim();
        if (!edit) return;
        const target =
          edit.kind === "rename"
            ? joinPath(parentOf(edit.path), name)
            : joinPath(edit.parent, name);
        if (name === "" || (edit.kind === "rename" && target === edit.path)) {
          set({ editing: null });
          return;
        }
        // createDirectory also succeeds for a folder that exists; a new one must be new.
        const siblings = get().dirs[parentOf(target)]?.entries ?? [];
        if (edit.kind === "newFolder" && siblings.some((entry) => entry.name === name)) {
          set({ error: `${name} already exists here.` });
          return;
        }
        const done = await act(() =>
          edit.kind === "rename"
            ? bridge.rpc("fs.rename", { from: edit.path, to: target })
            : edit.kind === "newFile"
              ? bridge.rpc("fs.createFile", { path: target })
              : bridge.rpc("fs.createDirectory", { path: target }),
        );
        if (!done) return;
        set({ editing: null, selected: target });
        await get().load(parentOf(target));
        if (edit.kind === "newFile") options.open?.(target);
      },

      trash: async (path) => {
        const done = await act(() => bridge.rpc("fs.trash", { path }));
        if (!done) return;
        set((state) => ({
          ...forget(state, path),
          selected: state.selected === path ? null : state.selected,
        }));
        await get().load(parentOf(path));
      },
      reveal: async (path) => {
        await act(() => bridge.rpc("fs.reveal", { path }));
      },
      dismissError: () => set({ error: null }),
    };
  });

  /** Lists changed folders again once a burst of events settles, if they are shown. */
  const reloadSoon = (paths: Iterable<string>) => {
    for (const path of paths) due.add(path);
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      const { dirs, load } = store.getState();
      for (const path of due) if (path in dirs) void load(path);
      due = new Set();
    }, REFRESH_DELAY_MS);
  };

  projects.subscribe((state) => {
    const id = state.active?.id ?? null;
    if (state.generation === generation && id === projectId) return;
    const reopened = id !== null && id === projectId;
    generation = state.generation;
    projectId = id;
    if (reopened) {
      // The same project after a runtime restart: list what is shown again.
      store.getState().refresh();
      return;
    }
    store.setState(EMPTY);
    if (id) void store.getState().load("");
  });

  bridge.onRuntimeEvent((event) => {
    if (event.type !== fsChangedEvent.type || event.projectId !== projectId) return;
    const parsed = fsChangedEvent.payload.safeParse(event);
    if (!parsed.success) return;
    if (parsed.data.overflow) {
      store.getState().refresh();
      return;
    }
    for (const change of parsed.data.changes) {
      if (change.kind === "removed" && change.isDirectory) {
        store.setState((state) => forget(state, change.path));
      }
    }
    reloadSoon(parsed.data.changes.map((change) => parentOf(change.path)));
  });

  return store;
}

/** Drops a folder's listing and expansion, and everything below it. */
function forget(
  state: Pick<ExplorerState, "dirs" | "expanded">,
  path: string,
): Pick<ExplorerState, "dirs" | "expanded"> {
  const below = (key: string) => key === path || key.startsWith(`${path}/`);
  return {
    dirs: Object.fromEntries(Object.entries(state.dirs).filter(([key]) => !below(key))),
    expanded: Object.fromEntries(
      Object.entries(state.expanded).filter(([key]) => !below(key)),
    ) as Record<string, true>,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
