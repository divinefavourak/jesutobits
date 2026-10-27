# UX and Interface

> Status: Agreed interaction design. Visual design (exact colours, typography) is defined by the built-in themes (EXTENSION_SYSTEM.md section 4).

> **Reading this after ADR-0015 (Code-OSS fork):** "Host" is now the Jesutobits VS Code extension (`apps/vscode-extension/src`); "Workbench" is VS Code's window plus Jesutobits webviews (`apps/vscode-extension/webview`); Tauri IPC and capabilities are webview `postMessage` checked against `packages/protocol/src/webview.ts`; the OS credential store is VS Code SecretStorage; the "Node sidecar" is the runtime process on VS Code's Electron. Explorer, editor, terminal, Git, settings and colour themes are VS Code's. Sections are rewritten as their features are built on the fork.

## 1. UX principles

| Principle | In practice |
|---|---|
| **Workbench, not chatbot** | The agent is one panel among the explorer, editor, preview and terminal. The project is the centre, not the conversation. |
| **Show the real thing** | Timeline rows come from runtime events. Approval cards show real commands. Previews show the real app. |
| **One concept, one place** | Drafts vs applied edits, trusted vs restricted, verified vs unverified each have one consistent visual marker. |
| **Progressive disclosure** | Beginners see summaries; one click shows raw output, inputs and diffs. Nothing is hidden, only folded. |
| **Calm by default** | Subtle companion, no confetti, sounds off. Expressiveness is opt-in. |
| **Keyboard complete** | Every action is reachable from the command palette and most from shortcuts. |

## 2. Information architecture

```
Start screen
├── Create project (templates)
├── Open folder
├── Recent projects
└── Settings
Onboarding (first run only, resumable)
Workbench (one project per window)
├── Panels: Explorer, Editor, Preview, Agent (Chat | Timeline), Inspector, Bottom (Terminal | Problems | Preview logs | Output), Git, Companion
├── Status bar
└── Command palette
Settings
├── General · Workspace · Models & providers · Agent & limits · Permissions · Appearance · Companion · Previews · Extensions · Privacy · Advanced · About
Extensions (also reachable from Settings)
```

Workspace kinds: **Project** (a code folder) and **General workspace** (a scratch folder for non-coding tasks; same panels, preview hidden by default).

## 3. Onboarding

Shown on first run (FR-001). A step indicator shows 7 steps. Back is always available; Skip where allowed.

| Step | Screen content | Notes |
|---|---|---|
| 1. Welcome | "Jesutobits builds and changes software with an AI agent you can watch. Your projects stay on your computer; only your messages and the files the agent reads are sent to the model provider you choose." Buttons: Get started | Sets expectations about data flow |
| 2. Workspace folder | Suggested `Documents\Jesutobits Projects`, Change… button. Note: "New projects go here. You can open folders anywhere." | Folder created only on Continue (FR-002) |
| 3. Toolchain check | Git, Node.js, package manager: found/missing with versions; "Why this matters" expanders; Install links | Never blocks (FR-010) |
| 4. Model provider | OpenRouter card (others "coming later"); "What is OpenRouter?" link | Skip allowed: "Set up later" |
| 5. Credentials | Paste API key (masked), Test connection, result in plain words, default model picker filtered to tool-capable models with price and context size | Key goes to OS credential store (FR-021) |
| 6. Look and companion | Theme cards (Light, Dark, High Contrast, Follow system) with live mini-preview; companion: Ember (subtle), Dot (minimal), Pip (playful), Off; expressiveness slider | Both changeable later |
| 7. First project | Create from template, Open folder, or Explore a sample project | Ends in the Workbench |

Phase 1 (2026-10-22): steps 4 and 5 say the agent and providers arrive in 0.2 and can be skipped; step 6 has the theme and says companions arrive in 0.6; step 7 offers New project, Open folder and the start screen (no sample project yet). Jesutobits does not open web pages yet, so the toolchain step shows each install address with a Copy button. The Documents folder comes from the Host (`HostBridge.paths.documents`); without one the user must choose a folder.

