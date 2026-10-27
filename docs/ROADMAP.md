# Roadmap

> Status: Agreed plan. Durations are rough planning ranges for one to two developers working with coding agents, not commitments.
> Version scheme: Phases 1 and 2 shipped `0.1` and `0.2`; the Code-OSS pivot (ADR-0015) ships `0.3`, and Phases 3 to 6 ship `0.4` to `0.7`. The MVP release is **1.0** after Phase 7.

## 1. Changes from the suggested sequence

The suggested phase order is kept, with four adjustments driven by risk:

1. **Spikes move into Phase 0.** The riskiest assumptions (Node sidecar lifecycle on Windows, Vite instrumentation, localhost iframes in OS webviews) are tested before anything depends on them.
2. **Theme tokens move into Phase 1.** Every Workbench component uses tokens from the first line of UI code. Retrofitting tokens later is expensive. Only *installing* themes waits for Phase 6.
3. **Verification moves into Phase 3** with commands, because "do not claim it works" must be true from the first time the agent can run anything.
4. **The runtime skeleton starts in Phase 1**, because the Workbench reads files through the runtime's WorkspaceService from day one (single writer).

```mermaid
flowchart LR
    P0["Phase 0<br/>Foundations + spikes"] --> P1["Phase 1<br/>Desktop shell"]
    P1 --> P2["Phase 2<br/>Minimal harness"]
    P2 --> PV["Pivot<br/>Code-OSS fork"]
    PV --> P3["Phase 3<br/>Coding workspace<br/>+ verification"]
    P3 --> P4["Phase 4<br/>Live previews"]
    P4 --> P5["Phase 5<br/>Visual editing"]
    P3 --> P6["Phase 6<br/>Companion + Stage 1 extensions"]
    P5 --> P7["Phase 7<br/>Hardening + 1.0"]
    P6 --> P7
```

Phase 6 depends on Phase 3 (runtime events exist), not on Phase 5, so it can run in parallel with Phases 4 and 5 if there are two people.

## 2. MVP versus later

| In MVP (1.0) | Later |
|---|---|
| Windows | macOS, Linux packages |
| OpenRouter | Direct Anthropic, OpenAI, Google; local models |
| Agent + Ask modes, project and general workspaces | Multiple windows, remote runtimes |
| File, search, command, process, check, preview, Git read + commit, visual tools | `fetch_url`, push/pull with approval, LSP integration |
| Generic + `vite-react` preview; visual editing for Tailwind and inline styles | Next.js, Expo, CSS Modules, usage-site prop edits, static sites |
| Companion: static + dotLottie renderers, 3 built-in skins | Rive renderer |
| Stage 1 extensions: themes, companion skins, layout presets; local install; CLI | Stage 2 UI mods, Stage 3 MCP integrations, repository/marketplace, signing |
| Tool-level checkpoints | Shadow-repo checkpoints, auto-commit to branch |
| Approval-based safety | OS-level command sandboxing |

## 3. Phases

### Phase 0: Foundations and spikes (2 to 3 weeks)

**Objectives:** prove the three riskiest assumptions; set up the repository, conventions and CI so later phases start fast.

**Included**
- Repository scaffold per PROJECT_STRUCTURE.md (empty packages with build, lint, test wired).
- `packages/protocol` with the envelope, error and first method schemas.
- CI on Windows and Ubuntu: lint, typecheck, unit tests, boundary rules.
- **Spike S1 (sidecar):** Tauri app spawns bundled Node running a stub runtime; JSON-RPC handshake over stdio; Host relay to a test page; Windows Job Object assignment; kill the Host from Task Manager and confirm no survivors; measure relay latency; open `node:sqlite` with WAL and write 10k events.
- **Spike S2 (visual edit feasibility):** in a plain browser, start a fixture Vite 8 + React 19 + Tailwind project through the launcher with an inline plugin (RN-24); instrument JSX; click an element and resolve its source; apply one Tailwind class change with `magic-string`; observe HMR.
- **Spike S3 (preview frame):** inside the Tauri Workbench on Windows (and WebKit in a Linux VM if available), load `http://127.0.0.1:<port>` in an iframe; postMessage both ways with origin checks; confirm no Tauri IPC from the frame.
- ADRs reviewed and statuses updated from spike results.

