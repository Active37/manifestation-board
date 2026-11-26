CREATE TABLE check_ins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid NOT NULL UNIQUE REFERENCES posts(id) ON DELETE CASCADE,
  email text NOT NULL,
  consented_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  unsubscribed_at timestamptz,
  CONSTRAINT check_ins_email_length_check
    CHECK (char_length(email) BETWEEN 3 AND 320),
  CONSTRAINT check_ins_email_trimmed_check
    CHECK (email = btrim(email))
);

CREATE INDEX check_ins_pending_send_idx
  ON check_ins (consented_at, id)
  WHERE sent_at IS NULL AND unsubscribed_at IS NULL;