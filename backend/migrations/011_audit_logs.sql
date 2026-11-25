CREATE TABLE audit_logs (
  id bigserial PRIMARY KEY,
  actor_type text NOT NULL CHECK (
    actor_type IN ('staff', 'anonymous_owner', 'system')
  ),
  actor_id uuid REFERENCES moderators(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (
    action IN (
      'post_approved',
      'post_rejected',
      'post_restored',
      'moderation_undone',
      'moderator_created',
      'moderator_deactivated',
      'post_featured',
      'post_unfeatured',
      'banned_terms_replaced',
      'categories_replaced',
      'post_removed',
      'post_purged'
    )
  ),
  target_type text NOT NULL CHECK (
    target_type IN ('post', 'moderator', 'banned_terms', 'categories')
  ),
  target_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (actor_type = 'staff' AND actor_id IS NOT NULL)
    OR (actor_type IN ('anonymous_owner', 'system') AND actor_id IS NULL)
  ),
  CHECK (
    (target_type IN ('post', 'moderator') AND target_id IS NOT NULL)
    OR (target_type IN ('banned_terms', 'categories') AND target_id IS NULL)
  )
);

CREATE INDEX audit_logs_actor_created_idx
  ON audit_logs (actor_id, created_at DESC);
CREATE INDEX audit_logs_target_created_idx
  ON audit_logs (target_type, target_id, created_at DESC);

CREATE FUNCTION reject_audit_log_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit logs are append-only';
END;
$$;

CREATE TRIGGER audit_logs_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION reject_audit_log_mutation();

CREATE TRIGGER audit_logs_no_truncate
  BEFORE TRUNCATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_log_mutation();
