CREATE TABLE admin_sessions (
  token_hash char(64) PRIMARY KEY,
  csrf_hash char(64) NOT NULL,
  moderator_id uuid NOT NULL REFERENCES moderators(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX admin_sessions_moderator_idx ON admin_sessions (moderator_id);
CREATE INDEX admin_sessions_expiry_idx ON admin_sessions (expires_at);

CREATE TABLE admin_login_attempts (
  subject_type text NOT NULL CHECK (subject_type IN ('email', 'ip')),
  subject_hash char(64) NOT NULL,
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  lockout_count integer NOT NULL DEFAULT 0 CHECK (lockout_count >= 0),
  window_started_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  PRIMARY KEY (subject_type, subject_hash)
);
