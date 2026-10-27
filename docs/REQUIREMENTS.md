# Requirements

> Status: Baseline v0.1 for the MVP. IDs are stable: never renumber, only deprecate.
> **Priority:** `MVP` must ship in the first release. `Later` is designed for but not built in the MVP.
> **Trace:** journey IDs from PRODUCT_VISION.md section 6, and the design document that specifies the requirement.

Conventions:

- "Must" is mandatory for the stated priority. "Should" is expected unless an ADR records why not.
- A requirement is done when its acceptance criteria (here, in the linked journey, or in the linked design section) have automated tests, except where TESTING_STRATEGY.md marks a manual check.

---

## 1. Functional requirements

### 1.1 Onboarding and workspace management

| ID | Requirement | Priority | Trace |
|---|---|---|---|
| FR-001 | First-run onboarding must offer, in order: welcome, default workspace folder, model provider, credentials, theme, companion, create or open project. Every step except the workspace folder can be skipped. Progress survives restarts. | MVP | J-01, UX 3 |
| FR-002 | The user must be able to choose a default workspace folder. It only determines where **new** projects are created. | MVP | J-03 |
| FR-003 | The user must be able to open any folder on the computer as a project through the OS folder picker. | MVP | J-05 |
| FR-004 | Jesutobits must keep a recent-projects list (name, canonical path, last opened, trust state, missing indicator) with Open, Locate and Remove actions. | MVP | J-05 |
| FR-005 | Jesutobits must create new projects from built-in templates: React + Vite + TS + Tailwind, React + Vite + TS, Empty, General workspace. Templates ship with Jesutobits. | MVP | J-04 |
| FR-006 | Opening a project not created by Jesutobits must ask for a trust decision. Untrusted projects run in Restricted mode: no commands, dev servers or code-executing tools. | MVP | J-05, SECURITY 5.4 |
| FR-007 | Jesutobits must never move, rename, reformat or add files to a project except through a user action or an approved agent action. Opening a project writes nothing into it. | MVP | J-03, J-05 |
| FR-008 | Switching projects must preserve each project's layout, open tabs and active session, and stop the previous project's dev servers unless the user pinned them. | MVP | UX 4.4 |
| FR-009 | Projects are identified by canonical absolute path (symlinks resolved, case-normalised on Windows). | MVP | DATA 3 |
| FR-010 | Jesutobits must detect Git, Node.js and the project's package manager, show versions, and guide installation when missing without blocking non-dependent features. | MVP | J-01 |
| FR-011 | Settings must cover: workspace, providers and models, agent limits, permissions, appearance, companion, previews, extensions, privacy, advanced. | MVP | UX 8 |
| FR-012 | MVP supports one window with one active project. Multiple windows are designed for but deferred. | MVP | ARCH 12 |

### 1.2 Model providers

| ID | Requirement | Priority | Trace |
|---|---|---|---|
| FR-020 | The runtime must access models only through the `ModelProvider` contract. OpenRouter is the first adapter. | MVP | ADR-0005 |
| FR-021 | Credentials must be stored only in the OS credential store and never written to files, logs, model context or child-process environments. | MVP | J-02, SECURITY 3 |
| FR-022 | The model picker must show context window, pricing and capability flags, and agent mode must only allow models that support tool calling. | MVP | J-02 |
| FR-023 | Jesutobits must offer a "Test connection" action for provider credentials with categorised results. | MVP | J-02 |
| FR-024 | Model output must stream into the UI incrementally. | MVP | HARNESS 2 |
| FR-025 | Provider errors must be mapped to categories (auth, credits, rate limit, context length, invalid request, provider unavailable, timeout, network, cancelled) with plain-language guidance. | MVP | J-15, HARNESS 2.5 |
| FR-026 | Jesutobits must show token usage and estimated cost per turn and per session, and enforce per-turn and per-session budget caps. | MVP | HARNESS 3.4 |
| FR-027 | New providers must be addable by implementing the adapter contract without changes to the agent loop, tools or UI beyond provider settings. | Later | ADR-0005 |

