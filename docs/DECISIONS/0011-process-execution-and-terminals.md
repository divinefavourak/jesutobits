# ADR-0011: Process execution and terminals

- **Status:** Accepted
- **Date:** 2026-10-19
- **Related:** ADR-0002, RN-03, RN-16, docs/SECURITY.md section 5

## Context

Jesutobits runs three kinds of processes for user projects:

1. **Agent commands**: `npm install`, `npm run build`, `git status`, test runners. Need captured output, timeouts, cancellation, permission checks.
2. **Long-running managed processes**: dev servers for previews, watch-mode tests.
3. **Interactive terminals** for the user: a real shell with a PTY.

Processes must not outlive Jesutobits, including after a crash. Windows has specific spawning rules (RN-16) and no process groups in the POSIX sense.

## Decision

### Who owns what

| Kind | Owner | Mechanism |
|---|---|---|
| Agent commands | Runtime `ProcessSupervisor` | `child_process.spawn` with pipes, no PTY |
| Managed long-running processes | Runtime `ProcessSupervisor` | Same, with restart policy and log ring buffer |
| Interactive terminals | **Host**, Rust `portable-pty` crate (ConPTY on Windows) | Bytes stream to xterm.js in the Workbench over a Tauri Channel |

The agent cannot type into user terminals. The user can explicitly share a terminal's recent output with the agent ("Send last 200 lines to agent").

### Spawning rules (runtime)

- Commands are given as `argv` arrays. `shell: false` by default.
- Windows `.cmd`/`.bat` shims (`npm`, `pnpm`, `npx`) are resolved and run through a vetted cross-platform spawner (`cross-spawn` semantics with explicit `cmd.exe` argument escaping), because Node refuses to spawn them without a shell (RN-16).
- A command that needs shell features (pipes, redirects, `&&`, globbing) must set `shell: true` in the tool call. That always requires approval (SECURITY.md section 5).
- `cwd` must resolve inside the project root.
- Environment: start from an allowlist (`PATH`, `HOME`/`USERPROFILE`, `TEMP`, `TMP`, `LANG`, `SystemRoot`, `ComSpec`, `PATHEXT`, `APPDATA`, `LOCALAPPDATA`), then add project-declared variables. Variables that change how child runtimes load code (`NODE_OPTIONS`, `LD_PRELOAD`, `DYLD_*`) are dropped even if the user's shell has them. **Provider credentials are never in the environment.**
- Timeouts: default 120 s for commands, none for managed processes. On timeout: graceful stop, then hard kill after 5 s. On cancel: graceful stop, then hard kill after 1.5 s, so a cancel stops within AGENTS.md's 2 s.

### Process tree cleanup

- **Windows:** the Host creates a Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` and assigns the runtime process to it **before** sending `initialize`. Children inherit job membership, so every descendant dies when the Host's job handle closes, including on Host crash. Within the runtime, killing a single command's tree uses `taskkill /T /F /PID`.
- **macOS/Linux:** each command and managed process is spawned with `detached: true` so it leads its own process group; the supervisor kills the group (`process.kill(-pgid, signal)`).
- **Crash recovery (all platforms):** the supervisor records `{pid, pgid, startTime, command}` for each managed process in SQLite. On runtime start it reaps entries still alive whose start time matches (to avoid PID reuse), then clears the table.

### System toolchain

User projects run with the **user's installed Node and package manager**, not Jesutobits' bundled Node. Onboarding detects them and guides installation if missing (FR-010). Reason: projects need a predictable toolchain the user also uses outside Jesutobits, and the bundled Node version follows Jesutobits' release schedule, not the project's.

## Alternatives considered

| Option | Why not |
|---|---|
| `node-pty` in the runtime | Native addon, conflicts with ADR-0002. Viable if we later accept native addons. |
| Agent commands through a PTY | Output contains terminal control codes and prompts; harder to parse and to time out cleanly. |
| Everything in the Host (Rust) | Moves process logic away from the TypeScript tool layer and duplicates validation. |
| Bundled Node for user projects | Easier first run, but version mismatches with users' other tools and unclear upgrade path. Recorded as an open question for beginners (ROADMAP.md). |

## Consequences

- Spike S1 must prove job-object assignment and descendant cleanup on Windows, including when the Host is killed from Task Manager. **Proven (2026-10-20, `docs/spikes/S1.md`):** 0 orphans in 10 forced kills (`TerminateProcess`, as Task Manager's End task does) with a runtime that ignores stdin EOF and holds a grandchild; with the job object disabled, every trial left both behind. `cargo test` covers job-close cleanup of a process tree on every Windows CI run.
- The Host gains a small PTY module with its own allowlisted commands (`pty.open`, `pty.write`, `pty.resize`, `pty.close`).

- Phase 1 (2026-10-21) built the spawning core in `packages/services/src/process/` ahead of the full ProcessSupervisor, because onboarding's toolchain check (FR-010) needs it: the environment allowlist, PATH/PATHEXT resolution, `runCommand` (argv, no shell, output caps, timeouts, `AbortSignal` cancellation within 2 s, tree kill) and `detectToolchain`. Only fixed commands Jesutobits chooses use it until Phase 3 adds approvals, the orphan ledger and managed processes on top. Two findings:
  - **Shim arguments are escaped twice for cmd.exe, for every `.cmd`/`.bat`.** cross-spawn escapes twice only for `node_modules/.bin` shims, but npm.cmd and pnpm.cmd also forward `%*`, which cmd.exe parses a second time inside the batch file. Escaped once, an argument containing `"` flips cmd's quote state and a later argument's `&` runs a command: verified by creating a file through `["quote\"inside", "a&echo injected>file&rem "]`. `process.test.ts` keeps that case.
  - On Windows, libuv copies a few system variables a child cannot run without (SystemRoot, USERNAME, WINDIR and similar) even into an allowlisted environment. None carries secrets; `NODE_OPTIONS` and credentials stay out.
- 2026-10-21, first Linux CI run: this ADR said "on timeout or cancel, hard kill after 5 s", which contradicts AGENTS.md's "stop within 2 s" for cancellation. Windows hid it (`taskkill /F` is a hard kill from the start); on Linux a child ignoring SIGTERM took 5.0 s to cancel. Cancel now escalates after 1.5 s; timeouts keep 5 s, since nobody is waiting on them.

## Revisit when

Orphaned processes are observed in practice, or we adopt OS-level sandboxing for agent commands (which may change who spawns them).
