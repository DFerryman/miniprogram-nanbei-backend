-- Multi-editor coordination metadata. Content itself stays in the WeChat cloud
-- database; nothing here is written in the same transaction as content, so
-- these tables are hints and safety nets, never the source of truth.

-- One row per browser tab. A tab belongs to a login session; logging out or
-- session expiry removes it from every query through the join on auth_sessions.
CREATE TABLE collab_presence (
  tab_id TEXT PRIMARY KEY,
  session_hash TEXT NOT NULL,
  email TEXT NOT NULL,
  -- 'list' | 'portfolio' | 'series' | 'studio' | 'setup'
  view_kind TEXT NOT NULL,
  view_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('viewing', 'editing', 'unsaved')),
  visible INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  seen_at INTEGER NOT NULL
);
CREATE INDEX collab_presence_seen ON collab_presence(seen_at);
CREATE INDEX collab_presence_session ON collab_presence(session_hash);

-- Append-only feed of successful admin writes, polled by open pages so they can
-- notice that what they show (or are editing) is out of date.
CREATE TABLE collab_changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  item_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete')),
  rev INTEGER,
  email TEXT NOT NULL,
  tab_id TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX collab_changes_at ON collab_changes(at);

-- Deferred storage deletion. A file is only removed from cloud storage after a
-- grace period, after being claimed ('deleting') and after a full scan proves
-- that no document references it any more. Saving a document that references a
-- 'pending' file takes it back out of this table.
CREATE TABLE file_trash (
  file_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('pending', 'deleting')),
  reason TEXT NOT NULL,
  email TEXT,
  queued_at INTEGER NOT NULL,
  due_at INTEGER NOT NULL,
  claimed_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX file_trash_due ON file_trash(state, due_at);
