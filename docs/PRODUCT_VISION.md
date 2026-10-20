# Product Vision

> Status: Agreed direction. Product name: **Jesutobits** (see README.md, "Name").

## 1. What Jesutobits is

Jesutobits is a desktop workspace where an AI agent builds and changes real software projects **in front of you**. You can see what the agent is doing, see the running result, point at a part of your app and say "change this", and shape the whole environment with themes, companion skins and mods.

It combines five things that today live in separate tools:

1. A **general agent harness** that can plan, use tools and work through multi-step tasks.
2. A **coding agent** that reads, edits, runs, tests and verifies real projects.
3. An **IDE-like workbench** with explorer, editor, terminal, Git and diagnostics.
4. **Live previews with visual editing** connected to actual source code.
5. A **companion and customisation ecosystem**: themes, companion skins and, later, mods.

The distinctive idea is the combination: a serious coding harness, a visual development surface that is wired to the source, and an extensible personality layer. Every design decision should protect all three.

## 2. The problem

- Terminal-first coding agents are powerful but intimidating. Beginners cannot tell what the agent is doing or whether it worked.
- Chat-based app builders are friendly but shallow. They hide the code, struggle with existing projects, and break down on real engineering work.
- Visual editors are disconnected from code or limited to their own frameworks.
- Developer tools are either rigid or customisable only by people who can write extensions in code.

## 3. Product principles

These are the tie-breakers when two good ideas conflict.

| # | Principle | What it means in practice |
|---|---|---|
| P1 | **Visual-first, not visual-only** | Every visual affordance has a code-level equivalent. Nothing important is only possible by clicking. |
| P2 | **Real engineering** | Jesutobits works on ordinary projects in ordinary folders with ordinary tools (Git, npm, Vite). No proprietary project format. |
| P3 | **Approachable without being patronising** | Beginners get guidance and safe defaults. Experts can turn them off, use shortcuts, and see raw output. |
| P4 | **Radical transparency** | The UI shows what the runtime is actually doing. No fake progress, no hidden actions. If it is not happening, it is not shown as happening. |
| P5 | **Customisable without source changes** | Look, feel and companion are changed through packages, not by editing Jesutobits. |
| P6 | **Extensible with permissions** | Extensions declare what they need. Nothing gets access by default. |
| P7 | **Safe by construction** | The harness enforces permissions. The model can ask; only the user and policy can allow. |
| P8 | **Provider-neutral** | Model providers are adapters. OpenRouter first, others later. |
| P9 | **Clear separation** | The app, the agent runtime, and the user's projects are separate things with explicit boundaries. Jesutobits never silently moves or rewrites a user's project. |
| P10 | **Verified, not claimed** | The agent reports what it checked. "Done" means checks passed, or it says plainly what was not verified. |

## 4. Target users

### U1. Beginner learning to code with AI
- **Wants:** to build something real, understand what happened, not break their computer.
- **Pain today:** terminals, cryptic errors, not knowing if the code works.
- **Jesutobits gives:** guided onboarding, templates, plain-language activity timeline, previews, approvals explained in plain words, easy undo.
- **Risk to manage:** over-trusting the agent. Jesutobits shows verification status honestly and keeps destructive actions behind approval.

### U2. Frontend developer who wants visual inspection and editing
- **Wants:** to click a component in the running app, tweak spacing and colours, and get clean source changes.
- **Pain today:** DevTools changes are lost on reload; design tools don't write their code.
- **Jesutobits gives:** inspect mode, properties inspector bound to source, drafts vs persistent edits, diffs.
- **Risk to manage:** expecting it to work on any stack. Jesutobits states the supported subset up front.

### U3. Experienced developer using autonomous agents
- **Wants:** a capable agent, control over permissions, speed, keyboard flow, real terminals and Git.
- **Pain today:** opaque agents, unsafe defaults, or constant interruptions.
- **Jesutobits gives:** configurable permission policies, session rules, timeline with raw details, terminal, diff review, checkpoints.
- **Risk to manage:** feeling slowed down by "friendly" UI. Layout presets and a focus mode keep chrome out of the way.

### U4. Developer who customises their environment
- **Wants:** to make the tool feel like theirs, and share setups.
- **Jesutobits gives:** themes and companion skins as installable packages; later, sandboxed mods; a local dev workflow for authors.
- **Risk to manage:** a malicious package. Jesutobits validates packages and grants nothing by default.

