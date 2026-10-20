-- Recent projects, trust and per-project settings (DATA_AND_PERSISTENCE.md sections 3 and 4).
-- Never edit this file after merge; add a new migration instead.

CREATE TABLE projects (
  id TEXT PRIMARY KEY,                 -- prj_...
  canonical_path TEXT NOT NULL UNIQUE, -- real path; drive letter lower-cased on Windows
  display_name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('project', 'general')),
  created_by_jesutobits INTEGER NOT NULL DEFAULT 0,
  trust TEXT NOT NULL CHECK (trust IN ('trusted', 'restricted', 'unknown')),
  policy_preset TEXT NOT NULL DEFAULT 'balanced',
  extra_roots_json TEXT NOT NULL DEFAULT '[]',
  preview_settings_json TEXT,
  check_profile_json TEXT,
  last_opened_at TEXT,
  missing INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX projects_last_opened ON projects (last_opened_at DESC);
