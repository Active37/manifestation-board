ALTER TABLE audit_logs
  ADD COLUMN request_id uuid,
  ADD COLUMN outcome text NOT NULL DEFAULT 'success'
    CHECK (outcome IN ('success', 'failure')),
  ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(metadata) = 'object');

ALTER TABLE audit_logs
  DROP CONSTRAINT audit_logs_action_check,
  ADD CONSTRAINT audit_logs_action_check CHECK (
    action IN (
      'admin_login_succeeded',
      'admin_login_failed',
      'admin_logout',
      'authorization_denied',
      'rate_limit_exceeded',
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
      'post_purged',
      'semester_archived'
    )
  ),
  DROP CONSTRAINT audit_logs_target_type_check,
  ADD CONSTRAINT audit_logs_target_type_check
    CHECK (target_type IN ('post', 'moderator', 'banned_terms', 'categories', 'semester', 'auth')),
  DROP CONSTRAINT audit_logs_check1,
  ADD CONSTRAINT audit_logs_check1 CHECK (
    (target_type IN ('post', 'moderator', 'semester') AND target_id IS NOT NULL)
    OR (target_type IN ('banned_terms', 'categories', 'auth') AND target_id IS NULL)
  );

CREATE INDEX audit_logs_request_id_idx
  ON audit_logs (request_id)
  WHERE request_id IS NOT NULL;