### 1.3 Agent harness

| ID | Requirement | Priority | Trace |
|---|---|---|---|
| FR-030 | Each project has persistent agent sessions with full history; a session can be renamed, archived or deleted. | MVP | DATA 4 |
| FR-031 | The agent loop must execute model-requested tool calls until the task completes, is cancelled, needs user input, or hits a limit. | MVP | J-06, HARNESS 3 |
| FR-032 | The user must be able to cancel a turn at any time. Cancellation aborts the model request, stops running tools and processes started by the turn, and leaves files consistent. | MVP | HARNESS 3.5 |
| FR-033 | Limits on steps per turn, wall-clock time, tokens and cost must be enforced by the harness, with configurable defaults. | MVP | HARNESS 3.4 |
| FR-034 | The harness must detect loops (identical tool call repeated, repeated identical failures) and stop to ask the user. | MVP | HARNESS 3.6 |
| FR-035 | The agent's plan must be visible as a checklist via the `update_plan` tool, labelled as agent-declared. | MVP | J-06 |
| FR-036 | The agent must be able to ask the user a clarifying question (`ask_user`), which pauses the turn. | MVP | HARNESS 5 |
| FR-037 | The context builder must assemble project map, instructions files, open editor state, selected element, recent diagnostics and history within a token budget. | MVP | HARNESS 4 |
| FR-038 | Long sessions must be compacted (summarised) automatically before reaching the model's context window, with the compaction visible in the timeline. | MVP | HARNESS 4.4 |
| FR-039 | The harness must track verification evidence and label any completion claim that lacks evidence after the last change as **Unverified**. | MVP | HARNESS 7 |
| FR-040 | Each turn ends with a summary: files changed by tools (with diffs), files changed by commands, commands run, checks and results, and open issues. | MVP | J-07, HARNESS 7.4 |
| FR-041 | After a runtime restart, sessions reload; a turn that was in progress is marked Interrupted and can be retried. | MVP | J-15 |
| FR-042 | The harness must read `AGENTS.md` (root and nested, nearest first) and `.jesutobits/instructions.md` when present, and present them to the model labelled as project instructions. | MVP | HARNESS 4.2 |
| FR-043 | A General workspace (scratch folder) must allow non-coding tasks with the same tools and permissions. The agent must not control other applications. | MVP | U5 |

### 1.4 Tools and permissions

| ID | Requirement | Priority | Trace |
|---|---|---|---|
| FR-050 | Every tool has a Zod input schema, risk class, permission rule, timeout, output format and error format. Invalid input is returned to the model as a structured error, not executed. | MVP | HARNESS 5 |
| FR-051 | File tools must be confined to the project root and user-approved extra roots, including after resolving symlinks and junctions. | MVP | SECURITY 5.2 |
| FR-052 | File edits must use optimistic concurrency: an edit fails if the file changed since the agent last read it. | MVP | HARNESS 5.3 |
| FR-053 | Commands run as argv without a shell by default, with cwd inside the project, a timeout, captured and truncated output, and a sanitised environment. | MVP | ADR-0011 |
| FR-054 | Every tool call is classified by risk and resolved to allow, ask or deny by policy. Users can set per-project policy and session-scoped allow rules. | MVP | SECURITY 4 |
| FR-055 | Approval cards show the exact action, risk category and the agent's explanation (labelled), with Allow once, Allow for session, Deny, Deny with message. | MVP | J-14 |
| FR-056 | Prohibited-by-default actions are blocked without an approval card and explained to the user and the model. | MVP | SECURITY 4.3 |
| FR-057 | Git tools: status, diff and log run automatically; stage and commit require approval; push, force operations, history rewriting and branch deletion are prohibited for the agent by default. | MVP | SECURITY 4 |
| FR-058 | Tool-made file changes are checkpointed per turn and can be reverted per turn or per file; command-made changes are listed. | MVP | ADR-0012 |
| FR-059 | Reading files matching secret patterns (`.env*`, keys, credentials) requires approval, and their contents are redacted from logs. | MVP | SECURITY 6 |
| FR-060 | A `fetch_url` tool for web content must be approval-gated by domain and mark fetched content as untrusted. | Later | SECURITY 7 |
| FR-061 | A global Stop control (button and shortcut) must cancel the active turn and stop all agent-started processes within 2 seconds. | MVP | HARNESS 3.5 |

