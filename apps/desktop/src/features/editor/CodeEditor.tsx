import type * as Monaco from "monaco-editor";
import { useEffect, useRef } from "react";
import { useStore } from "zustand";
import { t } from "../../i18n";
import { editorFont } from "../../state/appearance-store";
import { useAppearance, useWorkbench } from "../../state/workbench-context";
import { MonacoBuffers } from "./monaco-buffers";
import { applyTheme, monaco, THEME_NAME } from "./monaco-setup";

/**
 * The `CodeEditor` wrapper (ADR-0004): one Monaco editor that shows the active tab's model,
 * keeping each tab's scroll and selection. Loaded lazily with Monaco itself. With
 * `compare`, a diff editor shows the disk text on the left and the tab on the right.
 */
export default function CodeEditor({
  path,
  name,
  compare,
}: {
  path: string;
  name: string;
  /** Disk text to compare the tab with (the "changed on disk" bar's Compare). */
  compare: string | null;
}) {
  const { bridge, buffers, editor: store } = useWorkbench();
  const theme = useAppearance((state) => state.compiled?.monaco);
  const fontFamily = useAppearance((state) => editorFont(state).family);
  const fontSize = useAppearance((state) => editorFont(state).size);
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const viewStates = useRef(new Map<string, Monaco.editor.ICodeEditorViewState | null>());
  const pathRef = useRef(path);
  const model = buffers instanceof MonacoBuffers ? buffers.model(path) : undefined;

  // The theme applies to every Monaco editor at once; time it against the 200 ms budget.
  useEffect(() => {
    if (!theme) return;
    const ms = applyTheme(theme);
    bridge.log("info", `editor theme applied in ${ms.toFixed(1)} ms`);
  }, [theme, bridge]);

  // One editor (or diff editor) per mount.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !model) return;
    const options = {
      automaticLayout: true,
      fontFamily,
      fontSize,
      theme: THEME_NAME,
      scrollBeyondLastLine: false,
      fixedOverflowWidgets: true,
    };
    if (compare !== null) {
      const original = monaco.editor.createModel(compare, model.getLanguageId());
      const diff = monaco.editor.createDiffEditor(container, {
        ...options,
        originalEditable: false,
        ariaLabel: t("editor.compareLabel", { name }),
      });
      diff.setModel({ original, modified: model });
      return () => {
        diff.dispose();
        original.dispose();
      };
    }
    const editor = monaco.editor.create(container, {
      ...options,
      model,
      ariaLabel: t("editor.ariaLabel", { name }),
    });
    editorRef.current = editor;
    const views = viewStates.current;
    const cursor = editor.onDidChangeCursorPosition((event) => {
      store.getState().setCursor(pathRef.current, {
        line: event.position.lineNumber,
        column: event.position.column,
      });
    });
    // Typing in a preview tab keeps it (UX_AND_INTERFACE.md section 5.2).
    const edits = editor.onDidChangeModelContent(() => {
      const tab = store.getState().tabs.find((entry) => entry.path === pathRef.current);
      if (tab?.preview) store.getState().pin(tab.path);
    });
    return () => {
      views.set(pathRef.current, editor.saveViewState());
      cursor.dispose();
      edits.dispose();
      editor.dispose();
      editorRef.current = null;
    };
    // Font and model changes are applied below without re-creating the editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compare]);

  // Switching tabs: keep the old tab's view, show the new model where the user left it.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !model) return;
    const previous = pathRef.current;
    if (previous !== path) viewStates.current.set(previous, editor.saveViewState());
    pathRef.current = path;
    if (editor.getModel() !== model) editor.setModel(model);
    editor.updateOptions({ ariaLabel: t("editor.ariaLabel", { name }) });
    const view = viewStates.current.get(path);
    if (view) {
      editor.restoreViewState(view);
    } else {
      const cursor = store.getState().cursors[path];
      if (cursor) {
        editor.setPosition({ lineNumber: cursor.line, column: cursor.column });
        editor.revealPositionInCenterIfOutsideViewport({
          lineNumber: cursor.line,
          column: cursor.column,
        });
      }
    }
  }, [path, model, name, store]);

  useEffect(() => {
    editorRef.current?.updateOptions({ fontFamily, fontSize });
  }, [fontFamily, fontSize]);

  // A search result asked to show a position in this file.
  const reveal = useStore(store, (state) => state.revealRequest);
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !reveal || reveal.path !== path) return;
    const position = { lineNumber: reveal.cursor.line, column: reveal.cursor.column };
    editor.setPosition(position);
    editor.revealPositionInCenter(position);
    editor.focus();
  }, [reveal, path]);

  return <div ref={containerRef} className="h-full w-full" data-testid="code-editor" />;
}
