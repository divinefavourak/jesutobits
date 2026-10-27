import { ErrorCodes, fsChangedEvent, JesutobitsError } from "@jesutobits/protocol";
import { z } from "zod";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { HostBridge } from "../../host-bridge";
import type { ProjectStore } from "../../state/project-store";
import type { TextBuffers, TextFormat } from "./text-buffers";

export interface EditorTab {
  path: string;
  /** A preview tab (single click in the explorer) is replaced by the next one until pinned. */
  preview: boolean;
}

export type FileConflict =
  /** The file changed on disk while the tab had unsaved changes. */
  | { kind: "changed"; diskText: string; diskHash: string }
  /** The file is gone from disk. Saving creates it again. */
  | { kind: "deleted" };

export interface OpenFile {
  status: "loading" | "ready" | "failed";
  /** Why it cannot be shown: `fs.too_large`, `fs.binary`, `fs.not_found`, … */
  failure: { code: string; message: string } | null;
  /** The disk version the text is based on; saving refuses if the disk differs (FR-052). */
  hash: string | null;
  format: TextFormat | null;
  dirty: boolean;
  saving: boolean;
  conflict: FileConflict | null;
  /** The compare view (disk on the left, the tab on the right) is open. */
  comparing: boolean;
}

export interface Cursor {
  line: number;
  column: number;
}

export interface EditorState {
  tabs: EditorTab[];
  active: string | null;
  files: Record<string, OpenFile>;
  /** Last cursor per path, restored when the file opens again. */
  cursors: Record<string, Cursor>;
  /** Files shown in the editor, most recent first (quick open ranks them higher). */
  recent: string[];
  /** Why the last save failed, in the runtime's words. */
  error: string | null;
  /** A tab with unsaved changes the user asked to close: the dialog asks Save or Discard. */
  pendingClose: string | null;
  /** Counts requests to show a position (search results); the editor moves its cursor there. */
  revealRequest: { path: string; cursor: Cursor; count: number } | null;
  /** Leaving (closing the project or the window) with unsaved changes waits on the dialog. */
  leaving: { reason: "project" | "window"; decide: (leave: boolean) => void } | null;

  /** Opens a file; `preview` replaces the current preview tab instead of adding one. */
  open(path: string, options?: { preview?: boolean }): Promise<void>;
  pin(path: string): void;
  activate(path: string): void;
  /** Closes a tab now, discarding unsaved changes. */
  close(path: string): void;
  /** Closes a tab, or asks first (`pendingClose`) when it has unsaved changes. */
  requestClose(path: string): void;
  /** Answers `pendingClose`: save then close, discard, or keep it open. */
  resolveClose(choice: "save" | "discard" | "cancel"): Promise<void>;
  /**
   * Resolves true when leaving is fine: nothing unsaved, or the user chose Save all (and it
   * worked) or Don't save. False when they cancelled.
   */
  confirmLeave(reason: "project" | "window"): Promise<boolean>;
  /** The dirty tabs' paths. */
  unsaved(): string[];
  save(path: string): Promise<boolean>;
  /** Saves every dirty tab; true when all succeeded. */
  saveAll(): Promise<boolean>;
  /** Keeps the tab's text; the next save replaces what is on disk. */
  keepMine(path: string): void;
  /** Replaces the tab's text with what is on disk. */
  takeTheirs(path: string): Promise<void>;
  setComparing(path: string, comparing: boolean): void;
  setCursor(path: string, cursor: Cursor): void;
  /** Opens a file with the cursor at `cursor`, even when it is already open. */
  reveal(path: string, cursor: Cursor): Promise<void>;
  /**
   * Reads the file again and reconciles: update a clean tab, flag a dirty one. A file gone
   * from disk goes through `removed`.
   */
  checkAgainstDisk(path: string): Promise<void>;
  /**
   * A file or folder is gone from disk (moved to the trash in the explorer, or deleted
   * elsewhere). Clean tabs for it, or for files under it, close; tabs with unsaved changes
   * stay with the "deleted on disk" bar, so nothing typed is lost.
   */
  removed(path: string): void;
  dismissError(): void;
}

export type EditorStore = StoreApi<EditorState>;

/** The `ui-state.json` key with each project's open tabs and cursors (FR-008). */
export const EDITORS_KEY = "editors";
export const SAVE_DELAY_MS = 250;
/** How many recently shown files are remembered (the runtime accepts up to 50). */
export const MAX_RECENT = 50;
const CHECK_DELAY_MS = 50;

