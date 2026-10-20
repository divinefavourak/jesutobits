# Project Structure

> Status: Agreed target layout. Phase 0 creates it (ROADMAP.md). Tooling per ADR-0013.

## 1. Repository layout

```
jesutobits/
├── AGENTS.md                      # instructions for coding agents working on Jesutobits
├── README.md
├── package.json                   # workspace root; "packageManager": "pnpm@<pinned>"
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── tsconfig.json                  # solution file: project references for `tsc -b`
├── tsconfig.tests.json            # typechecks *.test.ts and test/ (kept out of package builds)
├── vitest.config.ts
├── eslint.config.js               # includes dependency boundary rules (section 3)
├── rust-toolchain.toml
├── .github/workflows/             # ci.yml (PR), nightly.yml, release.yml
│
├── apps/
│   └── desktop/
│       ├── index.html
│       ├── vite.config.ts         # Workbench build (Vite 8)
│       ├── src/                   # WORKBENCH (React + TS + Tailwind)
│       │   ├── main.tsx
│       │   ├── host-bridge/       # HostBridge interface, TauriHostBridge, MockHostBridge
│       │   ├── state/             # EventStore, UI stores
│       │   ├── ui/                # primitives styled only with theme tokens; markdown/ sanitiser
│       │   ├── features/
│       │   │   ├── onboarding/  layout/  explorer/  editor/  search/  git/
│       │   │   ├── agent/       timeline/  approvals/  terminal/  problems/
│       │   │   ├── preview/     inspector/  companion/  appearance/
│       │   │   └── extensions/  settings/  diagnostics/
│       │   └── i18n/              # externalised strings (NFR-020)
│       ├── e2e/                   # Playwright: journeys/, visual-editing/, a11y/
│       └── src-tauri/             # HOST (Rust)
│           ├── Cargo.toml
│           ├── tauri.conf.json    # bundle.externalBin: jesutobits-node, jesutobits-rg; resources
│           ├── tauri.dev.conf.json  # merged by `pnpm dev`: dev identifier dev.jesutobits.app.dev
│           ├── capabilities/main.json
│           ├── icons/             # app icons, from docs/assets/jesutobits-icon.svg
│           ├── binaries/          # fetched sidecars with target-triple names (git-ignored)
│           ├── resources/         # for build outputs that need assembling first: preview/, builtin/, templates/ (git-ignored).
│           │                      # Single files are mapped straight from their build output in tauri.conf.json,
│           │                      # e.g. packages/runtime/dist/bundle/runtime.mjs -> runtime/main.mjs
│           └── src/
│               ├── main.rs, lib.rs
│               ├── runtime_supervisor/   # spawn, health, restart; job_object_windows.rs; process_group_unix.rs
│               ├── rpc_relay/            # relay + allowlist (allowlist.rs is generated)
│               ├── secret_store.rs
│               ├── pty_manager.rs
│               ├── extension_store/      # archive checks, staging, registry, jesutobits-ext protocol
│               ├── settings_store/       # settings.json, ui-state.json, migrations
│               ├── dialogs.rs
│               └── updater.rs
│
├── packages/
│   ├── protocol/                  # Zod schemas: RPC methods, events, JesutobitsError, bridge messages,
│   │                              # VisualChange, settings; generates JSON Schemas and the Host allowlist
│   ├── shared/                    # pure utilities: ids (ULID + prefix), Result, semver helpers; no Node or DOM APIs
│   ├── runtime/                   # RUNTIME entry + AGENT HARNESS (boundary B)
│   │   ├── src/main.ts            # stdio wiring, dependency injection of services
│   │   ├── src/rpc/
│   │   ├── src/sessions/
│   │   ├── src/agent/             # loop, state machine, limits, loop guard, summary; prompts/
│   │   ├── src/context/
│   │   ├── src/providers/         # types.ts, openrouter/, scripted/, model-cache
│   │   ├── src/tools/             # registry + one folder per tool family
│   │   ├── src/permissions/       # broker, policy, classifier, rules, fingerprints
│   │   ├── src/verify/            # ledger, check profiles, output parsers
│   │   ├── src/events/
│   │   ├── src/storage/           # Database interface, node-sqlite impl, migrations/NNNN_*.sql
│   │   ├── src/extensions/        # extensions.validate RPC (uses extension-schema)
│   │   ├── src/log/               # logger, SecretRegistry masker
│   │   └── test/                  # cassettes/, harness/
│   ├── services/                  # PREVIEW AND EXECUTION SERVICES (boundary D)
│   │   ├── src/workspace/         # WorkspaceService, path guard, watcher, ignore, checkpoints
│   │   ├── src/process/           # ProcessSupervisor, spawner (Windows shims), orphan ledger
│   │   ├── src/preview/           # PreviewManager, adapters/{generic,vite-react}, ports, readiness
│   │   ├── src/git/               # GitService (CLI wrapper + parsers)
│   │   ├── src/visual/            # editability analysis, SourceTransformer, tailwind mapping
│   │   └── src/headless/          # playwright-core driver for check_preview
│   ├── preview-launcher/          # preview-launcher.mjs, runs with the user's Node (VISUAL_EDITING.md 4.8)
│   ├── vite-plugin/               # @jesutobits/vite-plugin: JSX instrumentation + bridge injection (self-contained bundle)
│   ├── visual-bridge/             # bridge script injected into previews (IIFE, < 30 KB)
│   ├── extension-schema/          # manifest, theme token, companion skin schemas + validator
│   └── extension-cli/             # jesutobits-ext: init, validate, pack; ships JSON Schemas
│
├── extensions/builtin/
│   ├── jesutobits-themes/               # Light, Dark, High Contrast (real packages)
│   └── jesutobits-companions/           # Ember, Dot, Pip
├── templates/                     # react-vite-ts-tailwind, react-vite-ts, empty, general
├── fixtures/                      # projects/, extensions/, bin/ (TESTING_STRATEGY.md section 3)
├── scripts/                       # fetch-node.mjs (+ sidecars.json pins), fetch-ripgrep.mjs, build-runtime.mjs, build-guest.mjs,
│   │                              # gen-protocol.mjs, gen-allowlist.mjs, gen-logo.mjs, package-builtins.mjs
│   ├── eslint-rules/              # local ESLint plugin: boundaries.mjs is the section 3 rule table
│   └── spikes/                    # Phase 0 spike measurements, kept runnable (docs/spikes/)
└── docs/                          # this documentation
```

