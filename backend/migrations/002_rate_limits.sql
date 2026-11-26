CREATE TABLE post_rate_limits (
  action_type text NOT NULL,
  subject_type text NOT NULL,
  subject_hash text NOT NULL,
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL DEFAULT 0,
  CONSTRAINT post_rate_limits_pkey
    PRIMARY KEY (action_type, subject_type, subject_hash),
  CONSTRAINT post_rate_limits_action_type_check
    CHECK (action_type IN ('post', 'like')),
  CONSTRAINT post_rate_limits_subject_type_check
    CHECK (subject_type IN ('device', 'ip')),
  CONSTRAINT post_rate_limits_subject_hash_check
    CHECK (subject_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT post_rate_limits_request_count_check
    CHECK (request_count >= 0)
);

CREATE INDEX post_rate_limits_window_started_at_idx
  ON post_rate_limits (window_started_at);