### 1.5 Workbench (IDE-like interface)

| ID | Requirement | Priority | Trace |
|---|---|---|---|
| FR-070 | The Workbench must provide panels for explorer, editor, preview, agent chat, timeline, terminal and diagnostics, inspector, and companion, each resizable and collapsible. | MVP | UX 4 |
| FR-071 | Layout presets (Build, Code, Design, Focus) must be available; the user's arrangement persists per project. | MVP | UX 4.3 |
| FR-072 | The file explorer supports tree navigation, create, rename, delete (to OS trash), reveal in OS, and dims ignored files. | MVP | UX 5 |
| FR-073 | The editor supports tabs, save, dirty state, external-change handling, and diff review of agent changes. | MVP | ADR-0004 |
| FR-074 | Quick open (files) and project text search must be available. | MVP | UX 5 |
| FR-075 | The terminal panel provides interactive shells (multiple tabs) backed by a PTY. | MVP | ADR-0011 |
| FR-076 | The diagnostics panel lists problems parsed from checks (TypeScript, ESLint, Vite errors) with links to source. | MVP | HARNESS 7 |
| FR-077 | The activity timeline shows every runtime event with category, summary, duration, status and expandable details. | MVP | J-07, UX 6 |
| FR-078 | The chat panel renders model output as sanitised Markdown (no raw HTML, no remote images by default). | MVP | SECURITY 8 |
| FR-079 | A command palette and keyboard shortcuts cover all primary actions. | MVP | UX 9 |
| FR-080 | A minimal Git panel shows changed files, diffs, and lets the user commit. | MVP | UX 5.5 |

### 1.6 Live preview

| ID | Requirement | Priority | Trace |
|---|---|---|---|
| FR-090 | Jesutobits must detect a preview strategy per project: instrumented (`vite-react` adapter) or generic (project dev script). | MVP | VISUAL 3 |
| FR-091 | Dev servers can be started, stopped and restarted by the user and by the agent (with permission). Ports are allocated to avoid collisions. | MVP | J-08, VISUAL 4 |
| FR-092 | Readiness is detected by HTTP probing, with timeout and clear failure states. | MVP | VISUAL 4.3 |
| FR-093 | Dev server logs are viewable and searchable; errors are highlighted and available to the agent through a tool. | MVP | VISUAL 4.4 |
| FR-094 | The preview panel has reload, path field, viewport presets (mobile, tablet, desktop, custom), and Open in browser. | MVP | UX 7 |
| FR-095 | One preview session per project in MVP; the design supports several (for monorepos) later. | MVP | VISUAL 4.6 |
| FR-096 | Hot module reload is used when available; otherwise Jesutobits reloads on file changes. | MVP | VISUAL 4.5 |
| FR-097 | The agent can start a preview, read its status and logs, and run `check_preview` in a headless browser. | MVP | HARNESS 5, ADR-0010 |
| FR-098 | Dev servers stop on project close and app exit; orphans from crashes are reaped on next start. | MVP | ADR-0011 |
| FR-099 | Mobile previews (Expo, React Native) are supported through additional preview adapters. | Later | VISUAL 10 |

### 1.7 Visual editing

