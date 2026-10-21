# Architecture Decision Records

Each ADR records one important decision: the context, the decision, the alternatives, the trade-offs, the consequences, and the evidence that would make us revisit it.

## Status values

- **Proposed**: written but not agreed. Do not build on it yet.
- **Accepted**: agreed. Build on it.
- **Accepted (provisional)**: agreed as the default, but tied to a named spike or a named revisit trigger. Build on it, and keep the code behind the interface the ADR names so a reversal stays cheap.
- **Superseded by ADR-XXXX**: kept for history.

## Index

| ADR | Title | Status |
|---|---|---|
| [0001](0001-desktop-framework-tauri.md) | Desktop framework: Tauri 2 over Electron | Accepted (provisional) |
| [0002](0002-node-runtime-sidecar.md) | Agent runtime as a managed Node.js sidecar | Accepted |
| [0003](0003-host-runtime-ipc.md) | Host to runtime IPC: JSON-RPC 2.0 over stdio | Accepted |
| [0004](0004-code-editor-monaco.md) | Code editor: Monaco | Accepted (provisional) |
| [0005](0005-model-provider-abstraction.md) | Model provider abstraction and OpenRouter adapter | Accepted |
| [0006](0006-companion-animation.md) | Companion animation technology | Accepted (provisional) |
| [0007](0007-extension-sandboxing.md) | Staged extension sandboxing | Accepted |
| [0008](0008-local-persistence.md) | Local persistence | Accepted (provisional) |
| [0009](0009-element-to-source-mapping.md) | Visual element to source mapping | Accepted (provisional, Spike S2) |
| [0010](0010-preview-isolation.md) | Preview isolation | Accepted (provisional, Spike S3) |
| [0011](0011-process-execution-and-terminals.md) | Process execution and terminals | Accepted |
| [0012](0012-checkpoints-and-undo.md) | Checkpoints and undo for agent edits | Accepted |
| [0013](0013-monorepo-tooling.md) | Monorepo and build tooling | Accepted |
| [0014](0014-trash-through-host.md) | Deleting to the OS trash through the Host | Accepted |

## Writing a new ADR

1. Copy the structure of an existing ADR. Number it with the next free number.
2. Link facts to `docs/RESEARCH_NOTES.md` entries instead of restating them without a source.
3. Name a **revisit trigger**: the concrete evidence that would change the decision.
4. Update this index and any design document the decision affects in the same change.