const StoredEditorsSchema = z.object({
  tabs: z.array(z.object({ path: z.string().min(1), preview: z.boolean() })).max(100),
  active: z.string().nullable(),
  cursors: z.record(
    z.string(),
    z.object({ line: z.number().int().min(1), column: z.number().int().min(1) }),
  ),
  recent: z.array(z.string().min(1)).max(MAX_RECENT).default([]),
});
type StoredEditors = z.input<typeof StoredEditorsSchema>;

const EMPTY = {
  tabs: [],
  active: null,
  files: {},
  cursors: {},
  revealRequest: null,
  recent: [],
  error: null,
  pendingClose: null,
  leaving: null,
};

/**
 * Editor tabs of the open project (UX_AND_INTERFACE.md section 5.2, FR-073): reading and
 * saving through `fs.*` with the hash last read (FR-052), dirty state, preview tabs, and
 * external changes from `fs.changed` (a clean tab updates in place, a dirty one shows the
 * "changed on disk" bar). Open tabs and cursors are kept per project in `ui-state.json`.
 */
export function createEditorStore(
  bridge: HostBridge,
  projects: ProjectStore,
  buffers: TextBuffers,
): EditorStore {
  let projectId: string | null = null;
  let generation = 0;
  let stored: Record<string, unknown> = {};
  let persistTimer: ReturnType<typeof setTimeout> | undefined;
  /** While a project's tabs are being restored, nothing is saved (it would save half). */
  let restoring = false;
  const checkTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Paths whose disk check waits for a save in flight. */
  const checkAfterSave = new Set<string>();

  const store = createStore<EditorState>()((set, get) => {
    const update = (path: string, patch: Partial<OpenFile>) =>
      set((state) => {
        const file = state.files[path];
        return file ? { files: { ...state.files, [path]: { ...file, ...patch } } } : {};
      });

    const load = async (path: string) => {
      const forProject = projectId;
      try {
        const file = await bridge.rpc("fs.readFile", { path });
        if (projectId !== forProject || !get().files[path]) return;
        await buffers.load(path, file.text, file.format);
        if (projectId !== forProject || !get().files[path]) return;
        update(path, { status: "ready", hash: file.hash, format: file.format, dirty: false });
      } catch (error) {
        if (projectId !== forProject || !get().files[path]) return;
        update(path, { status: "failed", failure: failureOf(error) });
      }
    };

    const newFile = (): OpenFile => ({
      status: "loading",
      failure: null,
      hash: null,
      format: null,
      dirty: false,
      saving: false,
      conflict: null,
      comparing: false,
    });

    return {
      ...EMPTY,

      open: async (path, options = {}) => {
        const { tabs } = get();
        const existing = tabs.find((tab) => tab.path === path);
        if (existing) {
          if (!options.preview && existing.preview) get().pin(path);
          set((state) => ({ active: path, recent: touch(state.recent, path) }));
          return;
        }
        const preview = options.preview === true;
        // A preview tab gives way to the next preview, unless it has changes.
        const replaced = preview
          ? tabs.find((tab) => tab.preview && !get().files[tab.path]?.dirty)
          : undefined;
        const nextTabs = replaced
          ? tabs.map((tab) => (tab === replaced ? { path, preview } : tab))
          : [...tabs, { path, preview }];
        if (replaced) dropFile(replaced.path);
        set((state) => ({
          tabs: nextTabs,
          active: path,
          recent: touch(state.recent, path),
          files: { ...state.files, [path]: newFile() },
        }));
        await load(path);
      },

      pin: (path) =>
        set((state) => ({
          tabs: state.tabs.map((tab) => (tab.path === path ? { ...tab, preview: false } : tab)),
        })),

      activate: (path) => set((state) => ({ active: path, recent: touch(state.recent, path) })),

      close: (path) => {
        const { tabs, active } = get();
        const index = tabs.findIndex((tab) => tab.path === path);
        if (index === -1) return;
        const nextTabs = tabs.filter((tab) => tab.path !== path);
        const nextActive =
          active === path ? (nextTabs[Math.min(index, nextTabs.length - 1)]?.path ?? null) : active;
        dropFile(path);
        set({ tabs: nextTabs, active: nextActive });
      },

      requestClose: (path) => {
        if (get().files[path]?.dirty) set({ pendingClose: path });
        else get().close(path);
      },

      resolveClose: async (choice) => {
        const path = get().pendingClose;
        if (!path) return;
        if (choice === "cancel") {
          set({ pendingClose: null });
          return;
        }
        if (choice === "save" && !(await get().save(path))) {
          // The save failed (conflict or error): keep the tab and say why.
          set({ pendingClose: null });
          return;
        }
        set({ pendingClose: null });
        get().close(path);
      },

      unsaved: () =>
        get()
          .tabs.filter((tab) => get().files[tab.path]?.dirty)
          .map((tab) => tab.path),

      confirmLeave: (reason) => {
        if (get().unsaved().length === 0) return Promise.resolve(true);
        return new Promise<boolean>((resolve) =>
          set({
            leaving: {
              reason,
              decide: (leave) => {
                set({ leaving: null });
                resolve(leave);
              },
            },
          }),
        );
      },

      save: async (path) => {
        const file = get().files[path];
        const snapshot = buffers.snapshot(path);
        if (!file || file.status !== "ready" || !snapshot || file.saving) return false;
        update(path, { saving: true });
        set({ error: null });
        try {
          const written = await bridge.rpc("fs.writeFile", {
            path,
            text: snapshot.text,
            expectedHash: file.conflict?.kind === "deleted" ? null : file.hash,
          });
          buffers.markSaved(path, snapshot.version);
          update(path, { hash: written.hash, saving: false, conflict: null, comparing: false });
          get().pin(path);
          return true;
        } catch (error) {
          update(path, { saving: false });
          if (error instanceof JesutobitsError && error.code === ErrorCodes.fsConflict) {
            // Someone else changed it: show the bar instead of overwriting (FR-052).
            await get().checkAgainstDisk(path);
          } else {
            set({ error: messageOf(error) });
          }
          return false;
        } finally {
          if (checkAfterSave.delete(path)) void get().checkAgainstDisk(path);
        }
      },

      saveAll: async () => {
        const dirty = get().tabs.filter((tab) => get().files[tab.path]?.dirty);
        const results = await Promise.all(dirty.map((tab) => get().save(tab.path)));
        return results.every(Boolean);
      },

      keepMine: (path) => {
        const conflict = get().files[path]?.conflict;
        if (!conflict) return;
        // The next save is based on the disk version the user has now seen.
        update(path, {
          conflict: conflict.kind === "deleted" ? conflict : null,
          comparing: false,
          ...(conflict.kind === "changed" && { hash: conflict.diskHash }),
        });
      },

      takeTheirs: async (path) => {
        const conflict = get().files[path]?.conflict;
        if (conflict?.kind !== "changed") return;
        await buffers.replaceFromDisk(path, conflict.diskText);
        update(path, { conflict: null, comparing: false, hash: conflict.diskHash, dirty: false });
      },

      setComparing: (path, comparing) => update(path, { comparing }),

      setCursor: (path, cursor) =>
        set((state) => ({ cursors: { ...state.cursors, [path]: cursor } })),

      reveal: async (path, cursor) => {
        get().setCursor(path, cursor);
        await get().open(path);
        set((state) => ({
          revealRequest: { path, cursor, count: (state.revealRequest?.count ?? 0) + 1 },
        }));
      },

      checkAgainstDisk: async (path) => {
        const file = get().files[path];
        if (!file || file.status === "loading") return;
        if (file.saving) {
          checkAfterSave.add(path);
          return;
        }
        const forProject = projectId;
        try {
          const disk = await bridge.rpc("fs.readFile", { path });
          const current = get().files[path];
          if (projectId !== forProject || !current) return;
          if (current.status === "failed") {
            // It became readable (for example it shrank under the size limit).
            await buffers.load(path, disk.text, disk.format);
            update(path, { status: "ready", failure: null, hash: disk.hash, format: disk.format });
          } else if (disk.hash === current.hash) {
            if (current.conflict) update(path, { conflict: null });
          } else if (!buffers.isDirty(path)) {
            await buffers.replaceFromDisk(path, disk.text);
            update(path, { hash: disk.hash, format: disk.format, conflict: null, dirty: false });
          } else {
            update(path, {
              conflict: { kind: "changed", diskText: disk.text, diskHash: disk.hash },
            });
          }
        } catch (error) {
          if (projectId !== forProject || !get().files[path]) return;
          const failure = failureOf(error);
          if (failure.code === ErrorCodes.fsNotFound) get().removed(path);
          else if (get().files[path]?.status !== "ready")
            update(path, { status: "failed", failure });
        }
      },

      removed: (path) => {
        const gone = (tab: EditorTab) => tab.path === path || tab.path.startsWith(`${path}/`);
        for (const tab of get().tabs.filter(gone)) {
          const file = get().files[tab.path];
          if (file?.dirty) update(tab.path, { conflict: { kind: "deleted" }, comparing: false });
          else get().close(tab.path);
        }
      },

      dismissError: () => set({ error: null }),
    };

    function dropFile(path: string) {
      buffers.dispose(path);
      set((state) => {
        const { [path]: _file, ...files } = state.files;
        return { files };
      });
    }
  });

  buffers.onDirtyChange((path, dirty) =>
    store.setState((state) => {
      const file = state.files[path];
      return file && file.dirty !== dirty
        ? { files: { ...state.files, [path]: { ...file, dirty } } }
        : {};
    }),
  );

  const checkSoon = (path: string) => {
    clearTimeout(checkTimers.get(path));
    checkTimers.set(
      path,
      setTimeout(() => {
        checkTimers.delete(path);
        void store.getState().checkAgainstDisk(path);
      }, CHECK_DELAY_MS),
    );
  };

  // Tabs, the active tab and cursors are saved per project, like the layout.
  const persist = () => {
    if (!projectId) return;
    const { tabs, active, cursors, recent } = store.getState();
    const open = new Set(tabs.map((tab) => tab.path));
    const entry: StoredEditors = {
      tabs,
      active,
      cursors: Object.fromEntries(Object.entries(cursors).filter(([path]) => open.has(path))),
      recent,
    };
    stored = { ...stored, [projectId]: entry };
    bridge.uiState
      .update({ [EDITORS_KEY]: stored })
      .catch((error: unknown) =>
        bridge.log("warn", `saving open editors failed: ${String(error)}`),
      );
  };
  const flush = () => {
    if (persistTimer === undefined) return;
    clearTimeout(persistTimer);
    persistTimer = undefined;
    persist();
  };
  store.subscribe((state, previous) => {
    const unchanged =
      state.tabs === previous.tabs &&
      state.active === previous.active &&
      state.cursors === previous.cursors &&
      state.recent === previous.recent;
    if (restoring || unchanged) return;
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = undefined;
      persist();
    }, SAVE_DELAY_MS);
  });

  const restore = async (id: string) => {
    // Another project (or the same one opened again) replaces this restore.
    const forGeneration = generation;
    const stale = () => projectId !== id || generation !== forGeneration;
    const uiState = await bridge.uiState.get().catch(() => ({}) as Record<string, unknown>);
    const all = uiState[EDITORS_KEY];
    stored = typeof all === "object" && all !== null ? { ...all } : {};
    const parsed = StoredEditorsSchema.safeParse(stored[id]);
    if (stale()) return;
    restoring = false;
    if (!parsed.success) return;
    const { tabs, active, cursors, recent } = parsed.data;
    store.setState({ cursors });
    for (const tab of tabs) {
      await store.getState().open(tab.path, { preview: tab.preview });
      if (stale()) return;
      // A file deleted since last time is not reopened.
      if (store.getState().files[tab.path]?.failure?.code === ErrorCodes.fsNotFound) {
        store.getState().close(tab.path);
      }
    }
    if (active && store.getState().tabs.some((tab) => tab.path === active)) {
      store.setState({ active });
    }
    // Reopening the tabs reordered the list; the stored order is the real one.
    store.setState({ recent });
  };

  projects.subscribe((state) => {
    const id = state.active?.id ?? null;
    if (state.generation === generation && id === projectId) return;
    const reopened = id !== null && id === projectId;
    generation = state.generation;
    if (reopened) {
      // After a runtime restart: check every open tab against disk (ROADMAP Phase 1).
      for (const tab of store.getState().tabs) void store.getState().checkAgainstDisk(tab.path);
      return;
    }
    flush();
    for (const path of Object.keys(store.getState().files)) buffers.dispose(path);
    projectId = id;
    restoring = id !== null;
    store.setState(EMPTY);
    if (id) void restore(id);
  });

  bridge.onRuntimeEvent((event) => {
    if (event.type !== fsChangedEvent.type || event.projectId !== projectId) return;
    const parsed = fsChangedEvent.payload.safeParse(event);
    if (!parsed.success) return;
    const open = store.getState().tabs.map((tab) => tab.path);
    if (parsed.data.overflow) {
      for (const path of open) checkSoon(path);
      return;
    }
    for (const change of parsed.data.changes) {
      for (const path of open) {
        if (path === change.path || path.startsWith(`${change.path}/`)) checkSoon(path);
      }
    }
  });

  return store;
}

function failureOf(error: unknown): { code: string; message: string } {
  if (error instanceof JesutobitsError) return { code: error.code, message: error.message };
  return { code: "fs.io", message: messageOf(error) };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `path` first, without duplicates, at most MAX_RECENT. */
function touch(recent: string[], path: string): string[] {
  return recent[0] === path
    ? recent
    : [path, ...recent.filter((entry) => entry !== path)].slice(0, MAX_RECENT);
}