**Excluded:** any user-facing feature.

**Dependencies:** none.

**Deliverables:** scaffolded repo; spike reports in `docs/spikes/S1.md`, `S2.md`, `S3.md`; updated ADRs and RESEARCH_NOTES.

**Acceptance criteria**
- S1: handshake < 2 s; relay p95 < 5 ms for 1 KB messages; zero orphan processes in 10 forced-kill trials; 10k event inserts < 2 s.
- S2: selection resolves to the correct file:line:column for 20 sampled elements; class edit appears via HMR within 1 s; project `vite.config` untouched.
- S3: iframe loads and messages flow on Windows; IPC call attempt from the frame is rejected.
- CI green on both OSes.

**Tests:** spike scripts kept as integration tests where possible (S1 orphan test becomes a nightly desktop test).

**Risks:** S2 merge behaviour fails (fallback: wrapper config); S3 blocked by webview policy (fallback: proxy protocol).

**Definition of done:** spike reports written, ADR-0009 and ADR-0010 updated to Accepted or revised, CI green.

### Phase 1: Desktop shell (3 to 4 weeks) → 0.1

**Objectives:** a usable workbench that opens projects, edits files and looks like Jesutobits.

**Included**
- Host: runtime supervisor (from S1), settings store, folder dialog, window state.
- Runtime skeleton: `runtime.*`, `projects.*`, `fs.*` methods; WorkspaceService (confinement, atomic writes, watcher); projects table; migrations framework.
- Workbench: `HostBridge` + `MockHostBridge`; dock layout with presets and persistence; explorer; Monaco editor with tabs, save, external-change handling; quick open; status bar.
- ThemeEngine with token compiler; built-in Light, Dark, High Contrast as token packages.
- Start screen, recent projects, open folder, trust prompt (Restricted mode flag stored; enforcement arrives with tools).
- Onboarding skeleton: welcome, workspace folder, toolchain check, theme (provider steps stubbed).

**Excluded:** agent, terminal, previews, Git, companion visuals.

**Dependencies:** Phase 0.

**Deliverables:** Windows dev build; Playwright browser E2E for open/edit/save; desktop smoke test.

**Acceptance criteria**
- Cold start < 3 s on the reference machine (NFR-001).
- Open a 100k-file project without UI freeze (NFR-019).
- Editing and saving a file round-trips through WorkspaceService atomically; external change shows the "changed on disk" bar.
- Switching theme recolours UI and editor in < 200 ms.
- Layout changes persist per project across restarts.
- axe: no serious violations on start screen, workbench and settings.

**Tests:** unit (WorkspaceService, theme compiler, layout state), E2E (J-01 partial, J-03, J-05), desktop smoke.

**Risks:** Monaco worker setup in Tauri CSP; lazy tree performance.

**Definition of done:** acceptance criteria met, docs updated, CI and nightly green.

**Decisions made while planning Phase 1 (2026-10-20):**
- Deleting from the explorer goes through the Host (ADR-0014).
- The spawning core (`services/src/process`) is built in Phase 1 for the toolchain check; Phase 3's ProcessSupervisor builds on it (ADR-0011 notes).
- `projects.create` offers the Empty and General workspace templates in Phase 1; the React templates arrive with J-04 in Phase 4.
- Project text search (FR-074, `Ctrl+Shift+F`) needs the ripgrep sidecar and arrives in Phase 2; Phase 1 has quick open.
- While the npm registry was unreachable (2026-10-21), work that needs no new packages was done first. Tailwind 4.3.3 was installed from the local pnpm store; Zustand is added once the registry is back.
- Layout presets in Phase 1 (step 14): every project opens with Code, because Build and Design centre on the agent and the preview, which arrive in Phases 2 and 4; Build becomes the default for projects created from the React templates in Phase 4. Panels for later features (agent, preview, inspector, terminal, problems) say which version brings them. Saving a layout as a named preset (UX_AND_INTERFACE.md section 4.3) arrives with Stage 1 layout extensions in Phase 6; Phase 1 keeps the user's arrangement per project as "Custom (based on …)" with Reset.
- Settings in Phase 1 (step 18): Workspace, Appearance (theme, follow OS, interface size, reduce motion, editor font size), This project (trust, J-05), Advanced (the relay latency panel moved here from the start screen) and About. The other FR-011 sections arrive with their features: providers and agent limits in Phase 2, permissions in Phase 3, previews in Phase 4, companion and extensions in Phase 6, privacy with the provider. Settings open from the start screen, the title bar and `Ctrl+,`.
- After a runtime restart, the Workbench reopens its project (decided 2026-10-21, was Q13). A restarted runtime has no active project, so `fs.*` fails with `fs.no_project`. When the status returns to Ready after Restarting or Failed, the Workbench calls `projects.open` with the project ID it shows, then reloads the explorer and checks open editors against disk. Built in step 13.

