ALTER TABLE posts
  ADD COLUMN featured_at timestamptz;

CREATE INDEX posts_live_featured_idx
  ON posts (featured_at DESC, id DESC)
  WHERE status = 'live' AND featured_at IS NOT NULL;
