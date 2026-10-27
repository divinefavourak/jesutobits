# Changelog

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
