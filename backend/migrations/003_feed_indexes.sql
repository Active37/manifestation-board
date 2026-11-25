CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX posts_name_key_trgm_idx ON posts USING gin (name_key gin_trgm_ops);
CREATE INDEX likes_created_at_post_id_idx ON likes (created_at DESC, post_id);
