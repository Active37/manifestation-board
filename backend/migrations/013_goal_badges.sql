CREATE TABLE post_badges (
  post_id uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  badge_type text NOT NULL CHECK (badge_type IN ('goal_achieved')),
  awarded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, badge_type)
);
