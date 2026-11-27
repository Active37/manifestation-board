CREATE TABLE used_captcha_tokens (
  token_hash text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT used_captcha_tokens_hash_check CHECK (token_hash ~ '^[a-f0-9]{64}$')
);

CREATE INDEX used_captcha_tokens_created_at_idx
  ON used_captcha_tokens (created_at);