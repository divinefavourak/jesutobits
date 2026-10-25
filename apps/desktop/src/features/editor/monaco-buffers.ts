import type * as Monaco from "monaco-editor";
import type * as MonacoSetup from "./monaco-setup";
import type { TextBuffers, TextFormat } from "./text-buffers";

type MonacoModule = typeof MonacoSetup;

let loading: Promise<MonacoModule> | undefined;

/** Monaco and its setup, loaded once on first use (NFR-001: not part of the cold start). */
export function loadMonaco(): Promise<MonacoModule> {
  loading ??= import("./monaco-setup");
  return loading;
}

/** How long changed lines stay highlighted after an update from disk (UX 5.2). */
const HIGHLIGHT_MS = 5000;

interface Entry {
  model: Monaco.editor.ITextModel;
  saved: number;
  dirty: boolean;
  /** Decoration IDs of the lines last changed on disk. */
  highlight: string[];
  highlightTimer: ReturnType<typeof setTimeout> | undefined;
}

/** Open files as Monaco models; dirty means the model is not at its saved version. */
export class MonacoBuffers implements TextBuffers {
  private readonly entries = new Map<string, Entry>();
  private readonly handlers = new Set<(path: string, dirty: boolean) => void>();
  private monaco: MonacoModule["monaco"] | undefined;

  /** The model for a path, once loaded. */
  model(path: string): Monaco.editor.ITextModel | undefined {
    return this.entries.get(path)?.model;
  }

  get loadedMonaco(): MonacoModule["monaco"] | undefined {
    return this.monaco;
  }

  async load(path: string, text: string, format: TextFormat): Promise<void> {
    const { monaco } = await loadMonaco();
    this.monaco = monaco;
    let entry = this.entries.get(path);
    if (entry) {
      entry.model.setValue(text);
    } else {
      const model = monaco.editor.createModel(text, undefined, monaco.Uri.file(`/${path}`));
      entry = { model, saved: 0, dirty: false, highlight: [], highlightTimer: undefined };
      this.entries.set(path, entry);
      const current = entry;
      model.onDidChangeContent(() => this.update(path, current));
    }
    entry.model.setEOL(
      format.eol === "crlf"
        ? monaco.editor.EndOfLineSequence.CRLF
        : monaco.editor.EndOfLineSequence.LF,
    );
    entry.saved = entry.model.getAlternativeVersionId();
    this.update(path, entry);
  }

  async replaceFromDisk(path: string, text: string): Promise<void> {
    const { monaco } = await loadMonaco();
    const entry = this.entries.get(path);
    if (!entry) return;
    const { model } = entry;
    const before = model.getValue();
    const after = text.replace(/\r\n|\n/g, model.getEOL());
    // Replace only what lies between the common start and end, so the cursor stays put.
    const shorter = Math.min(before.length, after.length);
    let start = 0;
    while (start < shorter && before.charCodeAt(start) === after.charCodeAt(start)) start += 1;
    let end = 0;
    while (
      end < shorter - start &&
      before.charCodeAt(before.length - 1 - end) === after.charCodeAt(after.length - 1 - end)
    ) {
      end += 1;
    }
    if (start === before.length && start === after.length) return;
    const inserted = after.slice(start, after.length - end);
    const range = monaco.Range.fromPositions(
      model.getPositionAt(start),
      model.getPositionAt(before.length - end),
    );
    model.pushEditOperations([], [{ range, text: inserted }], () => null);
    entry.saved = model.getAlternativeVersionId();
    this.update(path, entry);

    // Highlight the changed lines for a few seconds.
    const first = model.getPositionAt(start).lineNumber;
    const last = model.getPositionAt(start + inserted.length).lineNumber;
    clearTimeout(entry.highlightTimer);
    entry.highlight = model.deltaDecorations(entry.highlight, [
      {
        range: new monaco.Range(first, 1, last, 1),
        options: { isWholeLine: true, className: "jesutobits-changed-line" },
      },
    ]);
    entry.highlightTimer = setTimeout(() => {
      if (!entry.model.isDisposed()) entry.highlight = model.deltaDecorations(entry.highlight, []);
    }, HIGHLIGHT_MS);
  }

  snapshot(path: string): { text: string; version: number } | undefined {
    const entry = this.entries.get(path);
    return (
      entry && { text: entry.model.getValue(), version: entry.model.getAlternativeVersionId() }
    );
  }

  markSaved(path: string, version: number): void {
    const entry = this.entries.get(path);
    if (!entry) return;
    entry.saved = version;
    this.update(path, entry);
  }

  isDirty(path: string): boolean {
    return this.entries.get(path)?.dirty ?? false;
  }

  onDirtyChange(handler: (path: string, dirty: boolean) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  dispose(path: string): void {
    const entry = this.entries.get(path);
    if (!entry) return;
    clearTimeout(entry.highlightTimer);
    entry.model.dispose();
    this.entries.delete(path);
  }

  private update(path: string, entry: Entry): void {
    const dirty = entry.model.getAlternativeVersionId() !== entry.saved;
    if (dirty === entry.dirty) return;
    entry.dirty = dirty;
    for (const handler of this.handlers) handler(path, dirty);
  }
}