### U5. User who wants general agent tasks as well as coding
- **Wants:** to ask the agent to draft documents, organise notes, transform data files, research using provided files.
- **Jesutobits gives:** a **General workspace** (a scratch folder) where the same agent works with files and commands under the same permissions.
- **Non-goal:** controlling other desktop apps or the whole operating system.

## 5. Scope boundaries

**In the MVP** (see ROADMAP.md for detail):

- Windows desktop app (architecture ready for macOS and Linux).
- OpenRouter models with tool calling.
- Coding agent with file, search, command, preview, Git (read and commit) and verification tools.
- Workbench: explorer, Monaco editor, terminal, timeline, chat, diagnostics, Git panel (minimal).
- Live preview for any project with a dev script; visual editing for React + Vite projects styled with Tailwind classes or inline styles.
- Companion with real state mapping; built-in skins; static and dotLottie renderers.
- Stage 1 extensions: themes and companion skins installed locally.

**Explicitly not in the MVP:**

- Online marketplace, accounts, cloud sync, telemetry by default.
- Code-executing mods (Stage 2) and tool-integration mods (Stage 3).
- Visual editing for Next.js, Vue, Svelte, React Native/Expo, CSS Modules, CSS-in-JS.
- Controlling other desktop applications or the OS.
- Multi-user collaboration.
- Running agents on remote machines.

## 6. User journeys and acceptance criteria

Journey IDs (J-01 to J-15) are referenced from REQUIREMENTS.md and ROADMAP.md. "Given/When/Then" criteria are written so they can become E2E tests.

### J-01. Opening the application for the first time
1. Jesutobits opens a welcome screen explaining in two sentences what it does and that nothing leaves the computer except calls to the chosen model provider.
2. The user is walked through the onboarding steps (J-02, J-03, theme, companion) and can skip any step except choosing a workspace folder.

Acceptance criteria:
- Given a clean install, when Jesutobits starts, then the onboarding appears within 3 seconds (NFR-001) and no network request is made before the user configures a provider.
- Every onboarding step has Back, Skip (where allowed) and a visible step indicator.
- Quitting mid-onboarding and restarting resumes at the same step.
- Onboarding checks for Git and Node.js and, if missing, shows what is missing, why it matters and a link to install it, without blocking.

### J-02. Configuring an AI model provider
1. The user picks OpenRouter (the only provider in MVP; others shown as "coming later").
2. The user pastes an API key. Jesutobits tests it and lists tool-capable models.
3. The user picks a default model. Jesutobits shows context size and price per million tokens.

Acceptance criteria:
- The key is stored only in the OS credential store; it never appears in settings files, logs, the UI after entry (masked), or model context.
- An invalid key shows "OpenRouter rejected this key (401)". Insufficient credit shows the 402 message in plain words.
- Only models whose capabilities include tool calling are selectable for agent mode.
- The user can skip; the app then works as an editor and preview tool, and the chat panel explains how to add a provider.

### J-03. Choosing a default workspace directory
1. Jesutobits suggests `Documents/Jesutobits Projects` (created only on confirmation).
2. The user may choose any folder.

Acceptance criteria:
- Jesutobits never moves or modifies existing files in the chosen folder.
- The folder is only the default location for **new** projects. Opening projects elsewhere works (J-05).
- Changing it later in Settings affects only future projects.

### J-04. Creating a new project
1. From the start screen, the user picks a template (React + Vite + TypeScript + Tailwind; React + Vite + TypeScript; Empty; General workspace) and a name.
2. Jesutobits creates the folder in the default workspace, writes the template, runs `git init` (optional, on by default) and installs dependencies with approval.

Acceptance criteria:
- Template creation is local (templates ship with Jesutobits); dependency installation is shown as a distinct, approvable step with its network use stated.
- If installation fails (offline, registry error), the project still opens and the failure appears in the timeline with a Retry action.
- Name collisions are detected before anything is written.

### J-05. Opening an existing project
1. The user chooses "Open folder" or a recent project.
2. If the project was not created by Jesutobits, Jesutobits asks whether to **trust** it. Restricted mode allows browsing and editing but disables running commands, dev servers and agent tools that execute code.

Acceptance criteria:
- Opening a folder writes nothing into it.
- The trust decision is remembered per canonical path and can be changed in Settings.
- A recent project whose folder is missing shows "Missing" with Locate and Remove actions.
- Preview strategy and visual-editing support are detected and displayed (for example "Visual editing available: React + Vite + Tailwind").

### J-06. Asking the agent to build a web application
1. The user types a request in the agent panel, for example "Build a habit tracker with a weekly view".
2. The agent proposes a short plan (visible as a checklist), then executes.