**Acceptance (2026-10-22, 0.1.0).** Checked on the development machine (Windows 11, WebView2 155):

| Criterion | Result | Evidence |
|---|---|---|
| Cold start < 3 s (NFR-001) | Met: median 1.44 s over 6 launches of a release build, first launch after the build 2.24 s; runtime `initialize` answered 0.38 s after spawn (NFR-002) | `scripts/bench-startup.mjs` (nightly) |
| 100k-file project without UI freeze (NFR-019) | Met: index in the runtime; in the Workbench the longest main-thread task while opening, listing and searching was 96 ms (NFR-003 limit 100 ms, development build) | `packages/services/test/large-tree.perf.test.ts`, `apps/desktop/e2e/perf/large-project.spec.ts` (nightly) |
| Save round-trips atomically; external change shows the bar | Met | `e2e/journeys/editor.spec.ts`, editor store tests, WorkspaceService tests |
| Theme switch recolours UI and editor < 200 ms | Met: CSS variables about 5 ms, Monaco theme logged and asserted under 200 ms | `e2e/journeys/editor.spec.ts`, `settings.spec.ts` |
| Layout persists per project across restarts | Met | `e2e/journeys/layout.spec.ts`, layout store tests |
| axe: no serious violations on start screen, Workbench, settings | Met (also onboarding, dialogs, palettes, explorer menus) | every journey calls `expectAccessible` |
| Tests: unit, E2E J-01 partial, J-03, J-05, desktop smoke | Met | `pnpm test`, `pnpm test:e2e` (CI), `pnpm test:desktop` (nightly) |
| Deliverables: Windows build, Playwright E2E, desktop smoke | Met: `pnpm --filter @jesutobits/desktop tauri build` produces an unsigned NSIS installer (signing: Q7) | |

Found and fixed during acceptance: quick open kept saying the index was still being built after it was done (it now asks again while indexing).

Still open from Phase 0: a clean-machine run of DEVELOPMENT_SETUP.md and WebKit runs of S3. The nightly workflow has not run on GitHub yet.

### Phase 2: Minimal agent harness (3 to 4 weeks) → 0.2

**Objectives:** a real agent loop with streaming, file tools and honest events.

**Included**
- Secret store (Host) and credentials onboarding steps; `host.secrets.get`.
- Provider contract, OpenRouter adapter (streaming, tools, errors, model list and capabilities), `ScriptedProvider`, cassette tooling.
- AgentLoop with turn state machine, limits, loop guard, cancellation, pause/resume; ContextBuilder with instructions files, budgeting, elision and compaction.
- Tools: `list_directory`, `read_file`, `search_files`, `search_text` (ripgrep sidecar), `write_file`, `edit_file`, `move_path`, `delete_path`, `update_plan`, `ask_user`.
- PermissionBroker with policy presets for `read`, `write`, `destructive`, `sensitive_read`, `outside_workspace` (execute arrives in Phase 3).
- Sessions persistence; event bus with replay; chat panel with sanitised Markdown; basic timeline list; plan checklist; status bar agent state; Stop.
- Tool-level checkpoints and "Revert turn".

**Excluded:** commands, terminal, Git, previews, verification checks.

**Dependencies:** Phase 1.

**Deliverables:** agent can create and edit files in a project end to end with a real OpenRouter key.

