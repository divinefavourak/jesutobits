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

Jesutobits is a Tauri 2 desktop app (Rust **Host** + React **Workbench**) with a bundled Node.js **Runtime** sidecar that runs an AI coding agent, live previews with source-connected visual editing, a companion, and a permissioned extension system. Implementation is in Phase 0 (`docs/ROADMAP.md` section 5): the monorepo, `packages/protocol`, a stub runtime and the Tauri Host (runtime supervisor, Job Object, relay) exist; Spikes S2 and S3 do not yet.

## Read before changing anything

1. `README.md` (orientation, glossary)
2. `docs/ARCHITECTURE.md` (boundaries, contracts)
3. The design document for your area: `AGENT_HARNESS.md`, `VISUAL_EDITING.md`, `COMPANION_SYSTEM.md`, `EXTENSION_SYSTEM.md`, `SECURITY.md`, `DATA_AND_PERSISTENCE.md`, `UX_AND_INTERFACE.md`
4. Relevant ADRs in `docs/DECISIONS/` and requirement IDs in `docs/REQUIREMENTS.md`
5. `docs/PROJECT_STRUCTURE.md` for where code goes and the dependency rules

If the docs and the code disagree, stop and point it out. Do not silently pick one.

## Invariants (never break these)

1. **Permissions are enforced by the runtime's `PermissionBroker`.** No tool executes without a broker `Grant`. Model text never changes a decision.
2. **All project file access goes through `WorkspaceService`; all processes through `ProcessSupervisor`.** No direct `fs` or `child_process` use elsewhere.
3. **Secrets live only in the OS credential store (Host).** Never write them to files, logs, SQLite, events, model context or child environments. The Workbench can set a secret but never read it.
4. **The Workbench never touches files, processes or providers directly.** It talks to the Host through `HostBridge` only. Only `host-bridge/` imports `@tauri-apps/*`.
5. **The runtime never depends on Tauri.** It speaks JSON-RPC over stdio. Stdout is the protocol: no `console.*` in `runtime` or `services`.
6. **UI shows only real activity.** Timeline, status bar and companion states derive from runtime events. No fake progress, no timers that imply work.
7. **"Verified" requires fresh passing evidence** from the `VerificationLedger`. Never label work as working because code was written.
8. **Previews are untrusted.** The iframe never gets IPC; bridge messages are origin + nonce + schema checked and can never trigger writes or approvals.
9. **Stage 1 extensions are data, never code.** Do not add any path that executes extension content. Stage 2/3 work requires an accepted ADR first.
10. **Jesutobits never writes into a user's project** except via user actions or approved agent tools. A project's files can never grant themselves permissions.
11. **No native Node addons** in `runtime` or `services` (ADR-0002). **No new network destinations** besides the configured model provider without an ADR.
12. **Schemas first.** New RPC methods, events and bridge messages are defined in `packages/protocol` before use; run `pnpm gen` to update JSON Schemas and the Host allowlist.

## Commands

```bash
pnpm install && pnpm fetch:sidecars && pnpm build:packages   # first time
pnpm dev            # desktop app
pnpm dev:web        # Workbench in a browser with MockHostBridge
pnpm lint && pnpm typecheck && pnpm test                     # required before finishing
pnpm test:e2e       # when you touch UI flows or visual editing
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml  # when you touch Rust
```

Not yet available: `test:e2e` (Phase 1). `pnpm lint` includes `cargo fmt --check` and `cargo clippy`, so it needs `pnpm build:packages` and `pnpm fetch:sidecars` first (the Host build embeds the runtime bundle and the Node sidecar). `pnpm test:rust` runs `cargo test`.

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

## Definition of done for any task

- Linked requirement's acceptance criteria covered by automated tests (or the manual check named in `TESTING_STRATEGY.md`).
- Lint, typecheck and tests green on Windows and Linux CI.
- No new secrets exposure (canary tests pass).
- Docs and schemas updated; generated files regenerated.
- UI changes keyboard-accessible, token-styled, and without serious axe violations.
