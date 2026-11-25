CREATE INDEX admin_login_attempts_window_idx
  ON admin_login_attempts (window_started_at);