**Acceptance criteria**
- First timeline activity within 2 s of sending (J-06).
- Cancel reaches idle in < 2 s in 99 of 100 scripted runs (NFR-025).
- Fake API key canary absent from all files and events (NFR-007).
- All provider failure scenarios in TESTING_STRATEGY.md section 5 pass.
- Revert turn restores all tool-modified files byte-for-byte.

**Tests:** provider adapter suite, agent-loop cassettes, tool contracts, permission tables (non-execute), canaries.

**Risks:** tool-call quality varies by model (mitigate with the model picker's tools filter and eval suite); compaction quality.

**Definition of done:** acceptance criteria met; J-02 and a file-only J-06 pass in E2E.

**Acceptance (2026-10-26, 0.2.0).** Checked on the development machine (Windows 11):

| Criterion | Result | Evidence |
|---|---|---|
| First timeline activity within 2 s of sending (J-06) | Met | `e2e/journeys/agent-file-edit.spec.ts`, `packages/runtime/test/agent-turn.test.ts` |
| Cancel reaches idle in < 2 s in 99 of 100 scripted runs (NFR-025) | Met: 100 of 100, p50 1.6 ms, p99 7.9 ms (half cancelled while streaming, half while waiting for approval) | `scripts/bench-cancel.mjs`; `agent-interaction.test.ts` cancels 5 times per run |
| Fake API key canary absent from all files and events (NFR-007) | Met: the key travels only in the provider request's header; no event, log line or file under the data dir holds it, even when pasted into a message. The desktop app was also checked by hand: no file under its data, config or log folders held the test key | `packages/runtime/test/agent-canary.test.ts` |
| Provider failure scenarios (TESTING_STRATEGY.md section 5) | Met: first-byte and idle timeouts, mid-stream errors, 429, 402, a tool that throws or ignores cancellation, an interrupted session, a denied approval, a file changed during an edit, disk full or permission errors | `provider-caller.test.ts`, `agent-failures.test.ts`, `runner.test.ts`, `agent-recovery.test.ts`, `agent-approvals.test.ts`, `write-tools.test.ts`, `write-failures.test.ts` |
| Revert turn restores all tool-modified files byte for byte | Met, including CRLF files with a BOM, created and deleted files | `checkpoints.test.ts`, `agent-recovery.test.ts`, J-06 E2E |
| DoD: J-02 and a file-only J-06 pass in E2E | Met, with J-14 (approvals) too | `e2e/journeys/provider-setup.spec.ts`, `agent-file-edit.spec.ts`, `agent-approvals.spec.ts` |
| Deliverable: create and edit files end to end with a real OpenRouter key | Desktop app checked by hand with the scripted provider (the Host's secrets commands, `runtime.configure`, a full turn, ripgrep search); a run with a real key waits for the owner's key | live check, 2026-10-26 |

Found and fixed during the phase: user messages and session titles were stored without masking (the canary test caught it); the session picker collapsed and tool rows wrapped in the agent panel (found in the desktop app).

**Decisions made while building Phase 2 (2026-10-22 to 2026-10-26):**
- Phase 2 is on its own branch, `phase-2/agent-harness`, made from `phase-1/desktop-shell`, so PR #1 stays Phase 1 only.
- Session history is the session's stored events (`sessions.history`); the Workbench folds stored and live events through one reducer. Text deltas are not stored; `model.step_completed` carries each step's full text.
- The runtime gets the settings it acts on from the Host (`runtime.configure`, after every handshake and change), because the Host owns `settings.json`.
- The SSE parser is our own (ADR-0005 notes): `eventsource-parser` could not be installed with the npm registry unreachable. The Markdown renderer is our own too (`apps/desktop/src/ui/markdown/`), producing React elements only, for the same reason and because it avoids HTML strings entirely.
- Text search uses ripgrep 15.2.0 as a second sidecar (`jesutobits-rg`, `scripts/fetch-sidecars.mjs`), with a JS fallback. `fs.search` serves the Workbench's project search (FR-074).
- On Linux the credential store is the kernel keyring for now (ADR-0008 notes).
- Phase 2 session rules: per tool, and per path for `delete_path`; secret-file reads always ask. "Always allow in this project" arrives with commands (Phase 3).
- Tests and small self-contained modules were drafted with opencode (GLM and DeepSeek models) from written briefs and reviewed before commit; the reviews found and fixed a stored-secret leak (user messages and session titles were saved unmasked) and several wrong expectations.

### Pivot: Code-OSS fork (3 to 4 weeks) → 0.3

ADR-0015 moves Jesutobits from the Tauri shell to a Code-OSS fork. Phase 2's runtime carries over unchanged; the Workbench's IDE features are replaced by VS Code's. Phases 3 to 7 below are restated for the fork, and their version numbers move up by one.

**Included**
- A. Archive the Tauri shell (tag `tauri-final`, branch `archive/tauri`); ADR-0015; AGENTS.md invariants and gates; this roadmap.
- B. `apps/vscode-extension`: runtime supervisor on `ELECTRON_RUN_AS_NODE` (handshake, restart with backoff, kill on deactivate, PID ledger for NFR-010); reverse methods on `SecretStorage`, `workspace.fs` trash and `revealFileInOS`; workspace folder as the project; `jesutobits.*` settings to `runtime.configure`; `WebviewHostBridge` (CSP, nonce, schema checks, method allowlist); the Phase 2 agent panel in a webview styled with `--vscode-*` variables; approvals and reverts through `vscode.diff`; status bar agent state; onboarding walkthrough and "Set OpenRouter API key" command.
- C. `jesutobits-ide`: fork of `microsoft/vscode` at a stable tag; `product.json` branding, icons and Open VSX gallery; telemetry and updates off; the extension as a built-in; default layout (agent in the secondary side bar) and welcome page as patches listed in `PATCHES.md`; Windows installer; CI; `UPSTREAM.md` merge procedure.
- D. Delete `apps/desktop`, the Rust Host and the Node sidecar scripts; update README, ARCHITECTURE, PROJECT_STRUCTURE, SECURITY and UX_AND_INTERFACE.

**Deliverables:** the branded app installs on Windows and runs a Phase 2 J-06 turn (scripted provider) from the agent panel.

**Acceptance criteria**
- Extension integration tests (`@vscode/test-electron`, ScriptedProvider): handshake, secret round-trip, a turn with approval and byte-exact revert, cancel under 2 s, key canary absent from webview messages and logs.
- NFR-001, NFR-004 and NFR-006 measured against the same Code-OSS build without the extension.
- The installed app uses its own name, data folder and Open VSX; no request goes to Microsoft telemetry or update endpoints.

**Risks:** first fork build on the development machine (RN-43); upstream merge cost (ADR-0015 revisit triggers).

### Phase 3: Coding workspace and verification (4 to 6 weeks) → 0.4

**Objectives:** the agent can run commands safely, the user has a real IDE toolset, and completion claims are backed by evidence.

**Included**
- ProcessSupervisor (argv spawning, Windows shims, env allowlist, timeouts, tree kill, orphan ledger); tools `run_command`, `start_process`, `list_processes`, `read_process_output`, `stop_process`.
- Command classifier; full policy matrix; approval cards; session and project rules with script fingerprints; prohibited list; audit view.
- Restricted mode enforcement, mapped to VS Code Workspace Trust.
- Agent process output in VS Code output channels or read-only pseudoterminals (interactive terminals are VS Code's).
- GitService and tools (`git_status`, `git_diff`, `git_log`, `git_commit`); the Git UI is VS Code's.
- Check profiles, `run_check`, verification ledger, turn summary with labels, check problems published as VS Code diagnostics.
- Full timeline (categories, durations, expandable details, filters); multi-file diff review in VS Code's diff editor.
- Command side-effect detection in checkpoints.

**Excluded:** previews, visual editing, companion visuals.

**Dependencies:** Phase 2.

**Deliverables:** agent completes a "fix the failing test" task on `broken-build` with approvals and a Verified label.

**Acceptance criteria**
- Every row of the SECURITY.md policy matrix and prohibited list has a passing test.
- Editing a package script invalidates its session rule (T4).
- No orphan processes after 20 forced extension-host kills on Windows (NFR-010).
- A turn that changes files without fresh passing checks is never labelled Verified (property test).
- J-07, J-14, J-15 pass in E2E.

**Tests:** process supervisor (Windows and Linux), permission tables, journeys, extension integration tests.

**Risks:** Windows quoting edge cases for `cmd.exe`; noisy check output parsing (fallback to exit codes).

**Definition of done:** acceptance criteria met; security review of the broker and classifier by a second person.

### Phase 4: Live previews (3 to 4 weeks) → 0.5

**Objectives:** reliable in-app previews for any project with a dev script, and agent-side preview verification.

**Included**
- PreviewManager with `generic` and `vite-react` adapters (launcher without instrumentation first), port allocation, readiness, logs, lifecycle, project-switch behaviour, orphan reaping.
- Preview panel as a VS Code webview panel hosting the preview iframe: toolbar, viewport presets, logs tab, open in browser, crash states, LAN-binding warning. Re-check Spike S3's iframe findings (RN-37, RN-38) inside VS Code webviews first.
- Preview tools for the agent; `check_preview` with headless Chromium-family browser via `playwright-core` (system Edge/Chrome, on-demand download fallback).
- Bridge script v0 (hello, page errors, route changes) with origin and nonce checks.
- Verification includes preview checks for UI-affecting changes.

**Excluded:** inspect mode, inspector, drafts, source edits.

**Dependencies:** Phase 3 (process supervisor, verification), S3.

**Deliverables:** J-04 and J-08 end to end with the React template.

**Acceptance criteria**
- Template project reaches Ready in < 20 s on a warm cache on the reference machine.
- Busy preferred port is handled (port-hog test) with a visible notice.
- Crashed dev server shows last error lines within 1 s of exit.
- `check_preview` reports console errors from a fixture page that throws.
- Frame cannot reach the webview's `HostBridge` or any VS Code API (extension test).

**Tests:** preview manager suite, real-Vite nightly, journeys J-04, J-08.

**Risks:** headless browser availability on user machines (download size); slow first Vite start.

**Definition of done:** acceptance criteria met; ADR-0010 confirmed.

### Phase 5: Visual editing (5 to 7 weeks) → 0.6

**Objectives:** the defining feature: select, inspect, draft and apply real source edits for the supported React subset.

**Included**
- `@jesutobits/vite-plugin` instrumentation (`data-jesutobits-loc`, `data-jesutobits-comp`), exclusions, caching.
- Bridge v1: inspect mode, overlays, keyboard navigation, selection payloads, drafts, HMR hooks.
- Runtime `visual.inspect`, editability analysis, `SourceTransformer` for Tailwind classes, inline styles, text and `img` attributes; undo stack; checkpoints.
- Inspector panel with validation; selection card; Ask agent with element context; "Other properties: ask the agent".
- Agent tools `get_selected_element`, `inspect_source_element`, `apply_visual_edit`.
- Design layout preset auto-switch (with user consent).
- Unsupported-project messaging.

**Excluded:** usage-site prop editing, other frameworks, CSS-file styles, custom Tailwind theme mapping.

**Dependencies:** Phase 4, S2.

**Deliverables:** J-09 and J-10 end to end on `vite-react-tailwind` and `vite-react-inline`.

**Acceptance criteria**
- For 50 sampled elements across fixtures, selection resolves to the correct JSX location (100%).
- Each supported property produces a minimal diff (only the target attribute's text range changes) verified by golden tests.
- Draft → Apply → HMR → re-selection completes in < 1.5 s on the reference machine.
- Hover tracks at 60 fps on a 3,000-node page (NFR-022).
- Read-only states show correct reasons for each case in VISUAL_EDITING.md section 7.2.

**Tests:** transform golden tests, editability tables, Playwright visual-editing E2E (Chromium and WebKit).

**Risks:** HMR timing, library components, Tailwind class merging surprises (VISUAL_EDITING.md section 11).

**Definition of done:** acceptance criteria met; usability test with at least 5 users (2 beginners, 3 frontend developers) with no blocking issues.

### Phase 6: Companion and Stage 1 customisation (3 to 5 weeks) → 0.7

**Objectives:** the companion and the first extension ecosystem layer.

**Included**
- CompanionController (states, priorities, dwell, reactions), StaticRenderer, LottieRenderer (self-hosted WASM), built-in skins Ember, Dot, Pip; settings; accessibility.
- `packages/extension-schema` validator; archive checks in the extension and pack assets served to webviews through `localResourceRoots`; install, update, enable, disable, switch, uninstall; registry; compatibility checks; safe mode. Theme packs compile to VS Code colour themes, so the editor and chrome follow them.
- Theme and companion previews; Extensions settings UI; developer mode (load unpacked, live reload, token inspector, export theme).
- `@jesutobits/extension-cli` (`init`, `validate`, `pack`); authoring guide.

**Excluded:** Stage 2 and 3, Rive, marketplace, signing.

**Dependencies:** Phase 3 (events). Can run in parallel with Phases 4 and 5.

**Deliverables:** J-11, J-12, J-13 end to end; a third-party-style theme and skin built only with the CLI.

**Acceptance criteria**
- Companion truthfulness property test passes; no active state after a terminal turn event.
- Companion idle CPU < 2% and paused when hidden (NFR-023).
- Every invalid extension fixture is rejected with its specific error.
- Two consecutive crash-on-load starts lead to Safe mode.
- Theme switch < 200 ms; skin switch < 500 ms.

**Tests:** companion suites, extension validation and lifecycle, journeys J-11 to J-13.

**Risks:** Lottie performance on low-end machines (auto-downgrade to static); authoring friction for skins (CLI templates).

**Definition of done:** acceptance criteria met; authoring guide reviewed by someone who has not seen the code.

### Phase 7: Hardening and 1.0 (4 to 6 weeks)

**Objectives:** make it safe, fast, recoverable and installable.

**Included**
- Security review against SECURITY.md; threat-model regression tests; Workbench CSP finalised; dependency audit; Node Permission Model evaluation for the runtime (RN-17).
- Recovery: database and settings corruption paths, crash loops, interrupted turns.
- Performance pass against all NFRs; memory and startup profiling.
- Packaging: the fork's Windows installer, code signing, an update channel (none by default; decide Q13), packaging tests, an upstream merge to the latest stable VS Code.
- Accessibility audit (NVDA), copy review, diagnostics page, export and reset.
- Documentation: user guide, troubleshooting, extension authoring guide final.

**Excluded:** new features.

**Dependencies:** Phases 5 and 6.

**Deliverables:** 1.0 release candidate.

**Acceptance criteria**
- All MVP FRs implemented with tests; all NFRs measured and met (or waived in an ADR).
- Zero open critical or high security issues.
- Release-candidate gate in TESTING_STRATEGY.md section 7 passes.
- Clean install to first agent turn in < 5 minutes for a new user in usability testing.

**Definition of done:** 1.0 tagged; signed installer published; known issues documented.

## 4. Unresolved questions

| # | Question | Recommended default until decided | Decide by |
|---|---|---|---|
| Q1 | App identifier (the product name, Jesutobits, is decided) | Proposed `dev.jesutobits.app`; switch to a domain you control if you have one | Before Phase 7 (identifier affects data paths) |
| Q2 | Licence (open source, source-available, proprietary) | Architecture is neutral; keep third-party licences compatible with all options | Phase 0 |
| Q3 | Should Jesutobits bundle a Node toolchain for user projects to help beginners? | No; detect and guide (ADR-0011) | After Phase 4 beginner testing |
| Q4 | macOS and Linux release timing | After 1.0; keep CI on Ubuntu and WebKit tests from Phase 1 | After 1.0 |
| Q5 | Next providers | Anthropic and OpenAI direct, then a local-model adapter | 1.1 planning |
| Q6 | Opt-in crash reporting | None in 1.0 | After 1.0 |
| Q7 | Code-signing certificates and Apple developer account | Budget needed for Windows signing by Phase 7 | Phase 3 |
| Q8 | Auto-commit agent turns to a work branch (opt-in) | Not in 1.0 | 1.1 planning |
| Q9 | Recommended default model | Choose from eval results, not reputation | Phase 3 |
| Q10 | General workspace file previews (Markdown, CSV, images) | Markdown and images only in 1.0 | Phase 4 |
| Q11 | Extension signing scheme for a future repository | Decide with the repository design | Post-1.0 |
| Q12 | Default for "Install without running scripts" | Off (most projects need scripts), visible on every install card | Phase 3 user testing |
| Q13 | How the fork updates itself | No auto-update in 1.0; users download new installers. Revisit with code signing | Phase 7 |
| Q14 | Which VS Code release the fork follows | Latest stable tag at fork time; merge each new stable within a month | Pivot step 13 |

## 5. Next implementation milestone

**The Code-OSS pivot** (section 3, ADR-0015), then Phase 3 on the fork. Phase 2 is complete (0.2.0, acceptance above) except a run with a real OpenRouter key. The step plan: A (archive, ADR, docs) done 2026-10-27. B (the extension) mostly done 2026-10-27: runtime supervisor on VS Code's Electron, reverse calls, settings, workspace project and trust, the agent panel in a webview with a schema-checked bridge, the API key typed into VS Code's password box, changed files opening in the editor. Checked live in VS Code 1.143 with the scripted provider: handshake in 607 ms, a full turn edits the file, Revert turn restores it, and a force-killed window leaves no runtime behind. D's deletion of `apps/desktop` moved forward into B. Still open in B: the onboarding walkthrough and `@vscode/test-electron` integration tests in CI. C started 2026-10-27: https://github.com/divinefavourak/jesutobits-ide (public) holds the product overrides and prepare/build scripts for VS Code 1.143.1 and builds Windows x64 in GitHub Actions; local builds wait for a reachable npm registry and the MSVC Spectre-mitigated libraries. Its CI builds without the extension until the licence question (Q2) decides whether the compiled extension may be public. Phase 0's record follows.

**Phase 0**, in this order:

1. Scaffold the monorepo (PROJECT_STRUCTURE.md) and CI; confirm DEVELOPMENT_SETUP.md works on a clean Windows machine.
2. Write `packages/protocol` envelope, `JesutobitsError` and the `runtime.initialize`/`ping`/`shutdown` schemas.
3. Spike S1 (sidecar lifecycle, job object, relay latency, `node:sqlite`).
4. Spike S2 (Vite 8 inline plugin, JSX instrumentation, one class edit via HMR).
5. Spike S3 (localhost iframe and postMessage in the Tauri Workbench).
6. Update ADR-0001, 0002, 0009, 0010 and RESEARCH_NOTES with results.

**Progress (2026-10-20):**

- Step 1 is mostly done. The monorepo, boundary lint, CI (first GitHub run green on Windows and Ubuntu) and `apps/desktop/src-tauri` are in place. Still open: a clean-machine run of DEVELOPMENT_SETUP.md.
- Step 2 is done: the envelope, `JesutobitsError`, the `runtime.initialize`/`ping`/`shutdown` schemas and the Host status schema, plus generated JSON Schemas, `methods.json` and the Rust allowlist.
- Step 3 (Spike S1) is done on Windows: all four acceptance criteria are met, with one handshake outlier on a cold `pnpm dev` launch (`docs/spikes/S1.md`). It carries two follow-ups into Phase 1: auto-restart with backoff, and explaining one 3.7 s cold-start handshake.
- Step 5 (Spike S3) is done on Windows: the preview iframe loads and messages flow with the Workbench on `http://127.0.0.1:1420`, `http://tauri.localhost` and `https://tauri.localhost`; every IPC attempt from the frame is refused (`docs/spikes/S3.md`). ADR-0010 is Accepted with a corrected point 3. WebKit runs are still open.
- Step 4 (Spike S2) is done: 20 of 20 sampled elements resolve to the exact file:line:column, a class edit reaches the page through HMR in under 120 ms, `vite.config` untouched (`docs/spikes/S2.md`). ADR-0009 is Accepted.
- Phase 0 open items: a clean-machine run of DEVELOPMENT_SETUP.md, and WebKit runs of S3. Phase 1 can start.
