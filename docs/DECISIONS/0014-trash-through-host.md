# ADR-0014: Deleting to the OS trash through the Host

- **Status:** Accepted
- **Date:** 2026-10-21
- **Related:** ADR-0002, ADR-0003, ADR-0011, FR-072, docs/SECURITY.md section 5.2, docs/ARCHITECTURE.md section 6.3

## Context

The explorer deletes to the OS trash (FR-072, UX_AND_INTERFACE.md section 5.1), so a mistaken delete can be undone outside Jesutobits. All project file access goes through the runtime's `WorkspaceService` (invariant 2), but Node has no trash API:

- Recycle Bin on Windows needs `IFileOperation`/`SHFileOperation` (COM), the macOS Trash needs `NSFileManager`, and Linux needs the freedesktop.org trash specification. A Node binding to any of these is a native addon, which ADR-0002 bans from the runtime.
- Spawning a helper (PowerShell's `Microsoft.VisualBasic.FileIO`, `gio trash`) is slow (PowerShell starts in about a second), differs per OS, and would need ProcessSupervisor, which is Phase 3.

The Host is Rust and already does OS integration.

## Decision

1. **The runtime decides, the Host executes.** `fs.trash` goes to the runtime like every file method. `WorkspaceService.trash` confines the path (SECURITY.md section 5.2), refuses the project folder itself and requires the path to exist. Only then does the runtime send the reverse call `host.fs.trash { path }` with the confined, absolute real path.
2. **Reverse calls are declared like other methods.** Runtime-to-Host methods are defined in `packages/protocol` (`REVERSE_METHODS`) with Zod schemas; `pnpm gen` adds them to `methods.json` and the Rust allowlist, and the Host answers only those. Anything else is refused, as before.
3. **The Host checks again and uses the `trash` crate** (5.x, MIT). It refuses relative paths, paths that do not exist, filesystem roots and the user's home folder, then moves the path to the trash on a blocking thread. The Host trusts the runtime as much as stdio implies (ADR-0003) but does not rely on it for these basic checks.
4. **No permanent delete in the MVP UI.** If the trash fails (for example a network drive without a Recycle Bin), `fs.trash` fails with `fs.trash_failed` and the file stays where it is. Offering "Delete permanently" is a later decision.

## Alternatives considered

| Option | Why not |
|---|---|
| Native Node addon (`trash` npm package's bindings) | Banned in the runtime by ADR-0002; complicates packaging and signing |
| Spawn PowerShell or `gio` from the runtime | About a second per delete, one implementation per OS, and needs ProcessSupervisor (Phase 3) |
| A Host command the Workbench calls directly | Bypasses `WorkspaceService` and its confinement; the Workbench must never touch files (invariant 4) |
| Hand-written `SHFileOperationW` on `windows-sys` | Smaller, but Windows only; Linux CI and later platforms would need their own code |

## Trade-offs

- The `trash` crate brings the `windows` crate on Windows (more compile time, no runtime cost).
- A delete now crosses the process boundary twice (Workbench → runtime → Host). At a few milliseconds per hop this is invisible next to the OS operation itself.

## Consequences

- The relay gains reverse-call support (runtime-to-Host requests with replies). Phase 2's `host.secrets.get` uses the same path.
- The runtime's `RpcServer` can send requests and match replies by ID.
- `WorkspaceService` takes the trash operation as an injected function, so its tests run without a Host.
- **Addendum (2026-10-21, Phase 1 step 15):** "Reveal in OS" (FR-072) uses the same split. `fs.reveal` confines the path in `WorkspaceService.reveal` and requires it to exist; the reverse call `host.os.reveal { path }` makes the Host check it is absolute and exists, then start the file manager (`explorer.exe /select,"<path>"` on Windows, `open -R` on macOS, `xdg-open` on the folder on Linux) without waiting for it. Failures are `fs.reveal_failed`. The dev relay (`scripts/dev-relay.mjs`) stands in for both reverse calls in browser tests: it moves trashed paths into its data folder and records reveals, never touching the OS trash or file manager.

## Revisit when

Users need to permanently delete files the trash refuses, or Node gains a trash API.
