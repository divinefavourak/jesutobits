# ADR-0008: Local persistence

- **Status:** Accepted (provisional)
- **Date:** 2026-10-19
- **Related:** RN-10, RN-13, docs/DATA_AND_PERSISTENCE.md

## Context

Jesutobits stores settings, recent projects, sessions, conversation history, activity events, permission decisions, extension state and checkpoints. There is no remote backend. Settings are needed before the runtime starts (theme, layout). Sessions and events are written at high frequency during agent turns. Credentials need OS-level protection.

## Decision

| Data | Store | Single writer |
|---|---|---|
| App settings, UI layout state | JSON files in the app config dir, validated by Zod (TS) and serde (Rust), versioned with migrations | Host |
| Provider credentials, extension-requested secrets (Stage 3) | OS credential store via the Rust `keyring` crate (Windows Credential Manager, macOS Keychain, Secret Service) | Host |
| Sessions, messages, activity events, tool calls, approvals, permission rules, projects registry, model cache, checkpoint index | SQLite file `jesutobits.db` in the app data dir, WAL mode, opened with **`node:sqlite`** | Runtime |
| Checkpoint file contents | Content-addressed blobs in `checkpoints/` | Runtime |
| Installed extensions | Folders under `extensions/<id>/<version>/` | Host (install), Workbench reads |
| Logs | Rotating JSONL files in the app log dir | Host and Runtime, separate files |
| Project-specific config the user chooses to share | Optional `.jesutobits/project.json` in the project | Runtime, only after explicit user action |

Rules:

- One writer per store. Other components read through the owner's API.
- The runtime accesses SQLite only through a `Database` interface in `packages/runtime/src/storage/`, so `node:sqlite` can be swapped for `better-sqlite3` without touching callers.
- Minimum bundled Node version honours the known `node:sqlite` defects (RN-13).

## Alternatives considered

| Option | Assessment |
|---|---|
| `tauri-plugin-sql` (SQLite in Rust) for everything | Puts the high-frequency writer (runtime) behind an extra IPC hop. |
| `better-sqlite3` | Mature and fast, but a native addon (conflicts with ADR-0002's no-native-addon rule). Kept as fallback. |
| JSON files for sessions | Simple, but no transactions, poor querying, risk of corruption on crash. |
| Stronghold for secrets | Encrypted vault, but needs its own password or key management; the OS store is what users expect and gives OS-level access control. |
| IndexedDB in the webview | Ties data to one webview profile, unreachable from the runtime. |

## Trade-offs

- `node:sqlite` is a release candidate (RN-13). The `Database` interface and an integration test suite against both backends limit the risk.
- On Linux, the Secret Service may be missing (headless or minimal desktops). Fallback: ask the user to enter the key per session (kept in memory only), with a clear message. Jesutobits never silently writes a plaintext key.

## Consequences

- Schema migrations for SQLite live in `packages/runtime/src/storage/migrations/NNNN_name.sql` and run at runtime start inside a transaction, after a file-level backup.
- Settings JSON carries `"schemaVersion"`. The Host migrates on load and keeps `settings.json.bak-<version>`.

- Phase 1 (2026-10-20) implemented the `Database` interface (`storage/database.ts`) and its `node:sqlite` backend (`storage/node-sqlite.ts`), the migration runner with backups and recovery (DATA_AND_PERSISTENCE.md section 6.1), and the first migration (`projects`). The Host now passes the **local** app data dir (`%LOCALAPPDATA%`) as `--data-dir`; Spike S1 had passed the roaming one.

## Revisit when

`node:sqlite` causes a data-loss bug, or we need cross-device sync (which would require a different design and an explicit privacy decision).
