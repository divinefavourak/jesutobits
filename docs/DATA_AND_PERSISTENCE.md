# Data, State and Persistence

> Status: Agreed design (ADR-0008, provisional on `node:sqlite`).

## 1. Principles

1. **Local only.** No remote backend, no accounts, no sync in the MVP.
2. **Jesutobits' data is never stored inside user projects** unless the user explicitly saves something there.
3. **One writer per store** (Host for settings and secrets, runtime for the database and checkpoints).
4. **Versioned and recoverable.** Every store has a schema version, forward migrations and backups.
5. **Secrets only in the OS credential store.**

## 2. Where things live

Paths come from Tauri's path API. Examples use the proposed bundle identifier `dev.jesutobits.app` (ROADMAP open question Q1).

| Directory (Tauri name) | Windows example | Contents |
|---|---|---|
| App config dir | `%APPDATA%\dev.jesutobits.app\` | `settings.json`, `ui-state.json`, backups of both |
| App local data dir | `%LOCALAPPDATA%\dev.jesutobits.app\` | `jesutobits.db` (+ WAL), `checkpoints/`, `extensions/`, `backups/`, `cache/` (model list, Playwright browser if downloaded) |
| App log dir | `%LOCALAPPDATA%\dev.jesutobits.app\logs\` | `host.jsonl`, `runtime.jsonl`, `workbench.jsonl` and rotations |
| OS credential store | Windows Credential Manager | Entries with service `dev.jesutobits.app`, account `provider:openrouter:default` etc. |
| App resources (read-only) | Install directory | Runtime bundle, Node sidecar, ripgrep sidecar, preview launcher, Vite plugin bundle, bridge, built-in themes and skins, templates |

Large and machine-specific data (database, checkpoints) goes in the **local** data dir, not the roaming one.

### 2.1 What belongs where

| Data | Store | Why |
|---|---|---|
| Application settings (appearance, companion, defaults, privacy) | `settings.json` | Needed before the runtime starts; small; human-inspectable |
| Window and layout state, open tabs, onboarding progress | `ui-state.json` | High churn UI state, kept apart from settings |
| Recent projects, trust, per-project policy and preview settings | SQLite `projects` | Queried and updated by the runtime |
| Agent sessions, messages, turns | SQLite | Relational, transactional, large |
| Activity events (turn level) and tool calls | SQLite | Timeline history, audit |
| Permission decisions and rules | SQLite | Audit and policy evaluation |
| Verification evidence | SQLite | Ledger queries |
| Checkpoint index | SQLite; contents in `checkpoints/` blobs | Large binary-ish content outside the DB |
| Installed extensions | Folders in `extensions/` + `extensions/registry.json` | Host installs and serves files |
| Extension configuration (active theme, active skin) | `settings.json` | Read at startup |
| Extension private storage (Stage 2, later) | `extension-storage/<id>.json` | Isolated per extension |
| Provider API keys, Stage 3 extension secrets | OS credential store | OS protection |
| Model capability cache | SQLite `model_cache` | Refreshable |
| Logs | JSONL files | Rotated |
| Project-shareable config (only if the user saves it) | `<project>/.jesutobits/project.json` | Team members can share preview and check settings |

## 3. Project identity

- `projects.canonical_path` is the real path after resolving symlinks, normalised separators, and lower-cased drive letter on Windows. It is unique.
- Each project also gets a stable `prj_` ID used everywhere else, so moving a folder only requires updating one row ("Locate" action, FR-004).
- If a folder is missing at startup, the project row is kept and marked `missing`.

## 4. SQLite schema (initial)

`jesutobits.db`, WAL mode, `foreign_keys=ON`, `busy_timeout=5000`. JSON columns are validated by Zod on read and write.

```sql
CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,                 -- prj_...
  canonical_path TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('project','general')),
  created_by_jesutobits INTEGER NOT NULL DEFAULT 0,
  trust TEXT NOT NULL CHECK (trust IN ('trusted','restricted','unknown')),
  policy_preset TEXT NOT NULL DEFAULT 'balanced',
  extra_roots_json TEXT NOT NULL DEFAULT '[]',
  preview_settings_json TEXT,
  check_profile_json TEXT,
  last_opened_at TEXT,
  missing INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,                 -- ses_...
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE turns (
  id TEXT PRIMARY KEY,                 -- trn_...
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  state TEXT NOT NULL,                 -- final or last known state; 'interrupted' after crash
  started_at TEXT NOT NULL,
  ended_at TEXT,
  end_reason TEXT,
  verification_label TEXT,             -- verified | partially_verified | unverified | failing | no_checks
  summary_json TEXT,
  prompt_version TEXT NOT NULL,
  cost_usd REAL NOT NULL DEFAULT 0
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id TEXT REFERENCES turns(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user','assistant','tool','summary')),
  content_json TEXT NOT NULL,          -- normalised ChatMessage, redacted
  created_at TEXT NOT NULL
);
CREATE INDEX messages_session_seq ON messages(session_id, seq);

CREATE TABLE tool_calls (
  id TEXT PRIMARY KEY,                 -- call_...
  turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  tool TEXT NOT NULL,
  input_json TEXT NOT NULL,            -- redacted
  risk_json TEXT NOT NULL,
  decision TEXT NOT NULL,              -- allow | ask_allowed | ask_denied | deny | prohibited
  permission_id TEXT,
  started_at TEXT, ended_at TEXT,
  ok INTEGER, error_code TEXT,
  result_preview TEXT
);

CREATE TABLE permission_requests (
  id TEXT PRIMARY KEY,                 -- perm_...
  turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  call_id TEXT NOT NULL,
  action_json TEXT NOT NULL,
  risk_json TEXT NOT NULL,
  decision TEXT,                       -- null while pending
  scope TEXT,                          -- once | session | project
  rule_id TEXT,
  user_message TEXT,
  requested_at TEXT NOT NULL,
  decided_at TEXT
);

CREATE TABLE permission_rules (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE, -- null for project scope
  scope TEXT NOT NULL CHECK (scope IN ('session','project')),
  tool TEXT NOT NULL,
  match_json TEXT NOT NULL,            -- argv prefix, cwd
  script_fingerprint TEXT,             -- for package-manager scripts
  created_at TEXT NOT NULL
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  session_id TEXT, turn_id TEXT,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,          -- redacted; text deltas are not stored individually
  ts TEXT NOT NULL
);
CREATE INDEX events_turn ON events(turn_id);

CREATE TABLE checkpoints (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,              -- turn id or visual edit id (vedit_...)
  kind TEXT NOT NULL CHECK (kind IN ('tool','visual','command_detected')),
  path TEXT NOT NULL,                  -- project-relative
  before_hash TEXT,                    -- null = did not exist; blob in checkpoints/
  after_hash TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE evidence (
  id TEXT PRIMARY KEY,                 -- chk_...
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  turn_id TEXT,
  kind TEXT NOT NULL,
  command_json TEXT,
  started_counter INTEGER NOT NULL,
  finished_at TEXT NOT NULL,
  outcome TEXT NOT NULL,
  summary TEXT NOT NULL,
  diagnostics_json TEXT
);

CREATE TABLE managed_processes (       -- orphan ledger (ADR-0011)
  id TEXT PRIMARY KEY,                 -- proc_...
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,                  -- command | background | preview
  argv_json TEXT NOT NULL,
  pid INTEGER NOT NULL, pgid INTEGER,
  start_time TEXT NOT NULL,            -- OS process start time, guards against PID reuse
  status TEXT NOT NULL
);

CREATE TABLE model_cache (
  provider_id TEXT NOT NULL, model_id TEXT NOT NULL,
  info_json TEXT NOT NULL, fetched_at TEXT NOT NULL,
  PRIMARY KEY (provider_id, model_id)
);
```

Write patterns: text deltas are streamed to the UI but persisted only as the final assistant message per step. Tool, permission, check and state-change events are persisted as they happen, in short transactions. Bursts (for example many `tool.output_delta` events) are grouped into one transaction per flush rather than one per event: Spike S1 measured about 0.2 ms per single-row commit with WAL and `synchronous=NORMAL`, so 10,000 autocommitted rows took 2.1 to 2.5 s, against 0.2 to 0.9 s in transactions (`docs/spikes/S1.md`).

## 5. Settings files

`settings.json` (Host-owned, validated by serde in Rust and by Zod in the Workbench):

```json
{
  "schemaVersion": 1,
  "workspace": { "defaultFolder": "C:\\Users\\ada\\Documents\\Jesutobits Projects" },
  "providers": {
    "openrouter": { "enabled": true, "profile": "default", "defaultModel": "provider/model-id", "options": { "provider": { "data_collection": "deny" } } }
  },
  "agent": {
    "defaultPolicyPreset": "balanced",
    "limits": { "stepsPerTurn": 40, "toolCallsPerTurn": 150, "turnMinutes": 30, "costPerTurnUsd": 1.0, "costPerSessionUsd": 5.0, "fixAttempts": 3 }
  },
  "appearance": { "theme": "builtin.jesutobits-themes/dark", "followOsTheme": true, "reduceMotion": false, "uiScale": 1.0 },
  "companion": { "enabled": true, "skin": "builtin.jesutobits-companions/ember", "expressiveness": "standard", "placement": "agent-header", "size": "small", "reactions": true, "idleBehaviours": false, "sounds": { "enabled": false, "volume": 0.5 }, "announcements": "important" },
  "preview": { "defaultViewport": "desktop", "pinRunningPreviews": false, "verificationBrowser": "auto" },
  "terminal": { "shell": "auto" },
  "privacy": { "logModelTraffic": false, "providerAttributionHeaders": false },
  "developer": { "extensionDeveloperMode": false },
  "advanced": { "allowGitPushWithApproval": false, "allowPublishWithApproval": false }
}
```

No field in either file may contain a secret. A unit test scans the settings schema for field names like `key`, `token`, `secret` and fails unless the field is on an explicit allowlist (for example `profile`).

Implementation (Phase 1): the Host's `settings_store/` and the Zod schema `packages/protocol/src/settings.ts` define the sections in use so far (`workspace`, `appearance`, `terminal`, `privacy`, `developer`); later phases add theirs with defaults, which needs no version bump. `workspace.defaultFolder` is `null` until onboarding asks. Sections the Host does not know (from a newer version) are kept when it writes. Both sides run `fixtures/settings/cases.json`, and a Rust test compares the serde defaults with `packages/protocol/generated/settings.defaults.json`, generated from the Zod schema. Nothing is written until the first change. A settings file with a higher `schemaVersion` is read leniently and never written (`storage.settings_newer` notice), so a downgrade cannot destroy it.

`ui-state.json` holds window bounds, per-project layout (keyed by `prj_` ID), open tabs and cursor positions, collapsed panels, onboarding step, last safe-mode marker.

Keys in use: `window` (Host), `layouts` (`{ [prj_ID]: Layout }`, `apps/desktop/src/features/layout/layout-model.ts`: preset, modified flag, and per dock zone its panels, active tab, collapsed flag and size). The Workbench validates what it reads and falls back to the preset; it writes a layout 250 ms after the last change, and at once when the project closes.

## 6. Migration and recovery

### 6.1 SQLite

- `PRAGMA user_version` mirrors the latest applied migration.
- On runtime start: if migrations are pending, first `VACUUM INTO backups/jesutobits-v<old>-<timestamp>.db` (keep the last 3), then apply migrations in one transaction.
- On migration failure: roll back, keep running read-only with a banner "Jesutobits could not upgrade its database" offering "Restore backup" and "Start fresh (keeps the old file aside)".
- **Newer database than the app** (downgrade): open read-only and offer to restore the latest compatible backup.
- **Unclean shutdown** (marker file present at start): run `PRAGMA quick_check`. On failure, move `jesutobits.db` aside as `jesutobits.corrupt-<timestamp>.db`, start with a new database, and tell the user that sessions from the old file can be exported with a recovery tool later.

Implementation (`packages/runtime/src/storage/storage.ts`, Phase 1):

- The unclean-shutdown marker is `jesutobits.db.open`, written when the database opens and removed by a clean `runtime.shutdown` or stdin EOF. A file that cannot be opened at all (for example plain text) is moved aside the same way, even after a clean shutdown.
- The runtime opens the database right **after** the `runtime.initialize` reply is flushed, so a backup or migration never delays the handshake (NFR-002). Problems are sent as `runtime.warning` events with the codes `storage.corrupt_recovered`, `storage.migration_failed` and `storage.newer_database`; a database that cannot be opened at all is a `runtime.error` with `storage.unavailable`.
- Migrations are `.sql` files inlined into the bundle as text, each with a `.d.sql.ts` that types the import. A test pins every merged file's SHA-256, so an edited migration fails CI. `schema_migrations` is created by the runner, not by a migration.
- Without `--data-dir` (some tests) the database lives in memory.

### 6.2 Settings

- `schemaVersion` is migrated by the Host on load; the previous file is kept as `settings.json.bak-v<old>`.
- Invalid JSON: rename to `settings.json.corrupt-<timestamp>`, load defaults, show a notice. Same for `ui-state.json` (without a notice). Valid JSON that fails validation counts as invalid. An unusable `window` entry in `ui-state.json` is dropped on its own, keeping the rest.
- Window bounds are saved 500 ms after the window stops moving or resizing, and on close. A saved position that no longer shows at least 100 px on any screen (an unplugged monitor) is ignored. The window starts hidden and is shown after restoring, so it never visibly jumps.
- Writes are atomic (temp file, then rename).

### 6.3 Checkpoint store

- Blobs are named by SHA-256 of content and written before the index row (so the index never points to a missing blob).
- A startup sweep removes blobs not referenced by any row (after migrations) and rows whose blob is missing (logged).

### 6.4 Extensions

- `registry.json` is versioned. Missing or invalid registry: rebuilt by scanning `extensions/*/*/jesutobits-extension.json`, all non-built-in extensions disabled, notice shown.

## 7. Export, deletion and privacy

- **Export session** (FR-170): Markdown (readable transcript with tool summaries and diffs) or JSON (full structured data). Both redacted.
- **Delete session**: removes rows and checkpoint blobs no longer referenced.
- **Clear history / Clear logs / Reset Jesutobits** (FR-171): Reset deletes the config and local data directories and Jesutobits' credential-store entries after a typed confirmation. **It never touches project folders.**
- No telemetry by default (NFR-015). Diagnostic bundles are created locally on request.

## 8. What Jesutobits may write into a project

| File | When | Contents | Rules |
|---|---|---|---|
| `.jesutobits/project.json` | Only when the user clicks "Save to project" in project settings | Preview command and port, check commands, visual-editing exclusions | **Cannot** contain trust, permission rules or policy. A repository must never be able to grant itself permissions |
| `.jesutobits/instructions.md` | Only when the user creates it | Free-form agent instructions | Treated as project instructions (labelled) |
| `.jesutobitsignore` | Only when the user creates it | Ignore globs for agent search and context | |
| `AGENTS.md` | Only on explicit user request | Standard agent instructions (RN-33) | Jesutobits reads it if present |

Everything else Jesutobits writes into a project is a user edit, an approved agent change, or a template for a new project.

## 9. Retention defaults

| Data | Default retention |
|---|---|
| Sessions and messages | Until the user deletes or archives and clears |
| Turn events | With their session |
| Checkpoint blobs | Until the session is deleted, or 30 days after the session's last activity (configurable) |
| Logs | 10 files × 10 MB per component |
| Database backups | Last 3 |
| Model cache | 24 hours |
