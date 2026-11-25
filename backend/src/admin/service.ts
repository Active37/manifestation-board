import {
  createHash,
  createHmac,
  randomBytes,
} from "node:crypto";
import type { Pool, PoolClient } from "pg";
import bcrypt from "bcryptjs";
import type { AppConfig } from "../config.js";
import { recordAuditLog, type AuditAction } from "../audit.js";
import { httpError } from "../errors.js";
import { setDatabaseRequestId } from "../request-context.js";
import type {
  AdminAnalytics,
  AdminApi,
  AdminRole,
  AdminSession,
  BannedTerm,
  ModerationPost,
  Moderator,
} from "./types.js";

type AnalyticsRow = {
  posts: string;
  likes: string;
  reports: string;
  achievedGoals: string;
  live: string;
  held: string;
  hidden: string;
  rejected: string;
  removed: string;
};

const passwordRounds = 12;
const defaultLoginPolicy = {
  failureLimit: 5,
  windowMs: 15 * 60 * 1000,
  initialLockoutMs: 15 * 60 * 1000,
  maxLockoutMs: 24 * 60 * 60 * 1000,
};

type LoginPolicy = typeof defaultLoginPolicy;

type LoginSubject = {
  type: "email" | "ip";
  hash: string;
};

type LoginAttempt = {
  failed_attempts: number;
  lockout_count: number;
  window_started_at: Date;
  locked_until: Date | null;
};

type ModeratorRow = Moderator & { password_hash: string };

type LoginAttemptUpdate = {
  failures: number;
  lockoutCount: number;
  windowExpired: boolean;
  lockedUntil: Date | null;
};

type ModerationAction = "approve" | "reject" | "restore";
type ModerationStatus = "held" | "live" | "rejected";
const moderationAuditActions: Record<ModerationAction, AuditAction> = {
  approve: "post_approved",
  reject: "post_rejected",
  restore: "post_restored",
};

type LockedPost = {
  id: string;
  status: string;
  rejected_at: Date | null;
};

type StoredModerationAction = {
  id: string;
  from_status: ModerationStatus;
  to_status: ModerationStatus;
  from_rejected_at: Date | null;
  to_rejected_at: Date | null;
};

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function analyticsCount(value: string): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("Analytics query returned an invalid count");
  }
  return count;
}

function hashSubject(
  secret: string,
  type: LoginSubject["type"],
  value: string,
): string {
  return createHmac("sha256", secret).update(`${type}:${value}`).digest("hex");
}

export function normalizeAdminEmail(email: string): string {
  return email.normalize("NFKC").trim().toLowerCase();
}

export function nextModerationStatus(
  action: ModerationAction,
  status: string,
): ModerationStatus {
  if (action === "approve" && status === "held") {
    return "live";
  }
  if (action === "reject" && status === "held") {
    return "rejected";
  }
  if (action === "restore" && status === "rejected") {
    return "held";
  }
  throw httpError(409, "Post status does not allow this action");
}

function sameDate(left: Date | null, right: Date | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return left.getTime() === right.getTime();
}

function isUniqueEmailError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505" &&
    "constraint" in error &&
    error.constraint === "moderators_email_key"
  );
}

export function nextLoginAttempt(
  attempt: LoginAttempt,
  now: number,
  policy: LoginPolicy = defaultLoginPolicy,
): LoginAttemptUpdate | null {
  if (attempt.locked_until && attempt.locked_until.getTime() > now) {
    return null;
  }
  const windowExpired =
    now - attempt.window_started_at.getTime() >= policy.windowMs;
  let failures = (windowExpired ? 0 : attempt.failed_attempts) + 1;
  let lockoutCount = attempt.lockout_count;
  let lockedUntil: Date | null = null;
  if (failures >= policy.failureLimit) {
    const delay = Math.min(
      policy.initialLockoutMs * 2 ** lockoutCount,
      policy.maxLockoutMs,
    );
    lockoutCount += 1;
    failures = 0;
    lockedUntil = new Date(now + delay);
  }
  return { failures, lockoutCount, windowExpired, lockedUntil };
}