| ID | Requirement | Priority | Trace |
|---|---|---|---|
| FR-110 | Inspect mode and Interact mode are explicit and switchable (toolbar and shortcut). | MVP | J-09 |
| FR-111 | In Inspect mode, hover highlights and click selects an element; the user can move to parent, first child and siblings. | MVP | VISUAL 5 |
| FR-112 | The selection card shows tag, component, source location, instance count and editability summary. | MVP | J-09 |
| FR-113 | "Ask agent" attaches the selected element's context to the next message. | MVP | J-09 |
| FR-114 | "Open in editor" jumps to the element's JSX location. | MVP | VISUAL 5 |
| FR-115 | The inspector shows supported properties with Editable, Read-only (with reason) or Not supported states. | MVP | J-10, VISUAL 7 |
| FR-116 | Draft (preview-only) changes are applied instantly, clearly labelled, and discardable. | MVP | J-10 |
| FR-117 | Drafts can be applied to source for supported cases, producing a minimal diff and HMR update, with re-selection. | MVP | J-10, VISUAL 8 |
| FR-118 | Applied visual edits can be undone while the file is unchanged since the edit. | MVP | VISUAL 8.4 |
| FR-119 | Unsupported or read-only properties offer "Ask agent to change this" with a prefilled instruction. | MVP | VISUAL 7 |
| FR-120 | When visual editing is unavailable, the UI says why and which project types are supported. | MVP | VISUAL 3 |
| FR-121 | Editing props at a component's usage site and visual editing for other frameworks. | Later | VISUAL 10 |

### 1.8 Companion

| ID | Requirement | Priority | Trace |
|---|---|---|---|
| FR-130 | The companion's state must be derived only from runtime events and app state; no random or fake activity. | MVP | COMPANION 3 |
| FR-131 | Expressiveness levels: Off, Minimal, Standard, Expressive. Placement and size are configurable. | MVP | COMPANION 6 |
| FR-132 | Reduced motion (OS setting or app setting) must switch to static poses. | MVP | COMPANION 7 |
| FR-133 | The companion must never cover the editor, preview, approval cards or primary controls. | MVP | UX 4.5 |
| FR-134 | Companion skins can be selected and previewed per state in Settings. | MVP | J-12 |
| FR-135 | Companion sounds are off by default and require explicit enabling. | MVP | COMPANION 6 |
| FR-136 | Companion state changes have an accessible text equivalent (status text and optional live-region announcements). | MVP | COMPANION 7 |

### 1.9 Extensions

| ID | Requirement | Priority | Trace |
|---|---|---|---|
| FR-140 | Themes are declarative token packages. Built-in: Light, Dark, High Contrast. | MVP | EXT 4 |
| FR-141 | Companion skins are declarative packages (assets + state mapping). | MVP | EXT 5 |
| FR-142 | Extensions install locally from a `.jesutobitspkg` file or, in developer mode, from an unpacked folder with live reload. | MVP | EXT 9 |
| FR-143 | Packages are validated (manifest, assets, sizes, formats, permissions) before install, with specific error messages. | MVP | J-12, EXT 7 |
| FR-144 | Extensions can be enabled, disabled, switched, updated (by installing a newer version) and uninstalled. | MVP | J-13, EXT 8 |
| FR-145 | Requested permissions are shown before install and on the extension's detail page. | MVP | EXT 6 |
| FR-146 | Compatibility (`engines.jesutobits`) is checked on install and on Jesutobits upgrade; incompatible extensions are disabled with a notice. | MVP | EXT 8.4 |
| FR-147 | Safe mode starts Jesutobits with all extensions disabled; it is entered manually or automatically after repeated extension-load crashes. | MVP | J-13 |
| FR-148 | Themes and companion skins can be previewed before activation. | MVP | J-11, J-12 |
| FR-149 | Stage 2 sandboxed UI mods with a permissioned extension API. | Later | ADR-0007 |
| FR-150 | Stage 3 tool-integration mods via MCP servers. | Later | ADR-0007 |
| FR-151 | A community repository or marketplace. | Later | EXT 11 |

### 1.10 Audit, data and recovery

| ID | Requirement | Priority | Trace |
|---|---|---|---|
| FR-160 | Each session has an audit view listing approvals, denials, commands run and files changed. | MVP | SECURITY 9 |
| FR-170 | Sessions can be exported as Markdown or JSON (secrets redacted). | MVP | DATA 7 |
| FR-171 | Settings > Privacy offers "Clear session history", "Clear logs" and "Reset Jesutobits" (does not touch projects). | MVP | DATA 7 |
| FR-172 | Upgrades back up settings and the database before migrating; failed migrations roll back and report. | MVP | DATA 6 |

