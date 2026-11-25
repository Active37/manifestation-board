CREATE TABLE goal_categories (
  slug text PRIMARY KEY
    CHECK (char_length(slug) <= 40 AND slug ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'),
  active boolean NOT NULL DEFAULT true
);

INSERT INTO goal_categories (slug) VALUES
  ('academic'),
  ('career'),
  ('spiritual'),
  ('money'),
  ('fun-random');
