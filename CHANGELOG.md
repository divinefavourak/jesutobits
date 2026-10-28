# Changelog

## 0.3.0 (2026-10-28): Jesutobits on VS Code, for Windows, Linux and macOS

Jesutobits is now a desktop app built on VS Code (Code-OSS, ADR-0015) instead of its own Tauri shell, so the editor, terminal, Git and extensions are VS Code's. Packages for Windows x64, Linux x64 (`.deb`, `.rpm`, `.tar.gz`) and macOS (Apple Silicon and Intel), unsigned.

- **Get started in a minute.** A welcome popup in the Studio design: say where you are starting from, pick one of six themes, connect OpenRouter and choose how much the agent checks with you, then write your first idea.
- **Sign in with OpenRouter.** No key to copy: allow Jesutobits on openrouter.ai and the key it makes goes straight into your system's credential store. Or paste a key you have. **Use the free model** (Laguna S 2.1 by Poolside, made for coding) says plainly that its maker may learn from your prompts and only then allows that.
- **Your account.** Your picture or initial in the top-right corner, with a green dot while OpenRouter is connected. It opens your profile (name and picture, kept on this computer), your OpenRouter plan, spend, limit and free-model requests left today, your model and privacy choice, and how much the agent asks.
- **The agent runs commands and your app.** Install, test, type-check and build with your approval, and start the preview itself.
- **A preview for every kind of project.** React + Vite projects get visual editing; anything with a `dev` or `start` script runs it; plain HTML/CSS/JS sites and canvas games are served with live reload; anything else (Python, Go, Rust...) runs the start command you or the agent give, saved for the project. A program without a web page shows its live output.
- **Visual editing.** Click an element in the preview to inspect it, change its Tailwind classes or inline styles (written into your source), or ask the agent about it.
- **The Studio.** The agent on the right, the preview in the middle with a greeting above it, a Studio section with New project, Recent projects and the Learning Centre, and Get Started, New Project and Themes in the top bar. Change the Look remixes any theme's colours.
- **A companion** that shows what the agent is really doing (thinking, reading, editing, done), in three skins or none.
- **Fixed:** a reasoning model that spent its whole reply thinking ended the turn with nothing done; its thinking is now capped and an empty reply never ends a turn. The message box showed two focus outlines. A Vite 5 preview never showed its page because Vite prints its address in colour.

## 0.2.0 (2026-10-26): the agent

Phase 2 of the roadmap (docs/ROADMAP.md section 3). Windows, unsigned.

- An agent panel in every project: send a request and watch the agent work. It reads files, searches the project and changes files through tools; every step shows in the chat and the timeline, and the status bar says what it is doing.
- Agent and Ask modes, sessions kept per project, the session's model and cost.
- Approvals: changes that need your consent show the exact action, the risks in words and the diff; Enter never approves. Deleting files and reading files that may hold secrets always ask; "Share with values hidden" lets the agent see a secrets file's keys without its values. Files outside the project, credentials and Jesutobits' own data are never touched.
- Every change the agent makes is kept, so Revert turn restores the files byte for byte. A turn that changed files is labelled Unverified until checks arrive in 0.3.
- Stop (Ctrl+.) ends a turn within 2 seconds; Pause and Resume; limits on steps, time and cost ask before going on; the agent stops and asks when it repeats itself.
- OpenRouter: your API key goes to the Windows Credential Manager and is never shown again; Test connection; a model picker with prices, context sizes and which models can use tools. Prompts are only sent to providers that do not keep them, unless you change that.
- Project search (Ctrl+Shift+F) with the bundled ripgrep.
- A turn that was running when Jesutobits stopped is marked Interrupted and can be retried.

## 0.1.0 (2026-10-22): desktop shell

Phase 1 of the roadmap (docs/ROADMAP.md section 3). Windows, unsigned.

- First-run onboarding: workspace folder, toolchain check, theme. Provider steps are placeholders until 0.2.
- Start screen: recent projects with Locate and Remove, New project (Empty, General workspace), Open folder, and the trust prompt for folders Jesutobits did not create.
- Dock layout with the Build, Code, Design and Focus presets, kept per project.
- File explorer with create, rename, move to trash, copy path and Reveal in file manager; changes made elsewhere appear at once.
- Monaco editor: tabs, save with conflict detection, the "changed on disk" bar with Compare, deleted files shown at once, unsaved-changes prompts.
- Quick open (Ctrl+P), command palette (Ctrl+K), settings (Ctrl+,): workspace, appearance, project trust.
- Light, Dark and High Contrast themes, following the OS by default.
- The agent runtime restarts by itself after a crash and the project reopens; nothing keeps running after the app closes.