---

## 2. Non-functional requirements

Reference machine: Windows 11, 4-core CPU, 8 GB RAM, SSD, no other heavy apps.

| ID | Category | Requirement | Priority |
|---|---|---|---|
| NFR-001 | Performance | Cold start to interactive window within 3 s on the reference machine (excluding first-run install); the Jesutobits extension adds under 500 ms to the same Code-OSS build's start (ADR-0015). | MVP |
| NFR-002 | Performance | Runtime answers `initialize` within 2 s of spawn. | MVP |
| NFR-003 | Performance | No Workbench main-thread task longer than 100 ms during token streaming, large logs (100k lines) or large timelines (5k events); long lists are virtualised. | MVP |
| NFR-004 | Resources | Idle memory Jesutobits adds (runtime + agent webview, one small project, no preview) under 200 MB over the same Code-OSS build without the extension (ADR-0015). | MVP |
| NFR-005 | Distribution | Windows installer under 160 MB. | MVP |
| NFR-006 | Performance | The extension's webview relay adds under 5 ms p95 latency per runtime message on the reference machine. | MVP |
| NFR-007 | Security | Secrets never appear in plaintext on disk outside the OS store, in logs, in model context or in child environments. Verified by automated canary tests. | MVP |
| NFR-008 | Security | Jesutobits webviews have no Node or VS Code API access; the extension accepts only allowlisted, schema-checked methods from them (ADR-0015). | MVP |
| NFR-009 | Reliability | Runtime crashes auto-restart with backoff; no session data is corrupted (SQLite transactions, WAL); file writes are atomic (write temp then rename). | MVP |
| NFR-010 | Reliability | No processes started by Jesutobits survive app exit; after a crash, survivors are reaped on next start (the runtime exits when its stdin closes). | MVP |
| NFR-011 | Accessibility | App chrome meets WCAG 2.2 AA: keyboard operable, visible focus, labelled controls, contrast, reduced motion. | MVP |
| NFR-012 | Portability | Windows 10 (22H2) and 11 x64 at MVP. No architectural change needed for macOS arm64 and Linux x64. | MVP |
| NFR-013 | Availability | Without network, Jesutobits works as editor, terminal and preview tool, and states clearly that agent features need the provider. | MVP |
| NFR-014 | Observability | Structured JSON logs with correlation IDs (session, turn, call, process), local only, rotated (10 files × 10 MB per component). | MVP |
| NFR-015 | Privacy | No data leaves the machine except requests to the configured model provider and actions the user approves. No telemetry by default. | MVP |
| NFR-016 | Testability | The agent loop, tools and permissions are fully testable without network or paid model calls. | MVP |
| NFR-017 | Maintainability | Package dependency rules (PROJECT_STRUCTURE.md section 3) are enforced by lint in CI. | MVP |
| NFR-018 | Robustness | A broken extension cannot crash Jesutobits or block startup; failures fall back to defaults with a notice. | MVP |
| NFR-019 | Scale | Projects with 100,000 files (excluding ignored folders) open without freezing; the tree loads lazily. | MVP |
| NFR-020 | Localisation | UI strings are externalised; English only at MVP. | MVP |
| NFR-021 | Upgradeability | Settings, database and extension manifests are versioned with forward migrations and backups. | MVP |
| NFR-022 | Performance | Inspect-mode hover highlight tracks the pointer at 60 fps on the reference machine for pages up to 3,000 DOM nodes. | MVP |
| NFR-023 | Resources | The companion uses under 2% CPU when idle and pauses when the window is hidden or minimised. | MVP |
| NFR-024 | Security | All IPC messages are schema-validated on receipt (Workbench, Host for `host.*`, runtime, bridge). | MVP |
| NFR-025 | Reliability | Cancelling a turn returns the runtime to idle within 2 s in 99% of cases (FR-061). | MVP |
