# ADR-0015: Build Jesutobits on a Code-OSS fork

- **Status:** Accepted
- **Date:** 2026-10-27
- **Supersedes:** ADR-0001. **Amends:** ADR-0002, ADR-0004, ADR-0007, ADR-0011, ADR-0014
- **Related:** ADR-0003, ADR-0010, RN-40 to RN-43

## Context

Phases 1 and 2 built Jesutobits as a Tauri 2 app with a hand-written Workbench: explorer, Monaco tabs, quick open, command palette, settings, themes, dock layout and status bar (about 13k lines of React and 5k lines of Rust). Each of those is a solved problem in VS Code, and Phases 3 to 7 would have added more of them (terminal, Git panel, diagnostics). The work that makes Jesutobits distinct (the agent harness, previews with visual editing, the companion) is a small part of that effort.

ADR-0001 compared Tauri with Electron but never listed the option most AI editors take: fork Code-OSS (Cursor, Windsurf, Void, Trae). This ADR records that option and adopts it.

Facts that shape the decision:

- The runtime never depended on the shell (invariant 5). It speaks JSON-RPC over stdio (ADR-0003) and needs only four Host methods (`runtime.initialize`, `runtime.configure`, `runtime.ping`, `runtime.shutdown`) and three reverse methods (`host.secrets.get`, `host.fs.trash`, `host.os.reveal`).
- VS Code's Electron runs the unmodified runtime bundle as Node, including `node:sqlite` (RN-40), so no separate Node binary is needed.
- Code-OSS is MIT; the VS Code name, logo, Marketplace and Microsoft's proprietary extensions are not available to forks (RN-41, RN-42).
- A fork must merge upstream releases to stay current. The cost grows with the number of core patches.

## Decision

Jesutobits becomes a **fork of `microsoft/vscode`** pinned to a stable release tag, in a separate repository `jesutobits-ide`.

1. **Jesutobits logic lives in this repository**, not in the fork. `apps/vscode-extension` is a VS Code extension that bundles the runtime and the agent webview. It runs in stock VS Code for development (F5) and ships inside the fork as a built-in extension (`extensions/jesutobits/`).
2. **The extension is the Host.** It spawns the runtime with `process.execPath` and `ELECTRON_RUN_AS_NODE=1`, does the handshake, restarts it with backoff, implements the reverse methods (`context.secrets`, `workspace.fs.delete({ useTrash: true })`, `revealFileInOS`) and kills it on deactivate.
3. **Jesutobits UI runs in webviews.** The agent panel (from `apps/desktop/src/features/agent`) uses a `WebviewHostBridge` that relays JSON-RPC and events over `postMessage`, with a strict CSP, a nonce, schema checks and a method allowlist. Everything else (explorer, editor, search, terminal, Git, settings, themes) is VS Code's.
4. **The fork changes as little as possible**: `product.json` branding, icons, Open VSX as the gallery, telemetry and updates off, the built-in extension, and a short list of core patches recorded in `PATCHES.md`.
   Refined while setting it up (2026-10-27): `jesutobits-ide` holds only those differences, VSCodium-style, not a copy of VS Code's history. `upstream.json` names the release, `product.overrides.json` the branding and removed Microsoft keys (`voiceWsUrl`, `defaultChatAgent`, Copilot auto-updates), `patches/` the source changes, and `scripts/prepare.mjs` downloads the release tarball and applies them. Following a release means changing one tag and re-applying patches, not merging Git histories.
5. **Third-party VS Code extensions are allowed** from Open VSX, under VS Code's model. They are outside Jesutobits' permission system, the same as in any VS Code distribution. Jesutobits' own packs (themes, companion skins) stay data-only.

## Alternatives considered

| Option | Why not |
|---|---|
| **Keep the Tauri shell** (ADR-0001) | Every IDE feature must be built and maintained by hand; this is the cost that triggered this ADR. |
| **Extension only, no fork** | Cheapest, and step 1 of this plan produces exactly that. Rejected as the end state because Jesutobits needs its own name, default layout and first-run experience. |
| **Eclipse Theia** | Built to be extended rather than forked, but a smaller ecosystem and less familiar to users. |
| **Electron app with Monaco** | The ADR-0001 fallback. Still a hand-built Workbench. |

## Trade-offs

| Gains | Costs |
|---|---|
| Explorer, editor, search, terminal, Git, diagnostics, settings, keybindings and themes come with the fork | Monthly upstream merges; core patches must stay few |
| The runtime runs on VS Code's Electron; the Node sidecar, Rust Host and Job Object code go away | Electron's larger memory use (the cost ADR-0001 avoided) |
| Users bring their VS Code habits and Open VSX extensions | Third-party extensions run with full privileges; Jesutobits cannot police them |
| Jesutobits code stays outside the fork, so it is also usable in stock VS Code | No Microsoft Marketplace and no proprietary Microsoft extensions |
| | A full fork build needs about 16 GB RAM, Build Tools and the pinned Node (RN-43) |

## Consequences

- **ADR-0001** is superseded. The Tauri shell is kept at tag `tauri-final` and branch `archive/tauri` and removed from `main` once the extension reaches parity.
- **ADR-0002**: the runtime still runs as a separate Node process, but on VS Code's Electron (`ELECTRON_RUN_AS_NODE`), not a bundled `node.exe`. The ripgrep sidecar stays, or uses the `rg` VS Code ships.
- **ADR-0004**: Monaco is now VS Code's editor itself; the `CodeEditor` wrapper goes away.
- **ADR-0007**: Stage 1 packs stay data. VS Code extensions are a separate, VS Code-governed mechanism, and Stage 2/3 Jesutobits mods may become VS Code extensions (needs its own ADR).
- **ADR-0011**: interactive terminals are VS Code's. Agent commands stay with the runtime's `ProcessSupervisor`.
- **ADR-0014**: trash goes through `workspace.fs.delete({ useTrash: true })` in the extension instead of the Rust `trash` crate.
- **ADR-0010**: previews become an iframe inside a webview panel. Spike S3's WebView2 results (RN-37, RN-38) need re-checking inside VS Code webviews in Phase 4.
- Secrets live in VS Code `SecretStorage` (OS keychain). The webview can ask to set a key but never reads one (invariant 3).
- NFR-010 loses the Host's Job Object. The runtime must kill its process trees when stdin closes and record child PIDs so it can reap survivors on its next start (not built yet; pivot step 7).
- NFR-001, NFR-004 to NFR-006, NFR-008 and NFR-010 are restated against Code-OSS (REQUIREMENTS.md section 2). A stock VS Code window alone is over the old 400 MB idle budget.
- Network destinations add Open VSX; VS Code telemetry, update checks and experiments are disabled in `product.json` (invariant 11).

## Revisit when

- Upstream merges take more than two days a month for three months in a row.
- A Jesutobits feature needs more than about ten core patches.
- Electron memory or startup time misses NFR-001 or NFR-004 and a profile shows the fork, not Jesutobits code, as the cause.
