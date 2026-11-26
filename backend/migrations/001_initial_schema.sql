CREATE TABLE semesters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  ends_on date NOT NULL,
  state text NOT NULL,
  CONSTRAINT semesters_name_not_empty CHECK (char_length(btrim(name)) > 0),
  CONSTRAINT semesters_state_check CHECK (state IN ('open', 'closed'))
);

CREATE UNIQUE INDEX semesters_one_open_idx
  ON semesters (state)
  WHERE state = 'open';

CREATE TABLE moderators (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  CONSTRAINT moderators_email_uq UNIQUE (email),
  CONSTRAINT moderators_role_check CHECK (role IN ('admin', 'moderator'))
);

CREATE TABLE banned_terms (
  term text NOT NULL,
  type text NOT NULL,
  CONSTRAINT banned_terms_pkey PRIMARY KEY (term, type),
  CONSTRAINT banned_terms_term_not_empty CHECK (char_length(btrim(term)) > 0),
  CONSTRAINT banned_terms_type_not_empty CHECK (char_length(btrim(type)) > 0)
);

CREATE TABLE posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text NOT NULL,
  name_key text NOT NULL,
  body text NOT NULL,
  category text,
  status text NOT NULL DEFAULT 'live',
  edit_key_hash text NOT NULL,
  like_count integer NOT NULL DEFAULT 0,
  report_count integer NOT NULL DEFAULT 0,
  semester_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  rejected_at timestamptz,
  CONSTRAINT posts_name_key_uq UNIQUE (name_key),
  CONSTRAINT posts_name_key_normalized_check CHECK (
    char_length(btrim(name_key)) > 0 AND name_key = lower(name_key)
  ),
  CONSTRAINT posts_display_name_not_empty CHECK (
    char_length(btrim(display_name)) > 0
  ),
  CONSTRAINT posts_body_length_check CHECK (
    char_length(btrim(body)) BETWEEN 1 AND 300
  ),
  CONSTRAINT posts_category_check CHECK (
    category IS NULL OR category IN ('academic', 'career', 'spiritual', 'money', 'fun/random')
  ),
  CONSTRAINT posts_status_check CHECK (
    status IN ('live', 'held', 'hidden', 'rejected', 'removed')
  ),
  CONSTRAINT posts_edit_key_hash_check CHECK (
    edit_key_hash ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT posts_like_count_check CHECK (like_count >= 0),
  CONSTRAINT posts_report_count_check CHECK (report_count >= 0),
  CONSTRAINT posts_semester_id_fkey FOREIGN KEY (semester_id)
    REFERENCES semesters(id) ON DELETE RESTRICT,
  CONSTRAINT posts_rejected_at_check CHECK (
    (status = 'rejected') = (rejected_at IS NOT NULL)
  )
);

CREATE INDEX posts_live_created_at_idx
  ON posts (created_at DESC, id DESC)
  WHERE status = 'live';

CREATE INDEX posts_live_like_count_idx
  ON posts (like_count DESC, created_at DESC, id DESC)
  WHERE status = 'live';

CREATE INDEX posts_status_created_at_idx
  ON posts (status, created_at, id);

CREATE TABLE likes (
  post_id uuid NOT NULL,
  device_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT likes_pkey PRIMARY KEY (post_id, device_id),
  CONSTRAINT likes_post_id_fkey FOREIGN KEY (post_id)
    REFERENCES posts(id) ON DELETE CASCADE
);

CREATE INDEX likes_created_at_post_id_idx
  ON likes (created_at, post_id);

CREATE TABLE reports (
  post_id uuid NOT NULL,
  device_id text NOT NULL,
  reason text NOT NULL,
  detail text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reports_pkey PRIMARY KEY (post_id, device_id),
  CONSTRAINT reports_post_id_fkey FOREIGN KEY (post_id)
    REFERENCES posts(id) ON DELETE CASCADE,
  CONSTRAINT reports_reason_check CHECK (
    reason IN ('offensive', 'sexual', 'harassment', 'spam', 'other')
  )
);