# ADR-0007: Staged extension sandboxing

- **Status:** Accepted; amended by ADR-0015 (see its Consequences)
- **Date:** 2026-10-19
- **Related:** docs/EXTENSION_SYSTEM.md, docs/SECURITY.md, RN-06, RN-31, RN-34

## Context

Themes, companion skins and mods are core to Jesutobits' identity. They are also the easiest path for malicious code to reach a user's API keys, files and terminal. Extensions written by strangers must never silently gain access to secrets, arbitrary files, terminal execution, network access or other extensions' data.

## Decision

Extensions are introduced in three stages. Each stage adds capability and adds isolation to match.

| Stage | What extensions can do | Where their content runs | Code allowed? | Ships in |
|---|---|---|---|---|
| **1. Declarative** | Themes (design tokens), companion skins (assets + state mappings), layout presets | Parsed and validated by the Workbench; never executed | **No.** JSON, SVG (sanitised), PNG, WebP, `.lottie`, WOFF2 only | MVP |
| **2. Sandboxed UI** | Panels, status widgets, activity visualisations, custom inspectors for preview elements | Iframe with `sandbox="allow-scripts"` (opaque origin), served from the `jesutobits-ext` protocol with a CSP that forbids network | Yes, inside the sandbox only. Talks to Jesutobits through a permission-checked postMessage API | Post-MVP |
| **3. Integrations** | Agent tools and external services | Separate OS process, started by the runtime, spoken to over the **Model Context Protocol** (RN-34) | Yes, as its own process with declared permissions, explicit user grant, and every tool call going through the normal permission broker | Post-MVP |

Enforcement points:

1. **Manifest validation** rejects any permission a category may not request (themes and skins may request none).
2. **Host protocol handler** serves only files inside the extension's own folder, with per-extension CSP headers.
3. **Extension API broker** in the Workbench checks every call from a Stage 2 iframe against granted permissions. Sandboxed iframes cannot reach Tauri IPC (RN-06), the Workbench DOM, or other extensions.
4. **Runtime permission broker** treats Stage 3 tools exactly like built-in tools: risk classification and approval rules apply. An extension cannot mark its own tools as safe.

## Why staged

- Most of the customisation value (look and feel, companion personality) needs no code at all. Stage 1 delivers it with almost no attack surface.
- An API designed before anyone depends on it is cheap to change; an API with a community of mods is not. Staging lets us learn which APIs Stage 2 really needs.
- Each stage's isolation mechanism is independently testable.
- Allowing arbitrary JavaScript in the Workbench (the VS Code-style "extensions run with full privileges" model) would make every extension a potential credential thief, since the Workbench can ask the runtime to approve actions.

## Alternatives considered

| Option | Why not |
|---|---|
| Full-trust JS mods from day one | Unbounded attack surface and an API we could never change. |
| Run mods in a JS sandbox inside the Workbench (ShadowRealm, QuickJS-in-WASM) | Promising for Stage 2b, but iframe sandboxing is a well-understood browser boundary available today. |
| Stage 3 as in-process Node plugins in the runtime | A malicious plugin would share the runtime's memory, including the API key. Separate processes keep that boundary. |

## Consequences

- Stage 1 schemas are versioned (`manifestVersion: 1`) and must stay backward compatible.
- Stage 2 and 3 permission names are reserved in the schema now, so validators reject them with "not supported yet" rather than "unknown".
- A safe-mode start (all extensions disabled) exists from the first release that loads extensions (FR-147).

## Revisit when

There is clear user demand for a capability that cannot be expressed in the current stage, and its isolation story is written down first.