async function transaction<T>(
  client: PoolClient,
  action: () => Promise<T>,
): Promise<T> {
  await client.query("BEGIN");
  try {
    await setDatabaseRequestId(client);
    const result = await action();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export function createAdminService(
  pool: Pool,
  config: Pick<AppConfig, "ipHashSecret"> &
    Partial<
      Pick<
        AppConfig,
        | "adminLoginFailures"
        | "adminLoginWindowMs"
        | "adminLoginInitialLockoutMs"
        | "adminLoginMaxLockoutMs"
      >
    >,
): AdminApi {
  const loginPolicy: LoginPolicy = {
    failureLimit:
      config.adminLoginFailures ?? defaultLoginPolicy.failureLimit,
    windowMs: config.adminLoginWindowMs ?? defaultLoginPolicy.windowMs,
    initialLockoutMs:
      config.adminLoginInitialLockoutMs ??
      defaultLoginPolicy.initialLockoutMs,
    maxLockoutMs:
      config.adminLoginMaxLockoutMs ?? defaultLoginPolicy.maxLockoutMs,
  };
  const dummyPasswordHash = bcrypt.hashSync(
    randomBytes(32).toString("hex"),
    passwordRounds,
  );

  function loginSubjects(email: string, ip: string): LoginSubject[] {
    return [
      {
        type: "email",
        hash: hashSubject(config.ipHashSecret, "email", email),
      },
      {
        type: "ip",
        hash: hashSubject(config.ipHashSecret, "ip", ip),
      },
    ];
  }

  async function isLoginLocked(subjects: LoginSubject[]): Promise<boolean> {
    const [email, ip] = subjects;
    const result = await pool.query<{ locked: boolean }>(
      `
        SELECT EXISTS (
          SELECT 1
          FROM admin_login_attempts
          WHERE (
            (subject_type = $1 AND subject_hash = $2)
            OR (subject_type = $3 AND subject_hash = $4)
          )
          AND locked_until > now()
        ) AS locked
      `,
      [email.type, email.hash, ip.type, ip.hash],
    );
    return result.rows[0]?.locked ?? false;
  }

  async function recordFailedLogin(subjects: LoginSubject[]): Promise<void> {
    const client = await pool.connect();
    try {
      await transaction(client, async () => {
        for (const subject of subjects) {
          await client.query(
            `
              INSERT INTO admin_login_attempts (subject_type, subject_hash)
              VALUES ($1, $2)
              ON CONFLICT (subject_type, subject_hash) DO NOTHING
            `,
            [subject.type, subject.hash],
          );
          const result = await client.query<LoginAttempt>(
            `
              SELECT failed_attempts, lockout_count, window_started_at, locked_until
              FROM admin_login_attempts
              WHERE subject_type = $1 AND subject_hash = $2
              FOR UPDATE
            `,
            [subject.type, subject.hash],
          );
          const attempt = result.rows[0];
          if (!attempt) {
            throw new Error("Login attempt record was not created");
          }

          const now = Date.now();
          const next = nextLoginAttempt(attempt, now, loginPolicy);
          if (!next) {
            continue;
          }

          await client.query(
            `
              UPDATE admin_login_attempts
              SET failed_attempts = $3, lockout_count = $4,
                window_started_at = CASE WHEN $5 THEN now() ELSE window_started_at END,
                locked_until = $6
              WHERE subject_type = $1 AND subject_hash = $2
            `,
            [
              subject.type,
              subject.hash,
              next.failures,
              next.lockoutCount,
              next.windowExpired,
              next.lockedUntil,
            ],
          );
        }

        await recordAuditLog(
          client,
          "system",
          null,
          "admin_login_failed",
          "auth",
          null,
          {
            outcome: "failure",
            metadata: { reason: "invalid_credentials" },
          },
        );
      });
    } finally {
      client.release();
    }
  }

  async function login(
    email: string,
    password: string,
    ip: string,
  ): Promise<{ sessionToken: string; csrfToken: string }> {
    const normalizedEmail = normalizeAdminEmail(email);
    const subjects = loginSubjects(normalizedEmail, ip);
    if (await isLoginLocked(subjects)) {
      await recordFailedLogin(subjects);
      throw httpError(401, "Invalid email or password");
    }

    const result = await pool.query<ModeratorRow>(
      `
        SELECT id, email, password_hash, role, active
        FROM moderators
        WHERE email = $1 AND active = true
      `,
      [normalizedEmail],
    );
    const moderator = result.rows[0];
    const validPassword = await bcrypt.compare(
      password,
      moderator?.password_hash ?? dummyPasswordHash,
    );
    if (!moderator || !validPassword) {
      await recordFailedLogin(subjects);
      throw httpError(401, "Invalid email or password");
    }

    const sessionToken = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(32).toString("base64url");
    const sessionHash = hash(sessionToken);
    const csrfHash = hash(csrfToken);
    const client = await pool.connect();
    try {
      await transaction(client, async () => {
        await client.query(
          `
            INSERT INTO admin_sessions (token_hash, csrf_hash, moderator_id, expires_at)
            VALUES ($1, $2, $3, now() + interval '8 hours')
          `,
          [sessionHash, csrfHash, moderator.id],
        );
        await client.query(
          `
            DELETE FROM admin_login_attempts
            WHERE (subject_type = $1 AND subject_hash = $2)
              OR (subject_type = $3 AND subject_hash = $4)
          `,
          [subjects[0].type, subjects[0].hash, subjects[1].type, subjects[1].hash],
        );
        await recordAuditLog(
          client,
          "staff",
          moderator.id,
          "admin_login_succeeded",
          "moderator",
          moderator.id,
          {
            outcome: "success",
            metadata: { method: "password" },
          },
        );
      });
    } finally {
      client.release();
    }
    return { sessionToken, csrfToken };
  }

  async function getSession(token: string): Promise<AdminSession | null> {
    const result = await pool.query<AdminSession>(
      `
        SELECT moderators.id, moderators.role, admin_sessions.csrf_hash AS "csrfHash"
        FROM admin_sessions
        JOIN moderators ON moderators.id = admin_sessions.moderator_id
        WHERE admin_sessions.token_hash = $1
          AND admin_sessions.expires_at > now()
          AND moderators.active = true
      `,
      [hash(token)],
    );
    return result.rows[0] ?? null;
  }

  async function logout(token: string): Promise<void> {
    const client = await pool.connect();
    try {
      await transaction(client, async () => {
        const result = await client.query<{ moderator_id: string }>(
          "DELETE FROM admin_sessions WHERE token_hash = $1 RETURNING moderator_id",
          [hash(token)],
        );
        const moderatorId = result.rows[0]?.moderator_id;
        if (moderatorId) {
          await recordAuditLog(
            client,
            "staff",
            moderatorId,
            "admin_logout",
            "moderator",
            moderatorId,
          );
        }
      });
    } finally {
      client.release();
    }
  }

  async function recordAuthorizationFailure(actorId: string): Promise<void> {
    const client = await pool.connect();
    try {
      await transaction(client, () =>
        recordAuditLog(
          client,
          "staff",
          actorId,
          "authorization_denied",
          "auth",
          null,
          {
            outcome: "failure",
            metadata: { scope: "admin" },
          },
        ),
      );
    } finally {
      client.release();
    }
  }

  async function listModerators(): Promise<Moderator[]> {
    const result = await pool.query<Moderator>(
      "SELECT id, email, role, active FROM moderators ORDER BY email",
    );
    return result.rows;
  }

  async function createModerator(
    email: string,
    password: string,
    role: AdminRole,
    actorId: string,
  ): Promise<Moderator> {
    const passwordHash = await bcrypt.hash(password, passwordRounds);
    const client = await pool.connect();
    try {
      return await transaction(client, async () => {
        const result = await client.query<Moderator>(
          `
            INSERT INTO moderators (email, password_hash, role)
            VALUES ($1, $2, $3)
            RETURNING id, email, role, active
          `,
          [normalizeAdminEmail(email), passwordHash, role],
        );
        const moderator = result.rows[0];
        if (!moderator) {
          throw new Error("Moderator insert returned no row");
        }
        await recordAuditLog(
          client,
          "staff",
          actorId,
          "moderator_created",
          "moderator",
          moderator.id,
        );
        return moderator;
      });
    } catch (error) {
      if (isUniqueEmailError(error)) {
        throw httpError(409, "Moderator already exists");
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async function deleteModerator(id: string, actorId: string): Promise<void> {
    const client = await pool.connect();
    try {
      await transaction(client, async () => {
        await client.query("SELECT pg_advisory_xact_lock($1)", [51467101]);
        const moderatorResult = await client.query<{
          id: string;
          role: AdminRole;
          active: boolean;
        }>(
          "SELECT id, role, active FROM moderators WHERE id = $1 FOR UPDATE",
          [id],
        );
        const moderator = moderatorResult.rows[0];
        if (!moderator) {
          throw httpError(404, "Moderator not found");
        }

        if (moderator.role === "admin" && moderator.active) {
          const admins = await client.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM moderators WHERE role = 'admin' AND active = true",
          );
          if ((admins.rows[0]?.count ?? 0) <= 1) {
            throw httpError(409, "At least one active admin must remain");
          }
        }

        await client.query(
          "UPDATE moderators SET active = false WHERE id = $1",
          [id],
        );
        await client.query("DELETE FROM admin_sessions WHERE moderator_id = $1", [
          id,
        ]);
        await recordAuditLog(
          client,
          "staff",
          actorId,
          "moderator_deactivated",
          "moderator",
          id,
        );
      });
    } finally {
      client.release();
    }
  }

  async function getModerationQueue(): Promise<ModerationPost[]> {
    const result = await pool.query<ModerationPost>(
      `
        SELECT id, display_name AS "displayName", body, category,
          created_at AS "createdAt"
        FROM posts
        WHERE status = 'held'
        ORDER BY created_at ASC, id ASC
      `,
    );
    return result.rows;
  }

  async function getRejectedPosts(): Promise<ModerationPost[]> {
    const result = await pool.query<ModerationPost>(
      `
        SELECT id, display_name AS "displayName", body, category,
          created_at AS "createdAt", rejected_at AS "rejectedAt"
        FROM posts
        WHERE status = 'rejected'
        ORDER BY rejected_at DESC, id DESC
      `,
    );
    return result.rows;
  }

  async function applyModerationAction(
    id: string,
    moderatorId: string,
    action: ModerationAction,
  ): Promise<void> {
    const client = await pool.connect();
    try {
      await transaction(client, async () => {
        const result = await client.query<LockedPost>(
          "SELECT id, status, rejected_at FROM posts WHERE id = $1 FOR UPDATE",
          [id],
        );
        const post = result.rows[0];
        if (!post) {
          throw httpError(404, "Post not found");
        }

        const nextStatus = nextModerationStatus(action, post.status);
        const updated = await client.query<{ rejected_at: Date | null }>(
          `
            UPDATE posts
            SET status = $2,
              rejected_at = CASE WHEN $2 = 'rejected' THEN now() ELSE NULL END,
              updated_at = now()
            WHERE id = $1
            RETURNING rejected_at
          `,
          [id, nextStatus],
        );
        const nextRejectedAt = updated.rows[0]?.rejected_at;
        if (nextRejectedAt === undefined) {
          throw new Error("Moderation update returned no row");
        }
        await client.query(
          `
            INSERT INTO moderation_actions (
              post_id, moderator_id, action, from_status, to_status,
              from_rejected_at, to_rejected_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7)
          `,
          [
            id,
            moderatorId,
            action,
            post.status,
            nextStatus,
            post.rejected_at,
            nextRejectedAt,
          ],
        );
        await recordAuditLog(
          client,
          "staff",
          moderatorId,
          moderationAuditActions[action],
          "post",
          id,
        );
      });
    } finally {
      client.release();
    }
  }

  async function undoModeration(
    id: string,
    moderatorId: string,
  ): Promise<void> {
    const client = await pool.connect();
    try {
      await transaction(client, async () => {
        const posts = await client.query<LockedPost>(
          "SELECT id, status, rejected_at FROM posts WHERE id = $1 FOR UPDATE",
          [id],
        );
        const post = posts.rows[0];
        if (!post) {
          throw httpError(404, "Post not found");
        }

        const actions = await client.query<StoredModerationAction>(
          `
            SELECT id, from_status, to_status, from_rejected_at, to_rejected_at
            FROM moderation_actions
            WHERE post_id = $1 AND undone_at IS NULL
            ORDER BY id DESC
            LIMIT 1
            FOR UPDATE
          `,
          [id],
        );
        const action = actions.rows[0];
        if (!action) {
          throw httpError(409, "No moderation action to undo");
        }
        if (
          post.status !== action.to_status ||
          !sameDate(post.rejected_at, action.to_rejected_at)
        ) {
          throw httpError(409, "Post has changed since that moderation action");
        }

        await client.query(
          `
            UPDATE posts
            SET status = $2, rejected_at = $3, updated_at = now()
            WHERE id = $1
          `,
          [id, action.from_status, action.from_rejected_at],
        );
        await client.query(
          `
            UPDATE moderation_actions
            SET undone_at = now(), undone_by = $2
            WHERE id = $1
          `,
          [action.id, moderatorId],
        );
        await recordAuditLog(
          client,
          "staff",
          moderatorId,
          "moderation_undone",
          "post",
          id,
        );
      });
    } finally {
      client.release();
    }
  }

  async function purgeRejectedPosts(): Promise<number> {
    const result = await pool.query<{ deleted: number }>(
      `
        WITH purged AS (
          DELETE FROM posts
          WHERE status = 'rejected'
            AND rejected_at <= now() - interval '7 days'
          RETURNING id
        ),
        logged AS (
          INSERT INTO audit_logs (
            actor_type, action, target_type, target_id
          )
          SELECT 'system', 'post_purged', 'post', id
          FROM purged
          RETURNING target_id
        )
        SELECT count(*)::int AS deleted FROM logged
      `,
    );
    return result.rows[0]?.deleted ?? 0;
  }

  async function purgeExpiredAuthData(): Promise<number> {
    const result = await pool.query<{ deleted: number }>(
      `
        WITH expired_sessions AS (
          DELETE FROM admin_sessions
          WHERE expires_at <= now()
          RETURNING 1
        ),
        stale_login_attempts AS (
          DELETE FROM admin_login_attempts
          WHERE window_started_at < now() - interval '30 days'
            AND (locked_until IS NULL OR locked_until <= now())
          RETURNING 1
        )
        SELECT (
          (SELECT count(*) FROM expired_sessions)
          + (SELECT count(*) FROM stale_login_attempts)
        )::int AS deleted
      `,
    );
    return result.rows[0]?.deleted ?? 0;
  }

  async function getBannedTerms(): Promise<BannedTerm[]> {
    const result = await pool.query<BannedTerm>(
      "SELECT term, type FROM banned_terms ORDER BY type, term",
    );
    return result.rows;
  }

  async function replaceBannedTerms(
    terms: BannedTerm[],
    actorId: string,
  ): Promise<void> {
    const client = await pool.connect();
    try {
      await transaction(client, async () => {
        await client.query("SELECT pg_advisory_xact_lock($1)", [51467103]);
        await client.query("DELETE FROM banned_terms");
        if (terms.length > 0) {
          await client.query(
            `
              INSERT INTO banned_terms (term, type)
              SELECT term, type
              FROM unnest($1::text[], $2::text[]) AS entries(term, type)
            `,
            [terms.map(({ term }) => term), terms.map(({ type }) => type)],
          );
        }
        await recordAuditLog(
          client,
          "staff",
          actorId,
          "banned_terms_replaced",
          "banned_terms",
          null,
        );
      });
    } finally {
      client.release();
    }
  }

  async function getCategories(): Promise<string[]> {
    const result = await pool.query<{ slug: string }>(
      "SELECT slug FROM goal_categories WHERE active = true ORDER BY slug",
    );
    return result.rows.map((row) => row.slug);
  }

  async function replaceCategories(
    categories: string[],
    actorId: string,
  ): Promise<void> {
    const client = await pool.connect();
    try {
      await transaction(client, async () => {
        await client.query("UPDATE goal_categories SET active = false");
        if (categories.length > 0) {
          await client.query(
            `
              INSERT INTO goal_categories (slug, active)
              SELECT slug, true
              FROM unnest($1::text[]) AS categories(slug)
              ON CONFLICT (slug) DO UPDATE SET active = true
            `,
            [categories],
          );
        }
        await recordAuditLog(
          client,
          "staff",
          actorId,
          "categories_replaced",
          "categories",
          null,
        );
      });
    } finally {
      client.release();
    }
  }

  async function featurePost(id: string, actorId: string): Promise<void> {
    const client = await pool.connect();
    try {
      await transaction(client, async () => {
        const result = await client.query<{ status: string }>(
          "SELECT status FROM posts WHERE id = $1 FOR UPDATE",
          [id],
        );
        const post = result.rows[0];
        if (!post) {
          throw httpError(404, "Post not found");
        }
        if (post.status !== "live") {
          throw httpError(409, "Only live posts can be featured");
        }
        await client.query(
          "UPDATE posts SET featured_at = COALESCE(featured_at, now()), updated_at = now() WHERE id = $1",
          [id],
        );
        await recordAuditLog(
          client,
          "staff",
          actorId,
          "post_featured",
          "post",
          id,
        );
      });
    } finally {
      client.release();
    }
  }

  async function unfeaturePost(id: string, actorId: string): Promise<void> {
    const client = await pool.connect();
    try {
      await transaction(client, async () => {
        const result = await client.query(
          "SELECT id FROM posts WHERE id = $1 FOR UPDATE",
          [id],
        );
        if (!result.rows[0]) {
          throw httpError(404, "Post not found");
        }
        await client.query(
          "UPDATE posts SET featured_at = NULL, updated_at = now() WHERE id = $1",
          [id],
        );
        await recordAuditLog(
          client,
          "staff",
          actorId,
          "post_unfeatured",
          "post",
          id,
        );
      });
    } finally {
      client.release();
    }
  }

  async function archiveSemester(id: string, actorId: string): Promise<void> {
    const client = await pool.connect();
    try {
      await transaction(client, async () => {
        const result = await client.query<{ state: string }>(
          "SELECT state FROM semesters WHERE id = $1 FOR UPDATE",
          [id],
        );
        const semester = result.rows[0];
        if (!semester) {
          throw httpError(404, "Semester not found");
        }
        if (semester.state !== "open") {
          throw httpError(409, "Semester is already archived");
        }
        await client.query(
          "UPDATE semesters SET state = 'closed' WHERE id = $1",
          [id],
        );
        await recordAuditLog(
          client,
          "staff",
          actorId,
          "semester_archived",
          "semester",
          id,
        );
      });
    } finally {
      client.release();
    }
  }

  async function getAnalytics(
    semesterId: string | null,
  ): Promise<AdminAnalytics> {
    const result = await pool.query<AnalyticsRow>(
      `
        SELECT
          count(*)::text AS posts,
          coalesce(sum(like_count), 0)::text AS likes,
          coalesce(sum(report_count), 0)::text AS reports,
          count(*) FILTER (
            WHERE status = 'live' AND progress_status = 'achieved'
          )::text AS "achievedGoals",
          count(*) FILTER (WHERE status = 'live')::text AS live,
          count(*) FILTER (WHERE status = 'held')::text AS held,
          count(*) FILTER (WHERE status = 'hidden')::text AS hidden,
          count(*) FILTER (WHERE status = 'rejected')::text AS rejected,
          count(*) FILTER (WHERE status = 'removed')::text AS removed
        FROM posts
        WHERE ($1::uuid IS NULL OR semester_id = $1::uuid)
      `,
      [semesterId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error("Analytics query returned no result");
    }

    return {
      semesterId,
      totals: {
        posts: analyticsCount(row.posts),
        likes: analyticsCount(row.likes),
        reports: analyticsCount(row.reports),
        achievedGoals: analyticsCount(row.achievedGoals),
      },
      moderation: {
        live: analyticsCount(row.live),
        held: analyticsCount(row.held),
        hidden: analyticsCount(row.hidden),
        rejected: analyticsCount(row.rejected),
        removed: analyticsCount(row.removed),
      },
    };
  }

  return {
    login,
    getSession,
    logout,
    recordAuthorizationFailure,
    listModerators,
    createModerator,
    deleteModerator,
    getModerationQueue,
    getRejectedPosts,
    approvePost: (id, moderatorId) =>
      applyModerationAction(id, moderatorId, "approve"),
    rejectPost: (id, moderatorId) =>
      applyModerationAction(id, moderatorId, "reject"),
    undoModeration,
    restoreRejectedPost: (id, moderatorId) =>
      applyModerationAction(id, moderatorId, "restore"),
    purgeRejectedPosts,
    purgeExpiredAuthData,
    getBannedTerms,
    replaceBannedTerms,
    getCategories,
    replaceCategories,
    featurePost,
    unfeaturePost,
    getAnalytics,
    archiveSemester,
  };
}