Code-OSS fork (2026-10-27, ADR-0015): the table above describes the Tauri app. Jesutobits now greets a new user with a popup over the workbench: VS Code's own onboarding modal (focus trap, progress dots, Escape or the close button skips) with Jesutobits' steps, added by `jesutobits-ide` patch 003. VS Code covers the workspace folder (any folder opens) and toolchain checks, so the steps are:

| Step | Content | Effect |
|---|---|---|
| 1. A little hello | "You bring the idea. We'll find the way.", Buddy, and Just getting started / Finding my feet / I know my way around | `jesutobits.experience` |
| 2. Make it yours | The six Studio themes (Cosy & dark, Light & airy) as cards with a preview in each theme's colours | `workbench.colorTheme`, applied at once |
| 3. Meet your co-builder | Add my OpenRouter key (VS Code's password box, through `jesutobits.setApiKey`), Choose a model (`jesutobits.chooseModel`), and Cautious / Balanced / Autonomous | The key goes to SecretStorage and the popup only learns whether one is stored (`jesutobits.hasApiKey`); `jesutobits.agent.defaultPolicyPreset` |
| 4. Your first idea | Idea chips and a text box; "Enter my workspace" | The text waits in the agent's message box (`jesutobits.compose`); nothing is sent |

**Jesutobits: Get Started** shows the popup again; in plain VS Code, where the extension is developed, it opens the walkthrough instead. When the agent cannot start because no model or no valid key is set, the panel's message offers the fix: Open settings (on `jesutobits.providers.openrouter.defaultModel`) or Add my key.

After onboarding, a dismissible "First steps" checklist appears in the agent panel: ask the agent something, open the preview, try Inspect mode, review a diff.

## 4. Layout

### 4.1 Regions

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ Title bar: project name · trust badge · layout preset switcher · Stop button  │
├──────────────┬──────────────────────────────────────┬─────────────────────────┤
│ LEFT DOCK    │ CENTER DOCK (tabbed)                 │ RIGHT DOCK              │
│ Explorer     │ Editor tabs | Preview | Diff views   │ Agent: Chat | Timeline  │
│ Git          │                                      │ Inspector (Design)      │
│ Search       │                                      │ Companion (header)      │
├──────────────┴──────────────────────────────────────┴─────────────────────────┤
│ BOTTOM DOCK: Terminal | Problems | Preview logs | Output                        │
├───────────────────────────────────────────────────────────────────────────────┤
│ Status bar: runtime · agent state · model · cost · preview status · branch      │
└───────────────────────────────────────────────────────────────────────────────┘
```

### 4.2 Docking model

- Four dock zones: left, center, right, bottom. Each zone holds one or more panels as tabs.
- Panels move between zones by dragging their tab or with "Move to…" in the panel menu. Free-floating panel windows are not in the MVP.
- Zones resize with splitters (keyboard-resizable: focus the splitter, arrow keys). Minimum widths: left 180 px, right 300 px, center 360 px. Bottom minimum height 120 px.
- Any zone can be collapsed (`Ctrl+B` left, `Ctrl+Alt+B` right, `Ctrl+J` bottom). Collapsed zones keep a slim icon rail.
- The center dock always exists. The preview can also be "popped" into the right dock to sit beside the editor.

### 4.3 Layout presets

| Preset | Arrangement | Default for |
|---|---|---|
| **Build** | Agent (left, wide) · Preview (center) · Explorer collapsed · Bottom collapsed until errors | New projects from templates |
| **Code** | Explorer (left) · Editor (center) · Agent (right) · Terminal (bottom) | Opened existing projects |
| **Design** | Agent (left, narrow) · Preview (center, large) · Inspector (right) | Activated automatically when entering Inspect mode, if the user allows |
| **Focus** | Center only (editor or preview), Agent as a slide-over (`Ctrl+L`) | Manual |

Presets are switched from the title bar or with `Alt+1` to `Alt+4`. (Phase 1 opens every project with Code and has no named presets yet; see ROADMAP.md Phase 1 notes.) User modifications are saved as "Custom (based on Code)" and can be saved as a named preset (FR-071). Layout presets can also be contributed by Stage 1 extensions.

### 4.4 Persistence and project switching

- Layout, open tabs, cursor positions, panel sizes and active session are saved per project in `ui-state.json` (FR-008).
- Switching projects (title bar menu or `Ctrl+R`) restores that project's layout. Running previews of the previous project stop unless pinned; terminals of the previous project close after confirmation if they have running processes.
- "Reset layout" in the View menu restores the preset.

### 4.5 Companion placement

Default: agent panel header, small. Other placements: status bar, or floating within the corners of the agent panel or preview gutter (COMPANION_SYSTEM.md section 6). The companion never overlaps editor text, the preview iframe, dialogs, approval cards or the chat composer (FR-133).

## 5. Explorer, editor, Git, terminal, problems

### 5.1 Explorer

- Lazy tree (NFR-019), ignored files dimmed, `node_modules` collapsed and not expanded by search unless asked.
- Context menu: New file, New folder, Rename, Delete (to OS trash), Copy path, Reveal in OS, Open in terminal, **Attach to agent message**. (Phase 1 has all but Open in terminal and Attach to agent message, which arrive with the terminal and the agent; it adds Copy relative path. Keys: arrows, Home, End, Enter opens, F2 renames, Delete asks before trashing, Shift+F10 or the Menu key opens the menu.)
- Agent-changed files show a small dot until viewed; files changed by commands show a different marker.

### 5.2 Editor (Monaco) responsibilities and limits

Monaco provides editing, highlighting, find/replace, multi-cursor, folding and diff views (ADR-0004). Jesutobits builds around it:

- **Tabs** with dirty state; Save (`Ctrl+S`), Save all; preview tabs (single-click opens a temporary tab).
- **External changes:** when the agent or a command changes an open file, an unmodified tab updates in place and highlights changed lines for 5 seconds; a modified tab shows a bar "This file changed on disk" with Compare and Keep mine / Take theirs.
- **Deleted files:** a file moved to the trash from the explorer updates its tab at once; a file deleted elsewhere does once the runtime confirms it is gone (a delete followed by a new file, as atomic saves do, changes nothing). A tab without unsaved changes closes; a tab with them stays with the bar "This file was deleted on disk. Saving creates it again."
- **Unsaved changes on close:** closing a tab, the project or the window with unsaved changes asks Save (all) / Don't save / Cancel.
- **Agent diffs:** "Review changes" opens a multi-file diff view for a turn with per-file Revert.
- **Limitations stated in UI:** in-editor TypeScript hints are approximate in large projects; the Problems panel (from real checks) is authoritative.
- Large files over 5 MB open read-only with a warning; binary files show a metadata view. Until `fs.readFile` can page, files over 2 MB (`MAX_EDITOR_FILE_BYTES`) are not opened at all and the editor says so (`fs.too_large`): one message must stay under the 4 MiB relay limit after JSON escaping (ADR-0003).

### 5.3 Search and quick open

- Quick open (`Ctrl+P`): fuzzy file names, recently opened first.
- Project search (`Ctrl+Shift+F`): ripgrep-backed through the runtime, with include/exclude globs, regex, case toggles; results stream in.

### 5.4 Terminal

- xterm.js tabs bound to Host PTYs (FR-075). Default shell from settings (PowerShell on Windows).
- New terminals start at the project root. Each tab title shows the running command when the shell reports it.
- "Send selection / last 200 lines to agent" attaches the text to the next agent message, labelled as terminal output.
- In Restricted projects a banner reminds the user the project is untrusted.

### 5.5 Git panel (minimal)

Branch name and ahead/behind; changed files grouped staged/unstaged/untracked; click for diff; stage/unstage per file; commit message box and Commit button; "Ask agent to write a commit message". Push and pull are not in the MVP panel; the terminal is the way to do them.

### 5.6 Problems and output

- Problems: diagnostics from the latest checks (typecheck, lint, test, build), grouped by file, with "Ask agent to fix" per problem or for all.
- Preview logs and Output (runtime messages) are separate tabs.

## 6. Agent panel and activity timeline

### 6.1 Chat

- Composer with attachments: files (drag from explorer), selected preview element (chip), terminal excerpt, image (if the model supports vision).
- Mode toggle: **Agent** (tools) and **Ask** (no tools, answers only). Model picker shows the current model, its price and whether it supports tools.
- `Ctrl+Enter` sends (configurable to Enter). `Ctrl+.` stops. **Pause** (in the turn header) lets the current tool finish, then holds the turn until Resume; the companion shows `paused`.
- Messages render sanitised Markdown with code blocks (copy, insert into file via agent). Remote images are blocked with a load prompt (SECURITY.md section 8).
- Sessions list (dropdown): new, rename, archive, export.

Phase 2 (2026-10-26): the agent panel has the session picker with New session, the Agent/Ask switch, the session's model and cost, a Chat tab (user messages, the agent's Markdown, tool rows, approval and question cards inline, the plan, the turn summary) and a Timeline tab with All, Changes and Errors filters. Pause and Resume sit with the live turn's state. The model picker and the API key form are in onboarding step 5 and Settings > Models & providers; agent limits and the default policy are in Settings > Agent & limits, the project's preset in Settings > This project. `Ctrl+.` stops, `Ctrl+L` focuses the composer. File attachments, image attachments, renaming and exporting sessions from the panel, and the dismissible "First steps" checklist arrive later.

Code-OSS fork, Studio design (2026-10-27): the agent panel's tabs are Build (the chat), Activity (the timeline) and Learn. Learn is the Learning Centre: four short lessons (Meet your project, Your first component, Make it feel like you, Build with your co-builder), each with an example and a quick check; a right answer completes the lesson (remembered in the panel's UI state). "Open … in my project" opens the matching file of the open folder (`package.json`, `src/App.tsx`, `src/index.css`) and says so plainly when it does not exist; "Ask my co-builder about this" puts a question in the message box. The palette button in the header opens the theme picker: the six Studio themes (VS Code's `workbench.colorTheme`) and a remix of the current one (accent, canvas, surfaces, text) written to `workbench.colorCustomizations` under that theme only, with a contrast check and Reset to Lavender dusk. Only the workspace changes, never the project.

### 6.2 Plan checklist

Shown at the top of the active turn when the agent calls `update_plan`. Items show pending, in progress, done, skipped. A caption says "Plan written by the agent".

### 6.3 Timeline

The timeline is the truth view. Each row is one runtime activity:

| Activity state shown | Source | Row example |
|---|---|---|
| Understanding request | First `model.request_started` of the turn | "Understanding your request" |
| Planning | `update_plan` tool | "Updated plan: 4 steps" |
| Reading files | Tools with category `reading` | "Read src/App.tsx (180 lines)" |
| Editing files | Category `editing` | "Edited src/lib/date.ts (+12 −3)" |
| Running commands | Category `running` or `git` | "Ran npm run build · exit 0 · 8.2 s" |
| Installing dependencies | Category `installing` | "Installed date-fns · 3.1 s" |
| Starting preview | `start_preview`, `preview.status_changed` | "Preview ready at 127.0.0.1:5173" |
| Testing | Category `testing`, `check.*` | "Tests: 2 failed, 41 passed" |
| Waiting for approval | `permission.requested` | Approval card inline |
| Waiting for your answer | `question.asked` | Question card inline |
| Encountering an error | `tool.failed`, `turn.failed`, `model.error` | Red row with excerpt and "Show details" |
| Compacting history | `turn.state_changed → compacting` | "Summarised earlier conversation to save space" |
| Completed | `turn.completed` | Turn summary card with verification label |

Row anatomy: icon, one-line summary, status (running spinner only while the runtime reports the activity in progress), duration, expand chevron. Expanded: inputs (redacted), output (paged), diff, raw events (developer mode). Filters: All, Changes, Commands, Errors. The timeline virtualises rows (NFR-003).

### 6.4 Approval cards

```
┌ Approval needed · Runs code · Uses the network ───────────────────────────┐
│ npm install date-fns                                                       │
│ in C:\Users\ada\Jesutobits Projects\habits                                       │
│ Packages can run install scripts.  [ ] Install without running scripts     │
│                                                                            │
│ Agent's explanation: "Need a date library for the weekly view."           │
│                                                                            │
│ [Allow once] [Allow for this session ▾ rule: npm install date-fns] [Deny ▾]│
└────────────────────────────────────────────────────────────────────────────┘
```

- Focus lands on the card body, not on Allow. Enter does nothing until a button is focused (prevents accidental approval).
- Risk labels use words ("Runs code", "Uses the network", "Deletes files", "Changes Git history") plus colour.
- When the window is not focused, an OS notification appears (`host.notify`).

### 6.5 Turn summary

The harness-generated summary (AGENT_HARNESS.md section 7.4) with buttons: Review changes, Revert turn, Run remaining checks, Open preview. The verification label is a badge: **Verified**, **Partially verified**, **Unverified**, **Failing**, **No checks configured**.

### 6.6 Status bar

Runtime status (Ready, Restarting…), agent state text (mirrors the companion), active model, session cost, preview status, Git branch, trust badge, policy preset. Clicking each opens the relevant panel or setting.

## 7. Preview and visual editing workflows

### 7.1 Preview toolbar

`[● Ready 127.0.0.1:5173] [path: /dashboard] [↻] [Viewport ▾] [Inspect ⌖] [Drafts: 2 ▾] [Logs] [Open in browser] [■ Stop]`

States: Not started (with Start button and detected strategy), Starting (elapsed time), Ready, Crashed (last error lines + Restart + Ask agent to fix), Stopped.

### 7.2 Inspect and ask the agent (J-09)

1. Click Inspect (or `Ctrl+Shift+C`). Banner appears; border changes colour.
2. Hover highlights with a label `button · Hero · Hero.tsx:24`.
3. Click selects. Selection card shows tag, component chain, source, instance count, and actions: **Ask agent**, **Open in editor**, **Edit properties**, **Select parent**.
4. Ask agent adds the element chip to the composer. The user types and sends.

### 7.3 Edit properties (J-10)

```
Inspector ─ button · Hero.tsx:24 · 1 instance
  Content     Text: [Sign up              ]
  Size        W [auto ▾]   H [40 px ▾]
  Spacing     Padding [8][16][8][16] px   Margin [0]
  Colour      Background [■ indigo-600 ▾]  Text [■ white ▾]
  Typography  Size [14 px ▾]  Weight [600 ▾]  Align [≡ ▾]
  Border      Radius [6 px]  Width [0]  Colour [none]
  Layout      Display [inline-flex ▾]  Gap [8 px]
  Other properties: ask the agent →
  ───────────────────────────────────────────────
  Draft: 2 changes   [Discard]  [Apply to code]
```

- Read-only fields show a lock icon and a one-line reason on hover.
- Draft values apply immediately; the element gets a dashed amber outline and a "Draft" tag.
- Apply to code shows the diff toast with Undo. Undo is disabled with an explanation if the file changed since.
- Esc closes Inspect mode but keeps drafts until reload or discard (the toolbar shows the draft count).

### 7.4 Unsupported projects

The Inspect button stays visible but disabled with a tooltip: "Visual editing works with React + Vite projects. This project uses Next.js. You can still ask the agent about the preview." (FR-120)

## 8. Settings, appearance and extensions

- **Appearance:** theme gallery with live mini-workbench preview, follow-OS toggle, UI scale (90 to 150%), reduce motion, editor font and size (overrides theme), developer-mode token inspector.
- **Companion:** skin gallery with a state stepper, expressiveness, placement, size, reactions, idle behaviours, sounds, announcements (COMPANION_SYSTEM.md section 6).
- **Extensions:** tabs for Themes, Companions, Layouts, Mods (Mods shows "Coming later"); Install from file; Load unpacked (developer mode); each card with status and permissions; detail page with README, versions, permissions, Disable, Uninstall.
- **Permissions:** policy preset per project, list of project rules with Remove, extra workspace roots, Advanced prohibited-action toggles where allowed (SECURITY.md section 4.3).

## 9. Keyboard and command palette

Windows/Linux shown; macOS uses `Cmd` for `Ctrl`.

| Action | Shortcut |
|---|---|
| Command palette | `Ctrl+K` |
| Quick open file | `Ctrl+P` |
| Search in project | `Ctrl+Shift+F` |
| Focus agent composer | `Ctrl+L` |
| Send message | `Ctrl+Enter` |
| Stop agent | `Ctrl+.` |
| Toggle Inspect mode | `Ctrl+Shift+C` |
| Toggle terminal | ``Ctrl+` `` |
| Toggle left / right / bottom dock | `Ctrl+B` / `Ctrl+Alt+B` / `Ctrl+J` |
| Layout presets | `Alt+1` to `Alt+4` |
| Save / Save all | `Ctrl+S` / `Ctrl+Alt+S` |
| Switch project | `Ctrl+R` |
| Review last turn's changes | `Ctrl+Shift+D` |

All shortcuts are listed in the palette next to their commands and can be rebound (keybindings live in `settings.json`).

Phase 1 has the palette (commands that cannot run right now are not listed), quick open, the dock and preset shortcuts, Save and Save all; rebinding arrives with the settings UI. Workbench shortcuts are handled before the editor sees them, so `Ctrl+K` opens the palette even inside Monaco, which gives up its own `Ctrl+K` chords. While a dialog is open, only the dialog handles keys.

## 10. Accessibility (NFR-011)

- **Keyboard:** logical focus order per dock; `F6` cycles docks; tree view uses `role="tree"` with arrow navigation; tabs use `role="tablist"`; splitters are focusable.
- **Screen readers:** every icon button has a label; timeline rows have text summaries; the agent state and important events go to a polite live region (configurable); approval cards are `role="alertdialog"` without stealing focus from text input.
- **Visual:** WCAG 2.2 AA contrast in built-in themes; High Contrast theme; focus ring from `color.focus` token, never removed; UI scale setting; colour never the only signal (icons and words accompany risk and status colours).
- **Motion:** OS reduced motion and the app setting disable non-essential animation, companion motion and preview highlight transitions.
- **Inspect mode:** fully keyboard operable (VISUAL_EDITING.md section 5.2).

## 11. UI copy guidelines

Every visible string lives in `apps/desktop/src/i18n/messages.en.ts` and is read with `t(key, params)` (NFR-020); plurals use `Intl.PluralRules` categories and numbers are formatted for the locale.

- Short, plain sentences. Say what happened, then what the user can do.
- Name real things: "npm install failed (exit 1)", not "Something went wrong".
- Never claim success without evidence: use the verification labels.
- Label model-authored text as the agent's ("Agent's explanation", "Plan written by the agent").
- Avoid blame and jokes in errors. Playfulness belongs to the companion, and only when the user chose it.

## 12. Empty, loading and error states

| Situation | Behaviour |
|---|---|
| No provider configured | Agent panel shows "Connect a model provider to use the agent" with a Settings button; everything else works |
| Runtime starting | Status bar "Starting agent runtime…"; agent composer disabled with a reason |
| Runtime failed | Full-width banner with Restart and Open logs; editor and terminal still usable |
| Empty project | Explorer shows "This folder is empty" and "Ask the agent to set up a project" |
| No preview strategy | Preview panel explains what is missing and offers "Ask agent to add a dev server" |
| Offline | Badge in status bar; agent actions explain the provider cannot be reached (NFR-013) |
