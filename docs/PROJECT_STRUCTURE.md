# Project Structure

> Status: Agreed layout, revised for the Code-OSS fork (ADR-0015). Tooling per ADR-0013.

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
├── .vscode/launch.json            # F5: VS Code with the extension loaded
├── .github/workflows/             # ci.yml (PR), nightly.yml
│
├── apps/
│   └── vscode-extension/          # HOST: the Jesutobits VS Code extension (ADR-0015)
│       ├── package.json           # contributions: agent view, commands, jesutobits.* settings
│       ├── scripts/build.mjs      # dist/extension.js, dist/runtime/ (runtime bundle), dist/webview/
│       ├── media/                 # activity-bar icon
│       ├── src/
│       │   ├── extension.ts       # activate/deactivate: wires everything to the VS Code API
│       │   ├── runtime/           # RuntimeSupervisor, RuntimeConnection, RestartPolicy, launch spec
│       │   ├── host/              # reverse calls, runtime.configure, workspace project, panel messages,
│       │   │                      # Sign in with OpenRouter, profile, theme remix, new project
│       │   └── vscode/            # webview views and other VS Code API adapters
│       └── webview/               # AGENT PANEL, PREVIEW, STUDIO, LEARNING CENTRE (React + TS + Tailwind on --vscode-* variables)
│           ├── vite.config.mts
│           └── src/
│               ├── main.tsx
│               ├── host-bridge/   # HostBridge interface, WebviewHostBridge, MockHostBridge
│               ├── state/         # project, UI and agent stores
│               ├── ui/            # primitives styled only with theme tokens; markdown/ renderer
│               ├── features/agent/
│               ├── styles/        # Tailwind theme on tokens; vscode-tokens.css maps them to VS Code
│               └── i18n/          # externalised strings (NFR-020)
│
├── packages/
│   ├── protocol/                  # Zod schemas: RPC methods, events, JesutobitsError, bridge and webview
│   │                              # messages, VisualChange, settings; generates JSON Schemas and methods.json
│   ├── shared/                    # pure utilities: ids (ULID + prefix), Result, semver helpers, the Logger interface; no Node or DOM APIs
│   ├── runtime/                   # RUNTIME entry + AGENT HARNESS (boundary B)
│   │   ├── src/main.ts            # stdio wiring, dependency injection of services
│   │   ├── src/rpc/
│   │   ├── src/sessions/
│   │   ├── src/agent/             # loop, state machine, limits, loop guard, summary; prompts/
│   │   ├── src/context/
│   │   ├── src/providers/         # types.ts, openrouter/, scripted/, model-cache
│   │   ├── src/tools/             # registry + one folder per tool family
│   │   ├── src/permissions/       # broker, policy, classifier, rules, fingerprints
│   │   ├── src/verify/            # ledger, check profiles, output parsers (Phase 3: not yet)
│   │   ├── src/preview/           # PreviewManager (vite-react, generic, static, command), preview.* RPC
│   │   ├── src/projects/          # projects.* RPC, ProjectStore (trust, preset, saved start command)
│   │   ├── src/checkpoints/       # pre-images for revert (ADR-0012)
│   │   ├── src/events/
│   │   ├── src/storage/           # Database interface, node-sqlite impl, migrations/NNNN_*.sql
│   │   ├── src/extensions/        # extensions.validate RPC (uses extension-schema; Phase 6: not yet)
│   │   ├── src/log/               # logger, SecretRegistry masker
│   │   └── test/                  # cassettes/, harness/
│   ├── services/                  # PREVIEW AND EXECUTION SERVICES (boundary D)
│   │   ├── src/workspace/         # WorkspaceService, path guard, watcher, ignore, checkpoints
│   │   ├── src/process/           # ProcessSupervisor, spawner (Windows shims), orphan ledger
│   │   ├── src/preview/           # project detection (preview strategy), ports, readiness, static-site server
│   │   ├── src/git/               # GitService (CLI wrapper + parsers), Phase 3: not yet
│   │   ├── src/visual/            # editability analysis, SourceTransformer, tailwind mapping
│   │   └── src/headless/          # playwright-core driver for check_preview, Phase 3: not yet
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
├── fixtures/                      # projects/, extensions/, cassettes/, bin/ (TESTING_STRATEGY.md section 3)
├── scripts/                       # build-runtime.mjs, build-guest.mjs, gen-protocol.mjs, gen-logo.mjs,
│   │                              # package-builtins.mjs, bench-cancel.mjs
│   ├── eslint-rules/              # local ESLint plugin: boundaries.mjs is the section 3 rule table
│   └── spikes/                    # Phase 0 spike measurements, kept runnable (docs/spikes/)
└── docs/                          # this documentation
```

## 2. Module responsibilities

Responsibilities per module are specified in ARCHITECTURE.md section 5. Ownership summary:

| Area | Package or folder | Boundary |
|---|---|---|
| Editor, explorer, terminal, Git, settings, themes | VS Code itself (the `jesutobits-ide` fork, ADR-0015) | A |
| Agent panel and other Jesutobits UI | `apps/vscode-extension/webview` | A (webviews) |
| Runtime supervision, credentials, reverse calls, panel relay | `apps/vscode-extension/src` | A (Host) |
| Agent loop, providers, tools, permissions, context, sessions, verification | `packages/runtime` | B |
| File I/O, processes, previews, Git, visual source edits, headless checks | `packages/services` | D |
| Code that runs inside user projects' dev servers | `packages/preview-launcher`, `packages/vite-plugin`, `packages/visual-bridge` | D (guest side) |
| Extension formats and tooling | `packages/extension-schema`, `packages/extension-cli`, `extensions/builtin` | E |
| Contracts shared across processes | `packages/protocol` | All |
| User projects | Anywhere on disk, never inside this repo | C |

## 3. Dependency rules (enforced by lint, NFR-017)

The tables below are encoded in `scripts/eslint-rules/boundaries.mjs` and enforced by the `jesutobits/import-boundaries` rule, plus `no-console`, `no-restricted-globals` (`fetch`), `no-restricted-syntax` (`dangerouslySetInnerHTML`) and `jesutobits/no-raw-colors` in `eslint.config.js`. Change the table and this section together; `scripts/eslint-rules/eslint-rules.test.mjs` tests the real table. pnpm's strict `node_modules` adds a second layer: a package cannot import a dependency it has not declared. Rules about node built-ins (`fs`, `child_process`, network) do not apply to test files, which need temp directories and process harnesses. Relative imports may not leave their own package, except that test code (`*.test.*`, `test/` and `e2e/` folders) may import the development scripts in `scripts/`. Native addons are caught only when imported as `.node` files.

### 3.1 Between packages

| Package | May depend on | Must not depend on |
|---|---|---|
| `protocol` | `zod` | Any Jesutobits package |
| `shared` | nothing | Any Jesutobits package |
| `services` | `protocol`, `shared` | `runtime`, `apps/*` |
| `runtime` | `protocol`, `shared`, `services`, `extension-schema` | `apps/*` |
| `apps/vscode-extension/src` (Host) | `protocol`, `shared`; spawns the runtime bundle as a process | `runtime`, `services` |
| `apps/vscode-extension/webview` (panel) | `protocol`, `shared`, `extension-schema` (types and token compiler), `builtin-themes` (token files) | `runtime`, `services`, Node built-ins, `vscode` |
| `extensions/builtin/*` | nothing (data: a manifest and token or asset files) | Everything |
| `extension-schema` | `zod`, `shared` | `runtime`, `services`, `apps/*` |
| `extension-cli` | `extension-schema` | `runtime`, `services`, `apps/*` |
| `vite-plugin`, `visual-bridge`, `preview-launcher` | `protocol` as **type-only** imports; their own bundled dependencies | Everything else at runtime (ADR-0013) |

### 3.2 Inside packages

| Rule | Why |
|---|---|
| Only `extension.ts` and `vscode/` in the extension import `vscode`; `runtime/` and `host/` stay testable on plain Node | Testability; VS Code API in one place (ADR-0015) |
| Only `features/companion/renderers/` imports animation libraries | Renderer isolation (ADR-0006) |
| Only `ui/markdown/` may produce HTML from strings; `dangerouslySetInnerHTML` banned elsewhere | XSS defence (SECURITY.md section 8) |
| Components use theme tokens only; raw colour literals banned in `features/` and `ui/` | Theming (EXTENSION_SYSTEM.md section 4) |
| In `services`, only `workspace/` imports `node:fs` for project paths (plus `process/environment.ts`, which only checks PATH folders for executables); only `process/` imports `node:child_process` | Single enforcement points |
| In `runtime`, only `storage/` imports `node:sqlite`; only `providers/` performs model HTTP | Swappability and audit |
| In `runtime`, only `storage/` and `log/` import `node:fs` (plus `providers/scripted/cassette-file.ts`, which reads the development cassette named by `JESUTOBITS_CASSETTE`) | Project files go through WorkspaceService |
| `console.*` banned in `runtime` and `services` | Stdout carries the protocol (ADR-0003) |
| Native addons banned in `runtime` and `services` | ADR-0002 |
| Tools never import other tools; shared logic goes to `services` or `tools/common` | Avoid hidden coupling |

## 4. Conventions

- **Language:** TypeScript strict; documentation in British English; code identifiers follow platform conventions (for example CSS `color`).
- **Files:** kebab-case for modules, PascalCase for React components, `*.test.ts` colocated.
- **IDs:** ULID with type prefix (ARCHITECTURE.md section 6.5).
- **Errors:** `JesutobitsError` with stable dotted codes (ARCHITECTURE.md section 9.1).
- **Schemas first:** any new RPC method, event, bridge or webview message is added to `packages/protocol` before implementation; generators update JSON Schemas and `methods.json`. The extension builds its allowlists from the same schemas at runtime (`methodsCallableBy`, `WEBVIEW_HOST_OPS`).
- **Generated files** carry a header `// Generated by scripts/<name>. Do not edit.` (a `$comment` field in JSON) and are checked in only when something reads them without building: `packages/protocol/generated/methods.json`. JSON Schemas go to `packages/protocol/dist/json-schema/`. CI runs `pnpm gen:check`.
- **Migrations:** `packages/runtime/src/storage/migrations/NNNN_short_name.sql`, never edited after merge.
- **Prompts:** `packages/runtime/src/agent/prompts/` with a version constant bumped on every change.
