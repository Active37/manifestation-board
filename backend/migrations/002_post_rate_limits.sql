CREATE UNIQUE INDEX semesters_one_open_idx ON semesters (state)
  WHERE state = 'open';

CREATE TABLE post_rate_limits (
  subject_type text NOT NULL CHECK (subject_type IN ('device', 'ip')),
  subject_hash text NOT NULL,
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count > 0),
  PRIMARY KEY (subject_type, subject_hash)
);
