-- The agent harness (Phase 2): sessions, turns, messages, tool calls, permissions, stored
-- events, checkpoints and the model cache (DATA_AND_PERSISTENCE.md section 4).
-- Never edit this file after merge; add a new migration instead.

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,                 -- ses_...
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
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
CREATE INDEX sessions_project ON sessions (project_id, updated_at DESC);

CREATE TABLE turns (
  id TEXT PRIMARY KEY,                 -- trn_...
  session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('agent', 'ask')),
  model_id TEXT NOT NULL,
  retry_of TEXT,                       -- the failed or interrupted turn this one continues
  state TEXT NOT NULL,                 -- final or last known state; 'interrupted' after a crash
  started_at TEXT NOT NULL,
  ended_at TEXT,
  end_reason TEXT,
  error_json TEXT,                     -- JesutobitsError of a failed turn, redacted
  verification_label TEXT,             -- verified | partially_verified | unverified | failing | no_checks
  summary_json TEXT,
  prompt_version TEXT NOT NULL,
  cost_usd REAL NOT NULL DEFAULT 0
);
CREATE INDEX turns_session ON turns (session_id, started_at);

-- What the model sees: normalised ChatMessages (AGENT_HARNESS.md section 2.1), redacted.
CREATE TABLE messages (
  id TEXT PRIMARY KEY,                 -- msg_...
  session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  turn_id TEXT REFERENCES turns (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'summary')),
  content_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX messages_session_seq ON messages (session_id, seq);

CREATE TABLE tool_calls (
  id TEXT PRIMARY KEY,                 -- call_...
  turn_id TEXT NOT NULL REFERENCES turns (id) ON DELETE CASCADE,
  tool TEXT NOT NULL,
  input_json TEXT NOT NULL,            -- redacted
  risk_json TEXT NOT NULL,
  decision TEXT NOT NULL,              -- allow | ask_allowed | ask_denied | deny | prohibited | invalid
  permission_id TEXT,
  started_at TEXT,
  ended_at TEXT,
  ok INTEGER,
  error_code TEXT,
  result_preview TEXT
);
CREATE INDEX tool_calls_turn ON tool_calls (turn_id);

-- Written before the tool runs (SECURITY.md section 4.5).
CREATE TABLE permission_requests (
  id TEXT PRIMARY KEY,                 -- perm_...
  turn_id TEXT NOT NULL REFERENCES turns (id) ON DELETE CASCADE,
  call_id TEXT NOT NULL,
  action_json TEXT NOT NULL,
  risk_json TEXT NOT NULL,
  decision TEXT,                       -- null while pending; allow_* | deny | withdrawn
  scope TEXT,                          -- once | session | project
  rule_id TEXT,
  user_message TEXT,
  requested_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX permission_requests_turn ON permission_requests (turn_id);

CREATE TABLE permission_rules (
  id TEXT PRIMARY KEY,                 -- rule_...
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions (id) ON DELETE CASCADE, -- null for project scope
  scope TEXT NOT NULL CHECK (scope IN ('session', 'project')),
  tool TEXT NOT NULL,
  match_json TEXT NOT NULL,            -- paths, or argv prefix and cwd (Phase 3)
  script_fingerprint TEXT,             -- for package-manager scripts (Phase 3)
  description TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX permission_rules_project ON permission_rules (project_id);

-- A session's events as sent, redacted; text deltas are not stored.
CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  turn_id TEXT,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  ts TEXT NOT NULL
);
CREATE INDEX events_session ON events (session_id, id);
CREATE INDEX events_turn ON events (turn_id);

-- Pre-images of files the agent changed (ADR-0012). Contents are blobs in checkpoints/,
-- named by SHA-256 and written before the row.
CREATE TABLE checkpoints (
  id TEXT PRIMARY KEY,                 -- ckp_...
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,              -- turn id or visual edit id (vedit_...)
  kind TEXT NOT NULL CHECK (kind IN ('tool', 'visual', 'command_detected')),
  path TEXT NOT NULL,                  -- project-relative, '/' separated
  before_hash TEXT,                    -- null = did not exist
  after_hash TEXT,                     -- null = removed
  created_at TEXT NOT NULL,
  UNIQUE (owner_id, path)
);
CREATE INDEX checkpoints_project ON checkpoints (project_id);

CREATE TABLE model_cache (
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  info_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (provider_id, model_id)
);
