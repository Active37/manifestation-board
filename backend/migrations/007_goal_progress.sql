ALTER TABLE posts
  ADD COLUMN progress_status text NOT NULL DEFAULT 'not_started'
  CHECK (progress_status IN ('not_started', 'in_progress', 'achieved'));

CREATE INDEX posts_live_achieved_idx
  ON posts (created_at DESC, id DESC)
  WHERE status = 'live' AND progress_status = 'achieved';
