# AGENTS.md

```text
     ██╗███████╗███████╗██╗   ██╗████████╗ ██████╗ ██████╗ ██╗████████╗███████╗
     ██║██╔════╝██╔════╝██║   ██║╚══██╔══╝██╔═══██╗██╔══██╗██║╚══██╔══╝██╔════╝
     ██║█████╗  ███████╗██║   ██║   ██║   ██║   ██║██████╔╝██║   ██║   ███████╗
██   ██║██╔══╝  ╚════██║██║   ██║   ██║   ██║   ██║██╔══██╗██║   ██║   ╚════██║
╚█████╔╝███████╗███████║╚██████╔╝   ██║   ╚██████╔╝██████╔╝██║   ██║   ███████║
 ╚════╝ ╚══════╝╚══════╝ ╚═════╝    ╚═╝    ╚═════╝ ╚═════╝ ╚═╝   ╚═╝   ╚══════╝
```

Instructions for AI coding agents working on the **Jesutobits** repository. Humans: see README.md.

## What this repo is

Jesutobits is an AI coding workspace built on a **Code-OSS fork** (ADR-0015). This repository holds the Jesutobits logic: a Node.js **Runtime** (agent harness, tools, permissions, sessions, previews) that speaks JSON-RPC over stdio, and the VS Code extension `apps/vscode-extension`, which is the **Host**. It spawns the runtime on VS Code's Electron (`ELECTRON_RUN_AS_NODE`) and shows Jesutobits UI in webviews. The fork itself (branding, `product.json`, built-in extension, core patches) lives in the separate `jesutobits-ide` repository.

The pivot is in progress (`docs/ROADMAP.md` section 5). `apps/desktop` (the Tauri shell, archived at tag `tauri-final`) still exists until the extension reaches parity. Do not add features to it.

## Read before changing anything

Read only what your change touches:

- `docs/ARCHITECTURE.md` and `docs/PROJECT_STRUCTURE.md` section 3 when you add a package, a boundary or a dependency.
- The design document for your area (`AGENT_HARNESS.md`, `VISUAL_EDITING.md`, `COMPANION_SYSTEM.md`, `EXTENSION_SYSTEM.md`, `SECURITY.md`, `DATA_AND_PERSISTENCE.md`, `UX_AND_INTERFACE.md`), and only the sections you change.
- The ADR and requirement IDs your change implements.

If the docs and the code disagree, stop and point it out. Do not silently pick one.

## Invariants (never break these)

1. **Permissions are enforced by the runtime's `PermissionBroker`.** No tool executes without a broker `Grant`. Model text never changes a decision.
2. **All project file access goes through `WorkspaceService`; all processes through `ProcessSupervisor`.** No direct `fs` or `child_process` use elsewhere.
3. **Secrets live only in VS Code `SecretStorage` (the OS credential store), owned by the extension.** Never write them to files, logs, SQLite, events, model context, webview messages or child environments. A webview can ask to set a secret but never reads one.
4. **Webviews never touch files, processes or providers directly.** They talk to the extension through `HostBridge` over `postMessage` only, and the extension accepts only allowlisted, schema-checked methods. Only the extension imports `vscode`.
5. **The runtime never depends on VS Code or Electron.** It speaks JSON-RPC over stdio and runs on plain Node too. Stdout is the protocol: no `console.*` in `runtime` or `services`.
6. **UI shows only real activity.** Timeline, status bar and companion states derive from runtime events. No fake progress, no timers that imply work.
7. **"Verified" requires fresh passing evidence** from the `VerificationLedger`. Never label work as working because code was written.
8. **Previews are untrusted.** The iframe never gets IPC; bridge messages are origin + nonce + schema checked and can never trigger writes or approvals.
9. **Jesutobits packs (themes, companion skins) are data, never code.** Do not add any path that executes pack content. Third-party VS Code extensions are VS Code's mechanism, outside Jesutobits' permission system (ADR-0015). Stage 2/3 mods need an accepted ADR first.
10. **Jesutobits never writes into a user's project** except via user actions or approved agent tools. A project's files can never grant themselves permissions.
11. **No native Node addons** in `runtime` or `services` (ADR-0002). **No new network destinations** besides the configured model provider and Open VSX without an ADR. Telemetry, update checks and experiments stay off in `product.json`.
12. **Schemas first.** New RPC methods, events and bridge messages are defined in `packages/protocol` before use; run `pnpm gen` to update JSON Schemas and the method allowlists.

