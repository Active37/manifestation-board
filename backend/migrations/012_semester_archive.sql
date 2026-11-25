CREATE INDEX semesters_closed_ends_on_idx
  ON semesters (ends_on DESC, name ASC, id ASC)
  WHERE state = 'closed';

ALTER TABLE audit_logs
  DROP CONSTRAINT audit_logs_action_check,
  ADD CONSTRAINT audit_logs_action_check CHECK (
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
      'post_purged',
      'semester_archived'
    )
  ),
  DROP CONSTRAINT audit_logs_target_type_check,
  ADD CONSTRAINT audit_logs_target_type_check CHECK (
    target_type IN ('post', 'moderator', 'banned_terms', 'categories', 'semester')
  ),
  DROP CONSTRAINT audit_logs_check1,
  ADD CONSTRAINT audit_logs_check1 CHECK (
    (target_type IN ('post', 'moderator', 'semester') AND target_id IS NOT NULL)
    OR (target_type IN ('banned_terms', 'categories') AND target_id IS NULL)
  );
