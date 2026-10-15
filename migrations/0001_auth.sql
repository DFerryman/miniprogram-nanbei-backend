-- Email access approvals, one-time codes, and opaque browser sessions.
-- All timestamps are Unix seconds. Only hashes of bearer tokens are stored.
CREATE TABLE auth_users (
  email TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  current_request_hash TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE auth_requests (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL REFERENCES auth_users(email),
  state TEXT NOT NULL CHECK (state IN ('sending', 'pending', 'approved', 'rejected')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  decision_nonce TEXT
);
CREATE INDEX auth_requests_email ON auth_requests(email);
CREATE INDEX auth_requests_expiry ON auth_requests(expires_at);

CREATE TABLE auth_codes (
  email TEXT PRIMARY KEY REFERENCES auth_users(email),
  nonce TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('sending', 'sent', 'consumed', 'locked')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  session_hash TEXT
);

CREATE TABLE auth_sessions (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL REFERENCES auth_users(email),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX auth_sessions_expiry ON auth_sessions(expires_at);

-- Persistent, atomic counters; no per-isolate or eventually consistent limits.
CREATE TABLE auth_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX auth_limits_expiry ON auth_limits(expires_at);

-- One atomic send reservation per purpose/mailbox prevents concurrent resends.
CREATE TABLE auth_dispatch (
  email TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('access', 'otp')),
  last_attempt INTEGER NOT NULL,
  day INTEGER NOT NULL,
  day_count INTEGER NOT NULL,
  active_id TEXT,
  PRIMARY KEY (email, purpose)
);
