/** Line endings and BOM of a file as read (`fs.readFile`); saving keeps them (runtime side). */
export interface TextFormat {
  bom: boolean;
  eol: "lf" | "crlf" | "mixed" | "none";
}

/**
 * The open files' text. The app keeps it in Monaco models (`monaco-buffers.ts`); tests use
 * `MemoryBuffers`. The editor store holds everything else, so it never imports Monaco
 * (ADR-0004: only `features/editor/` does, and only the files that render).
 */
export interface TextBuffers {
  /**
   * Sets a path's text as just read from disk. The buffer is clean afterwards. May load the
   * editor first (Monaco loads on the first open, not at startup: NFR-001).
   */
  load(path: string, text: string, format: TextFormat): void | Promise<void>;
  /**
   * Replaces the text with what is now on disk, changing only the lines that differ so the
   * cursor stays put, and highlights them for a few seconds (UX_AND_INTERFACE.md 5.2).
   * Clean afterwards.
   */
  replaceFromDisk(path: string, text: string): void | Promise<void>;
  /** The current text and a version that `markSaved` accepts; undefined if not loaded. */
  snapshot(path: string): { text: string; version: number } | undefined;
  /** Clean when the text is back at `version` (undo after save counts too). */
  markSaved(path: string, version: number): void;
  isDirty(path: string): boolean;
  onDirtyChange(handler: (path: string, dirty: boolean) => void): () => void;
  dispose(path: string): void;
}

/** A plain map of strings, for tests and for running without Monaco. */
export class MemoryBuffers implements TextBuffers {
  private readonly texts = new Map<string, { text: string; version: number; saved: number }>();
  private readonly handlers = new Set<(path: string, dirty: boolean) => void>();
  readonly fromDisk: string[] = [];

  load(path: string, text: string): void {
    this.texts.set(path, { text, version: 0, saved: 0 });
    this.emit(path);
  }

  replaceFromDisk(path: string, text: string): void {
    this.fromDisk.push(path);
    this.load(path, text);
  }

  /** What typing does in the real editor (test helper). */
  edit(path: string, text: string): void {
    const buffer = this.texts.get(path);
    if (!buffer) throw new Error(`${path} is not open`);
    buffer.text = text;
    buffer.version += 1;
    this.emit(path);
  }

  snapshot(path: string): { text: string; version: number } | undefined {
    const buffer = this.texts.get(path);
    return buffer && { text: buffer.text, version: buffer.version };
  }

  markSaved(path: string, version: number): void {
    const buffer = this.texts.get(path);
    if (!buffer) return;
    buffer.saved = version;
    this.emit(path);
  }

  isDirty(path: string): boolean {
    const buffer = this.texts.get(path);
    return buffer !== undefined && buffer.version !== buffer.saved;
  }

  onDirtyChange(handler: (path: string, dirty: boolean) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  dispose(path: string): void {
    this.texts.delete(path);
  }

  private emit(path: string): void {
    for (const handler of this.handlers) handler(path, this.isDirty(path));
  }
}