## 2. Module responsibilities

Responsibilities per module are specified in ARCHITECTURE.md section 5. Ownership summary:

| Area | Package or folder | Boundary |
|---|---|---|
| Desktop UI | `apps/desktop/src` | A (Workbench) |
| Desktop OS integration, credentials, PTYs, relay | `apps/desktop/src-tauri` | A (Host) |
| Agent loop, providers, tools, permissions, context, sessions, verification | `packages/runtime` | B |
| File I/O, processes, previews, Git, visual source edits, headless checks | `packages/services` | D |
| Code that runs inside user projects' dev servers | `packages/preview-launcher`, `packages/vite-plugin`, `packages/visual-bridge` | D (guest side) |
| Extension formats and tooling | `packages/extension-schema`, `packages/extension-cli`, `extensions/builtin` | E |
| Contracts shared across processes | `packages/protocol` | All |
| User projects | Anywhere on disk, never inside this repo | C |

## 3. Dependency rules (enforced by lint, NFR-017)

The tables below are encoded in `scripts/eslint-rules/boundaries.mjs` and enforced by the `jesutobits/import-boundaries` rule, plus `no-console`, `no-restricted-globals` (`fetch`), `no-restricted-syntax` (`dangerouslySetInnerHTML`) and `jesutobits/no-raw-colors` in `eslint.config.js`. Change the table and this section together; `scripts/eslint-rules/eslint-rules.test.mjs` tests the real table. pnpm's strict `node_modules` adds a second layer: a package cannot import a dependency it has not declared. Rules about node built-ins (`fs`, `child_process`, network) do not apply to test files, which need temp directories and process harnesses. Native addons are caught only when imported as `.node` files; a dependency audit for native packages arrives with the sidecar build (Spike S1).

### 3.1 Between packages

| Package | May depend on | Must not depend on |
|---|---|---|
| `protocol` | `zod` | Any Jesutobits package |
| `shared` | nothing | Any Jesutobits package |
| `services` | `protocol`, `shared` | `runtime`, `apps/*` |
| `runtime` | `protocol`, `shared`, `services`, `extension-schema` | `apps/*` |
| `apps/desktop` (Workbench) | `protocol`, `shared`, `extension-schema` (types and token compiler) | `runtime`, `services`, Node built-ins |
| `extension-schema` | `zod`, `shared` | `runtime`, `services`, `apps/*` |
| `extension-cli` | `extension-schema` | `runtime`, `services`, `apps/*` |
| `vite-plugin`, `visual-bridge`, `preview-launcher` | `protocol` as **type-only** imports; their own bundled dependencies | Everything else at runtime (ADR-0013) |

### 3.2 Inside packages

| Rule | Why |
|---|---|
| Only `apps/desktop/src/host-bridge/` imports `@tauri-apps/*` | Shell replaceability (ADR-0001) |
| Only `features/editor/` imports `monaco-editor` | Editor replaceability (ADR-0004) |
| Only `features/companion/renderers/` imports animation libraries | Renderer isolation (ADR-0006) |
| Only `ui/markdown/` may produce HTML from strings; `dangerouslySetInnerHTML` banned elsewhere | XSS defence (SECURITY.md section 8) |
| Components use theme tokens only; raw colour literals banned in `features/` and `ui/` | Theming (EXTENSION_SYSTEM.md section 4) |
| In `services`, only `workspace/` imports `node:fs` for project paths; only `process/` imports `node:child_process` | Single enforcement points |
| In `runtime`, only `storage/` imports `node:sqlite`; only `providers/` performs model HTTP | Swappability and audit |
| `console.*` banned in `runtime` and `services` | Stdout carries the protocol (ADR-0003) |
| Native addons banned in `runtime` and `services` | ADR-0002 |
| Tools never import other tools; shared logic goes to `services` or `tools/common` | Avoid hidden coupling |

## 4. Conventions

- **Language:** TypeScript strict; Rust 2021 edition; documentation in British English; code identifiers follow platform conventions (for example CSS `color`).
- **Files:** kebab-case for modules, PascalCase for React components, `*.test.ts` colocated, E2E specs under `apps/desktop/e2e/`.
- **IDs:** ULID with type prefix (ARCHITECTURE.md section 6.5).
- **Errors:** `JesutobitsError` with stable dotted codes (ARCHITECTURE.md section 9.1).
- **Schemas first:** any new RPC method, event or bridge message is added to `packages/protocol` before implementation; generators update JSON Schemas and the Host allowlist.
- **Generated files** carry a header `// Generated by scripts/<name>. Do not edit.` (a `$comment` field in JSON) and are checked in only when the build needs them before codegen can run: `packages/protocol/generated/methods.json` (read by the Host allowlist and its Rust contract test) and the Rust allowlist itself. JSON Schemas go to `packages/protocol/dist/json-schema/`. CI runs `pnpm gen:check`.
- **Migrations:** `packages/runtime/src/storage/migrations/NNNN_short_name.sql`, never edited after merge.
- **Prompts:** `packages/runtime/src/agent/prompts/` with a version constant bumped on every change.
