ALTER TABLE post_rate_limits
  ADD COLUMN action_type text NOT NULL DEFAULT 'post';

ALTER TABLE post_rate_limits
  ADD CONSTRAINT post_rate_limits_action_type_check
  CHECK (action_type IN ('post', 'like', 'report'));

ALTER TABLE post_rate_limits
  DROP CONSTRAINT post_rate_limits_pkey;

ALTER TABLE post_rate_limits
  ADD PRIMARY KEY (action_type, subject_type, subject_hash);
