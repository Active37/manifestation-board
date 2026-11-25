import type { PoolClient } from "pg";

export type AuditActorType = "staff" | "anonymous_owner" | "system";
export type AuditAction =
  | "admin_login_succeeded"
  | "admin_login_failed"
  | "admin_logout"
  | "authorization_denied"
  | "rate_limit_exceeded"
  | "post_approved"
  | "post_rejected"
  | "post_restored"
  | "moderation_undone"
  | "moderator_created"
  | "moderator_deactivated"
  | "post_featured"
  | "post_unfeatured"
  | "banned_terms_replaced"
  | "categories_replaced"
  | "post_removed"
  | "post_purged"
  | "semester_archived";
export type AuditTargetType =
  | "post"
  | "moderator"
  | "banned_terms"
  | "categories"
  | "semester"
  | "auth";

type AuditDetails = {
  outcome: "success" | "failure";
  metadata: Record<string, string | number | boolean | null>;
};

export async function recordAuditLog(
  client: PoolClient,
  actorType: AuditActorType,
  actorId: string | null,
  action: AuditAction,
  targetType: AuditTargetType,
  targetId: string | null,
  details?: AuditDetails,
): Promise<void> {
  if (details) {
    await client.query(
      `
        INSERT INTO audit_logs (
          actor_type, actor_id, action, target_type, target_id, request_id,
          outcome, metadata
        )
        VALUES (
          $1, $2, $3, $4, $5,
          nullif(current_setting('app.request_id', true), '')::uuid,
          $6, $7
        )
      `,
      [
        actorType,
        actorId,
        action,
        targetType,
        targetId,
        details.outcome,
        details.metadata,
      ],
    );
    return;
  }

  await client.query(
    `
      INSERT INTO audit_logs (
        actor_type, actor_id, action, target_type, target_id, request_id
      )
      VALUES (
        $1, $2, $3, $4, $5,
        nullif(current_setting('app.request_id', true), '')::uuid
      )
    `,
    [actorType, actorId, action, targetType, targetId],
  );
}
