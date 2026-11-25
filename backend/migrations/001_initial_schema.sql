CREATE TABLE semesters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  ends_on date NOT NULL,
  state text NOT NULL CHECK (state IN ('open', 'closed'))
);

CREATE TABLE posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text NOT NULL,
  name_key text NOT NULL,
  body text NOT NULL CHECK (char_length(body) <= 300),
  category text,
  status text NOT NULL CHECK (status IN ('live', 'held', 'hidden', 'rejected', 'removed')),
  edit_key_hash text NOT NULL,
  like_count integer NOT NULL DEFAULT 0 CHECK (like_count >= 0),
  report_count integer NOT NULL DEFAULT 0 CHECK (report_count >= 0),
  semester_id uuid NOT NULL REFERENCES semesters(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  rejected_at timestamptz
);

CREATE UNIQUE INDEX posts_name_key_uq ON posts (name_key);
CREATE INDEX posts_live_created_at_idx ON posts (created_at DESC, id DESC)
  WHERE status = 'live';
CREATE INDEX posts_live_like_count_idx ON posts (like_count DESC, created_at DESC)
  WHERE status = 'live';

CREATE TABLE likes (
  post_id uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  device_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, device_id)
);

CREATE TABLE reports (
  post_id uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  device_id text NOT NULL,
  reason text NOT NULL CHECK (reason IN ('offensive', 'sexual', 'harassment', 'spam', 'other')),
  detail text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, device_id)
);

CREATE TABLE moderators (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'moderator')),
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE banned_terms (
  term text NOT NULL,
  type text NOT NULL,
  PRIMARY KEY (term, type)
);