Acceptance criteria:
- The first visible runtime activity appears within 2 seconds of sending (a "Understanding request" state backed by a real model request in flight).
- The plan is visible and updates as items complete; plan items are model-declared and labelled as such.
- The agent stays within the project folder. Any attempt to touch other paths is blocked and shown.

### J-07. Watching the agent plan, edit, run and test
Acceptance criteria:
- Every tool call appears in the timeline with a category (reading, editing, running, installing, previewing, testing, waiting, error), a one-line summary, duration and expandable details (inputs, output, diff).
- Edited files show diffs; clicking opens the file at the change.
- The companion and status bar reflect the same runtime state as the timeline, within 250 ms.
- When nothing is executing and no model request is in flight, no "working" indicator is shown.

### J-08. Previewing the generated application
Acceptance criteria:
- The preview panel shows dev server status: Starting, Ready (with URL), Crashed, Stopped.
- Readiness is detected by an HTTP response, not by a fixed delay.
- Server logs are one click away; errors are highlighted.
- If the default port is busy, Jesutobits picks another and says which.
- Edits trigger hot reload; a manual Reload button exists.

### J-09. Selecting an element and asking the agent to modify it
1. The user switches to Inspect mode, clicks the "Sign up" button.
2. A selection card shows: `<button>` in `Hero` (src/components/Hero.tsx:24), 1 instance.
3. The user types "make this more prominent" in the attached prompt box.

Acceptance criteria:
- Inspect mode is visibly different (cursor, outline, banner "Inspecting: clicks select elements"). Esc returns to Interact mode.
- The agent receives the element's source location, component, tag, classes, text snippet and key computed styles, labelled as untrusted page data.
- After the agent's change, the preview reloads and the same element is re-selected if it still exists.

### J-10. Editing supported properties manually
Acceptance criteria:
- The inspector lists properties with one of three states: Editable, Read-only (with reason, for example "className is computed by cn()"), Not supported.
- Changing a value applies a **draft** to the preview immediately, marked "Draft, not saved to code".
- "Apply to code" writes the change to source, shows the diff, triggers HMR, and clears the draft marker.
- "Discard" removes drafts without touching files. "Undo" after apply restores the previous source.
- Invalid values (for example `padding: -4px` or an unparseable colour) are rejected inline.

### J-11. Switching the application's visual skin (theme)
Acceptance criteria:
- Settings > Appearance lists installed themes with previews. Selecting one applies to the whole UI, the editor, and preview chrome within 200 ms without restart.
- A theme that fails validation cannot be selected and shows why.
- Contrast warnings appear for themes below WCAG AA on key text pairs.

### J-12. Installing a companion skin ("companion mod")
1. The user selects "Install from file" and picks a `.jesutobitspkg` file (or a folder in developer mode).
2. Jesutobits validates it and shows name, author, version, size, renderer and permissions ("None").

Acceptance criteria:
- Invalid packages are rejected with specific errors (missing state mapping, oversized asset, external URL in animation, unsupported renderer).
- A companion skin can request no permissions; a package that requests any is rejected.
- The user can preview each companion state before activating.

### J-13. Disabling or removing a mod
Acceptance criteria:
- Disabling takes effect immediately; the UI falls back to the default theme or companion.
- Uninstalling removes the package folder and its private storage after confirmation.
- Jesutobits starts in **Safe mode** (all extensions disabled, built-in theme and companion) when the user chooses Help > Restart in Safe mode, when launched with `--safe-mode`, or automatically after two consecutive crashes during extension load.

### J-14. Reviewing and approving sensitive actions
Acceptance criteria:
- The approval card shows the exact action (full command and working directory, file paths, or diff summary), its risk category, and the model's stated reason labelled "Agent's explanation".
- Options: Allow once, Allow for this session (with the precise rule shown, for example "npm run test in this project"), Deny, Deny and tell the agent why.
- While waiting, the agent is paused; the companion shows "Waiting for you"; nothing related executes.
- Approvals and denials are recorded in the session's audit log.
- Prohibited actions never show an approval card; they are blocked and explained.

### J-15. Recovering from an agent error or failed build
Acceptance criteria:
- A failed command or check appears as an error event with the relevant output excerpt and a link to full logs.
- The agent is allowed a bounded number of fix attempts (default 3 for the same failing check) before stopping and asking the user.
- The user can Revert the turn (restoring files changed by tools), Retry the turn, or continue with instructions.
- If the runtime crashes, it restarts automatically, the interrupted turn is marked "Interrupted", and no file is left half-written (writes are atomic).
- Network or provider errors show the category and next step (retry, check credits, change model).
