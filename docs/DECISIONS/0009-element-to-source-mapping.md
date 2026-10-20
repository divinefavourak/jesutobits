# ADR-0009: Visual element to source mapping

- **Status:** Accepted. Confirmed by Spike S2 (2026-10-20, `docs/spikes/S2.md`)
- **Date:** 2026-10-19
- **Related:** RN-18 to RN-24, docs/VISUAL_EDITING.md

## Context

When a user clicks an element in the preview, Jesutobits must find the source code that produced it, decide which properties can be edited safely, and write real source changes. React 19 removed the fiber field older tools relied on (RN-18). The supported subset in the first version is: **React 18 or 19 + Vite 8 (Vite 7 best effort) + TypeScript or JavaScript, styled with Tailwind CSS classes or inline `style` props.**

## Options evaluated

| Approach | How it works | Strengths | Limitations |
|---|---|---|---|
| **A. Build-time instrumentation** | A Vite plugin transforms project JSX so each host element carries `data-jesutobits-loc="src/Hero.tsx:12:5"` | Works for React 18 and 19; exact JSX location; framework-light; same idea as react-dev-inspector and Onlook (RN-20, RN-21) | Needs control of the dev server; only project files (not `node_modules`); attributes visible in the dev DOM |
| **B. React fiber metadata** | Read `_debugStack` via the DevTools hook and resolve via source maps | Zero project changes | Relies on React internals that already changed once (RN-18); stack parsing is fragile; dev builds only |
| **C. Source maps alone** | Map runtime code positions to source | Standard | A DOM node has no code position; cannot answer "which JSX made this node" without A or B |
| **D. Stable IDs written into source** | Insert permanent `data-id` attributes into files | Survives refactors | Pollutes the user's code and diffs; unacceptable without consent |
| **E. Framework adapters** | One adapter per framework (Vite React, Next.js, Expo) | Needed eventually | More work; each adapter is its own project |
| **F. Visual-editing bridge script** | Injected script handles hover, selection, overlays, computed styles, and postMessage | Required for any approach | Does not by itself map to source |

## Decision

Use **A + F inside a framework adapter (E)**, starting with one adapter: `vite-react`.

1. The preview launcher starts the project's own Vite through Vite's JavaScript API and adds `jesutobitsVisualEdit()` as an inline plugin (RN-23). The project's `vite.config` is **not modified**. If Spike S2 shows inline plugins do not merge reliably (RN-24), fallback: a generated wrapper config in the app data dir that imports the user's config and appends the plugin. *Spike S2:* they merge, appended after the project's plugins, so the fallback is not needed; the plugin's `transform` uses hook-level `order: "pre"` to stay ahead of project plugins.
2. The plugin (`enforce: 'pre'`, dev server only) parses `.jsx`/`.tsx` files under the project root, excluding `node_modules`, with an Oxc or Babel parser (Spike S2: `@babel/parser`, because `oxc-parser` is a native addon and the plugin must be a self-contained JS bundle), and inserts `data-jesutobits-loc` on **intrinsic** JSX elements (lowercase tags) using `magic-string`, preserving source maps.
3. It also inserts `data-jesutobits-comp="<ComponentName>"` on the root intrinsic element returned by each component function, for breadcrumbs.
4. The plugin injects the bridge script through `transformIndexHtml`.
5. Persistent edits are done by the runtime's **source transformer**, which re-parses the file, locates the JSX element at that line and column, checks the property is statically editable, and splices the change with `magic-string`. It never rewrites the whole file.
6. Approach B is allowed only as a read-only hint ("component chain") when available. It never drives writes.

## Trade-offs

- Library components (`node_modules`) are not instrumented. Clicking inside one selects the nearest instrumented ancestor. The UI says so.
- One JSX location can render many DOM nodes (lists). Edits apply to the source location, so to all instances. The UI shows the instance count before applying.
- Edits only reach the element's *definition* site. Changing a prop at a component's *usage* site (for example `<Button size="lg">` in the parent) goes through the agent in MVP.

## Consequences

- Visual editing is unavailable for projects outside the supported subset. The preview still works in generic mode (VISUAL_EDITING.md section 3).
- The adapter interface (`PreviewAdapter`) is defined now so Next.js and Expo adapters can be added without changing the inspector.

## Revisit when

Spike S2 fails on merging, performance or HMR stability; or React ships an official, stable source-location API for DevTools.
