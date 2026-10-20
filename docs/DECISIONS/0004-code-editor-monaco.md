# ADR-0004: Code editor: Monaco

- **Status:** Accepted (provisional)
- **Date:** 2026-10-19
- **Related:** RN-32, docs/UX_AND_INTERFACE.md section 5

## Context

Jesutobits needs a code editor component for viewing and editing project files and for reviewing agent diffs. Bundle size matters less for a desktop app loaded from local disk than for a website, but startup time and memory still matter (NFR-001, NFR-004).

Candidates: **Monaco** (VS Code's editor), **CodeMirror 6**.

## Decision

Use **Monaco** through a thin wrapper component `CodeEditor` in `apps/desktop/src/features/editor/`. Nothing outside that folder imports `monaco-editor`.

What Monaco is responsible for:

- Text editing, syntax highlighting, find/replace, multi-cursor, folding, minimap.
- Built-in TypeScript and JavaScript language services (in workers) for in-editor diagnostics and completion.
- Side-by-side and inline **diff view** for reviewing agent changes.
- Theming from Jesutobits theme tokens via `monaco.editor.defineTheme` (see EXTENSION_SYSTEM.md).

What Monaco is **not** responsible for, and is designed separately:

- Reading and writing files (Workspace Service in the runtime).
- File tree, tabs model, dirty tracking across tabs (Workbench editor feature).
- Terminal, Git, previews, agent operations.
- Project-wide type checking (that is a verification check run by the runtime, see AGENT_HARNESS.md).

## Alternatives considered

| Option | Assessment |
|---|---|
| **CodeMirror 6** | Smaller, very customisable, no mandatory workers, better touch support (RN-32). Weaker out-of-the-box TypeScript intelligence and diff UX; we would assemble LSP integration ourselves. |
| **Monaco + an LSP bridge** | Better language intelligence for many languages, but needs language servers managed by the runtime. Post-MVP. |

## Trade-offs

- Monaco's built-in TS service only knows the files it has models for. It will show false "cannot find module" errors in large projects. Mitigation: in MVP, disable semantic diagnostics for files whose imports cannot resolve, and rely on the runtime's `typecheck` check as the source of truth. Show a small "Editor hints are approximate" note in the diagnostics panel.
- Workers must be wired explicitly in Vite with `?worker` imports. The Workbench CSP must allow `worker-src 'self' blob:`.
- Monaco is global-state heavy. Only one Monaco instance family per window.

## Consequences

- The `CodeEditor` wrapper exposes a small API (`open(uri, content, version)`, `applyExternalChange`, `getValue`, `revealRange`, `setDecorations`, `showDiff`) so swapping to CodeMirror later touches one folder.
- Agent edits arrive as file-changed events. The editor applies them as external edits, keeping the user's cursor, and shows a gutter marker for agent-changed lines.

## Revisit when

Workbench cold start exceeds NFR-001 and profiling shows Monaco as a top contributor, or we need editor features Monaco makes hard (for example deep customisation of the gutter for visual-editing links).
