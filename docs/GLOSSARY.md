# Glossary, naming and decision labels

Reference material for contributors, moved here from the README.

## Decision status legend

Every document distinguishes:

- **Confirmed / Accepted**: agreed; build on it.
- **Provisional**: agreed default tied to a named spike or revisit trigger (for example ADR-0009 depends on Spike S2).
- **Proposed / Later**: designed so current work does not block it; not in the MVP.
- **Open question**: listed in [ROADMAP section 4](ROADMAP.md#4-unresolved-questions) with a recommended default.
- **Verified fact**: has an `RN-xx` entry with a source in [Research notes](RESEARCH_NOTES.md). Anything without one is a recommendation.

## Glossary

| Term | Meaning |
|---|---|
| **Host** | The Jesutobits VS Code extension: supervises the runtime, credentials (SecretStorage), reverse calls, the webview relay |
| **Workbench** | VS Code's window. Older docs use the word for the hand-built Tauri UI (archived at tag `tauri-final`) |
| **Agent panel** | The React UI in a VS Code webview: chat, timeline, approvals |
| **Runtime** | The separate Node process running the agent harness and services |
| **Services** | File, process, preview and visual-edit services inside the runtime process |
| **Session** | A conversation with the agent in one project, persisted |
| **Turn** | One user message and all the agent work it triggers |
| **Step** | One model response within a turn (plus the tool calls it requested) |
| **Risk class / Policy preset / Rule** | How the permission broker classifies and decides tool calls (SECURITY.md section 4) |
| **Checkpoint** | Pre-image of a file before an agent or visual edit, used for revert |
| **Evidence** | A recorded check result (typecheck, test, build, preview) used to label work Verified |
| **Preview strategy** | How a project is previewed: `vite-react` (visual editing), `generic` (dev or start script), `static` (an `index.html` site), `command` (a saved start command) |
| **Bridge** | The script injected into the preview to support inspection and drafts |
| **Draft / Apply** | Preview-only change vs persistent source change in visual editing |
| **Theme / Companion skin / Mod** | The three extension categories |
| **Stage 1 / 2 / 3** | Declarative, sandboxed UI, and integration extensions |
| **Restricted mode** | How untrusted projects open: no command execution |
| **Safe mode** | Jesutobits running with all extensions disabled |
| **General workspace** | A scratch folder for non-coding agent tasks |

## Name and identifiers

The product is called **Jesutobits**. The logo is [`assets/jesutobits-logo.svg`](assets/jesutobits-logo.svg), the box-drawing banner from AGENTS.md drawn as plain shapes by `scripts/gen-logo.mjs`, so it lines up in every Markdown preview and switches colours in dark mode. Edit the banner in the script and rerun it, never the SVG. A second mark, [`assets/jesutobits-wordmark.svg`](assets/jesutobits-wordmark.svg), has its text converted to outlines (from Space Grotesk, SIL Open Font Licence). The app icons for every platform come from `scripts/gen-app-icons.mjs`.

The name also appears in identifiers. These are the ones to keep stable once people use the app:

| Kind | Examples | Hard to change after 1.0? |
|---|---|---|
| Display text | "Jesutobits", window titles, docs | No |
| Package names and binaries | `@jesutobits/*`, `jesutobits` | No |
| VS Code identifiers | extension `jesutobits.jesutobits`, settings `jesutobits.*`, commands `jesutobits.*` | Partly (settings live in users' settings.json) |
| Environment variables | `JESUTOBITS_*` | No |
| App identifier and data paths | `dev.jesutobits.app` (macOS bundle), `dev.jesutobits.Jesutobits` (Linux), `.jesutobits` data folders | **Yes** |
| Files in user projects and packages | `.jesutobits/`, `.jesutobitsignore`, `.jesutobitspkg`, `jesutobits-extension.json` | **Yes** |
| Protocols and DOM attributes | `jesutobits://`, `data-jesutobits-loc`, `data-jesutobits-comp` | Partly (extensions may rely on them) |

The app identifier is reverse-DNS, so it should use a domain you control. Confirm it before 1.0 (ROADMAP open question Q1), because it decides where user data is stored.
