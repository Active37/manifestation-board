ALTER TABLE post_rate_limits
  DROP CONSTRAINT post_rate_limits_action_type_check,
  ADD CONSTRAINT post_rate_limits_action_type_check
    CHECK (action_type IN ('post', 'like', 'report', 'name')),
  ADD COLUMN violation_count integer NOT NULL DEFAULT 0
    CHECK (violation_count >= 0),
  ADD COLUMN blocked_until timestamptz;

CREATE TABLE used_captcha_tokens (
  token_hash char(64) PRIMARY KEY
    CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX used_captcha_tokens_created_at_idx
  ON used_captcha_tokens (created_at);

ALTER TABLE posts
  ADD CONSTRAINT posts_edit_key_hash_check
    CHECK (edit_key_hash ~ '^[a-f0-9]{64}$') NOT VALID,
  ADD CONSTRAINT posts_display_name_length_check
    CHECK (char_length(display_name) BETWEEN 1 AND 120) NOT VALID,
  ADD CONSTRAINT posts_rejected_at_check
    CHECK (
      (status = 'rejected' AND rejected_at IS NOT NULL)
      OR (status <> 'rejected' AND rejected_at IS NULL)
    ) NOT VALID,
  ADD CONSTRAINT posts_category_fkey
    FOREIGN KEY (category) REFERENCES goal_categories(slug) NOT VALID;

ALTER TABLE reports
  ADD CONSTRAINT reports_detail_length_check
    CHECK (detail IS NULL OR char_length(detail) <= 1000) NOT VALID;

ALTER TABLE admin_sessions
  ADD CONSTRAINT admin_sessions_token_hash_check
    CHECK (token_hash ~ '^[a-f0-9]{64}$') NOT VALID,
  ADD CONSTRAINT admin_sessions_csrf_hash_check
    CHECK (csrf_hash ~ '^[a-f0-9]{64}$') NOT VALID,
  ADD CONSTRAINT admin_sessions_expiry_check
    CHECK (expires_at > created_at) NOT VALID;

ALTER TABLE moderators
  ADD CONSTRAINT moderators_password_hash_check
    CHECK (password_hash ~ '^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$') NOT VALID;