## Commands

```bash
pnpm install && pnpm fetch:sidecars && pnpm build:packages   # first time
pnpm dev            # desktop app
pnpm dev:web        # Workbench in a browser with MockHostBridge
pnpm lint && pnpm typecheck && pnpm test                     # required before finishing
pnpm test:e2e       # when you touch UI flows or visual editing
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml  # when you touch Rust
```

These commands still build the archived Tauri shell; `apps/vscode-extension` scripts replace `pnpm dev`, `test:e2e`, the Rust steps and `fetch:sidecars` during the pivot (ROADMAP section 5).

`pnpm test:e2e` needs `pnpm build:packages` and a Playwright Chromium (`pnpm --filter @jesutobits/desktop exec playwright install chromium`). `pnpm lint` includes `cargo fmt --check` and `cargo clippy`, so it needs `pnpm build:packages` and `pnpm fetch:sidecars` first (the Host build embeds the runtime bundle and the Node sidecar). `pnpm test:rust` runs `cargo test`. `pnpm test:desktop` (nightly) drives the real app; it needs `cargo install tauri-driver --locked` and `pnpm build:desktop-test`.

Use `JESUTOBITS_PROVIDER=scripted JESUTOBITS_CASSETTE=<file>` to run without an API key. Never add real keys anywhere in the repo.

## How to work

- **Find the requirement.** Reference FR/NFR IDs in commit messages and PR descriptions (for example `FR-052`).
- **Keep boundaries.** Follow the dependency rules in `PROJECT_STRUCTURE.md` section 3; the linter enforces most of them.
- **Tests are part of the change.** Use `ScriptedProvider` cassettes for agent behaviour, temp directories for file tests, fixtures for projects and extensions. Never call paid model APIs in tests. Never touch real user folders.
- **Cancellation:** every tool and long operation must honour `AbortSignal` and stop within 2 s.
- **Errors:** return `ToolResult` errors from tools; throw typed `JesutobitsError` from services; never leak secrets in messages.
- **Windows first:** use `node:path`, never string-concatenate paths; preserve line endings; remember `.cmd` shims need the shared spawner.
- **Docs move with behaviour.** If you change a contract, policy, state machine or user-visible flow, update the relevant doc in the same change. New significant decision → new ADR (`docs/DECISIONS/README.md`).
- **Ambiguity:** if something important is unspecified, implement the documented default if one exists; otherwise add it to `docs/ROADMAP.md` section 4 with a recommended default and ask.

## Gates

Match the check to the size of the change, so time and tokens go into the product:

- **Each step:** tests for what you changed (`pnpm --filter <package> test`), plus typecheck of the touched packages.
- **Each group of steps** (a lettered group in the plan, or before a commit that others build on): `pnpm lint && pnpm typecheck && pnpm test`.
- **Milestones** (end of a plan group that changes user-visible flows, and before a PR): E2E or extension integration tests, and one live check in the running app.

## Definition of done for a milestone

- Linked requirement's acceptance criteria covered by automated tests (or the manual check named in `TESTING_STRATEGY.md`).
- Lint, typecheck and tests green on Windows and Linux CI.
- No new secrets exposure (canary tests pass).
- Docs and schemas updated; generated files regenerated.
- UI changes keyboard-accessible, styled with VS Code theme variables (`--vscode-*`), and without serious axe violations.
