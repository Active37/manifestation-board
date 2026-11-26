import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import bcrypt from "bcryptjs";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { ApiError } from "../errors.js";

export type AdminRole = "admin" | "moderator";

export type AdminSession = {
  id: string;
  role: AdminRole;
  csrfHash: string;
};

export type Moderator = {
  id: string;
  email: string;
  role: AdminRole;
  active: boolean;
};

export type ModerationPost = {
  id: string;
  display_name: string;
  body: string;
  category: string | null;
  status: "held" | "hidden" | "rejected";
  report_count: number;
  created_at: Date;
  rejected_at?: Date | null;
};

export type BannedTerm = { term: string; type: string };
export type Semester = {
  id: string;
  name: string;
  ends_on: string;
  state: "open" | "closed";
};

type ModeratorRow = QueryResultRow & Moderator & { password_hash: string };
type ModerationAction = "approve" | "reject" | "restore";
type ModerationStatus = "live" | "held" | "hidden" | "rejected";
type PostStatus = ModerationStatus | "removed";

type StoredModerationAction = QueryResultRow & {
  id: string;
  from_status: ModerationStatus;
  to_status: ModerationStatus;
  from_rejected_at: Date | null;
  to_rejected_at: Date | null;
};

const passwordRounds = 12;
const dummyPasswordHash = bcrypt.hashSync(randomBytes(32).toString("hex"), passwordRounds);

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function matchesHash(expectedHash: string, value: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) {
    return false;
  }
  return timingSafeEqual(
    Buffer.from(expectedHash, "hex"),
    createHash("sha256").update(value).digest(),
  );
}

function normalizedEmail(email: string): string {
  return email.normalize("NFKC").trim().toLowerCase();
}

async function transaction<T>(client: PoolClient, action: () => Promise<T>): Promise<T> {
  await client.query("BEGIN");
  try {
    const result = await action();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
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
    error.constraint === "moderators_email_uq"
  );
}

export function createAdminService(pool: Pool) {
  async function login(
    email: string,
    password: string,
  ): Promise<{ sessionToken: string; csrfToken: string }> {
    const result = await pool.query<ModeratorRow>(
      `
        SELECT id, email, password_hash, role, active
        FROM moderators
        WHERE email = $1 AND active = true
      `,
      [normalizedEmail(email)],
    );
    const moderator = result.rows[0];
    const validPassword = await bcrypt.compare(
      password,
      moderator?.password_hash ?? dummyPasswordHash,
    );
    if (!moderator || !validPassword) {
      throw new ApiError(401, "Invalid email or password");
    }

    const sessionToken = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(32).toString("base64url");
    await pool.query(
      `
        INSERT INTO admin_sessions (token_hash, csrf_hash, moderator_id, expires_at)
        VALUES ($1, $2, $3, now() + interval '8 hours')
      `,
      [hash(sessionToken), hash(csrfToken), moderator.id],
    );
    return { sessionToken, csrfToken };
  }

  async function getSession(token: string): Promise<AdminSession | null> {
    const result = await pool.query<AdminSession>(
      `
        SELECT m.id, m.role, s.csrf_hash AS "csrfHash"
        FROM admin_sessions s
        JOIN moderators m ON m.id = s.moderator_id
        WHERE s.token_hash = $1 AND s.expires_at > now() AND m.active = true
      `,
      [hash(token)],
    );
    return result.rows[0] ?? null;
  }

  async function logout(token: string): Promise<void> {
    await pool.query("DELETE FROM admin_sessions WHERE token_hash = $1", [hash(token)]);
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
  ): Promise<Moderator> {
    const passwordHash = await bcrypt.hash(password, passwordRounds);
    try {
      const result = await pool.query<Moderator>(
        `
          INSERT INTO moderators (email, password_hash, role)
          VALUES ($1, $2, $3)
          RETURNING id, email, role, active
        `,
        [normalizedEmail(email), passwordHash, role],
      );
      const moderator = result.rows[0];
      if (!moderator) {
        throw new Error("Moderator insert returned no row");
      }
      return moderator;
    } catch (error) {
      if (isUniqueEmailError(error)) {
        throw new ApiError(409, "Moderator already exists");
      }
      throw error;
    }
  }

  async function deactivateModerator(id: string): Promise<void> {
    const client = await pool.connect();
    try {
      await transaction(client, async () => {
        const moderatorResult = await client.query<{
          id: string;
          role: AdminRole;
          active: boolean;
        }>("SELECT id, role, active FROM moderators WHERE id = $1 FOR UPDATE", [id]);
        const moderator = moderatorResult.rows[0];
        if (!moderator) {
          throw new ApiError(404, "Moderator not found");
        }
        if (moderator.role === "admin" && moderator.active) {
          const admins = await client.query<{ count: number }>(
            "SELECT count(*)::integer AS count FROM moderators WHERE role = 'admin' AND active = true",
          );
          if ((admins.rows[0]?.count ?? 0) <= 1) {
            throw new ApiError(409, "At least one active admin must remain");
          }
        }
        await client.query("UPDATE moderators SET active = false WHERE id = $1", [id]);
        await client.query("DELETE FROM admin_sessions WHERE moderator_id = $1", [id]);
      });
    } finally {
      client.release();
    }
  }

  async function moderationQueue(): Promise<ModerationPost[]> {
    const result = await pool.query<ModerationPost>(
      `
        SELECT id, display_name, body, category, status, report_count, created_at
        FROM posts
        WHERE status IN ('held', 'hidden')
        ORDER BY created_at ASC, id ASC
      `,
    );
    return result.rows;
  }

  async function rejectedPosts(): Promise<ModerationPost[]> {
    const result = await pool.query<ModerationPost>(
      `
        SELECT id, display_name, body, category, status, report_count,
          created_at, rejected_at
        FROM posts
        WHERE status = 'rejected'
          AND rejected_at > now() - interval '7 days'
        ORDER BY rejected_at DESC, id DESC
      `,
    );
    return result.rows;
  }

  async function applyModerationAction(
    id: string,
    moderatorId: string,
    action: "approve" | "reject",
  ): Promise<void> {
    const client = await pool.connect();
    try {
      await transaction(client, async () => {
        const result = await client.query<{
          status: PostStatus;
          rejected_at: Date | null;
        }>("SELECT status, rejected_at FROM posts WHERE id = $1 FOR UPDATE", [id]);
        const post = result.rows[0];
        if (!post) {
          throw new ApiError(404, "Post not found");
        }
        if (post.status !== "held" && post.status !== "hidden") {
          throw new ApiError(409, "Post is not awaiting moderation");
        }
        const toStatus = action === "approve" ? "live" : "rejected";
        const updated = await client.query<{ rejected_at: Date | null }>(
          `
            UPDATE posts
            SET status = $2,
              rejected_at = CASE WHEN $2 = 'rejected' THEN now() ELSE NULL END,
              updated_at = now()
            WHERE id = $1
            RETURNING rejected_at
          `,
          [id, toStatus],
        );
        const toRejectedAt = updated.rows[0]?.rejected_at;
        if (toRejectedAt === undefined) {
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
          [id, moderatorId, action, post.status, toStatus, post.rejected_at, toRejectedAt],
        );
      });
    } finally {
      client.release();
    }
  }

  async function undoModeration(id: string, moderatorId: string): Promise<void> {
    const client = await pool.connect();
    try {
      await transaction(client, async () => {
        const postResult = await client.query<{
          status: ModerationStatus;
          rejected_at: Date | null;
        }>("SELECT status, rejected_at FROM posts WHERE id = $1 FOR UPDATE", [id]);
        const post = postResult.rows[0];
        if (!post) {
          throw new ApiError(404, "Post not found");
        }
        const actionResult = await client.query<StoredModerationAction>(
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
        const action = actionResult.rows[0];
        if (!action) {
          throw new ApiError(409, "No moderation action to undo");
        }
        if (post.status !== action.to_status || !sameDate(post.rejected_at, action.to_rejected_at)) {
          throw new ApiError(409, "Post has changed since that moderation action");
        }
        await client.query(
          "UPDATE posts SET status = $2, rejected_at = $3, updated_at = now() WHERE id = $1",
          [id, action.from_status, action.from_rejected_at],
        );
        await client.query(
          "UPDATE moderation_actions SET undone_at = now(), undone_by = $2 WHERE id = $1",
          [action.id, moderatorId],
        );
      });
    } finally {
      client.release();
    }
  }

  async function restoreRejectedPost(id: string, moderatorId: string): Promise<void> {
    const client = await pool.connect();
    try {
      await transaction(client, async () => {
        const result = await client.query<{
          status: PostStatus;
          rejected_at: Date | null;
        }>("SELECT status, rejected_at FROM posts WHERE id = $1 FOR UPDATE", [id]);
        const post = result.rows[0];
        if (!post) {
          throw new ApiError(404, "Post not found");
        }
        if (
          post.status !== "rejected" ||
          !post.rejected_at ||
          post.rejected_at.getTime() <= Date.now() - 7 * 24 * 60 * 60 * 1000
        ) {
          throw new ApiError(409, "Post is outside the rejection backlog");
        }
        const previous = await client.query<{ from_status: ModerationStatus }>(
          `
            SELECT from_status
            FROM moderation_actions
            WHERE post_id = $1 AND action = 'reject' AND to_status = 'rejected'
            ORDER BY id DESC
            LIMIT 1
          `,
          [id],
        );
        const restoredStatus = previous.rows[0]?.from_status ?? "held";
        const updated = await client.query<{ rejected_at: Date | null }>(
          `
            UPDATE posts
            SET status = $2, rejected_at = NULL, updated_at = now()
            WHERE id = $1
            RETURNING rejected_at
          `,
          [id, restoredStatus],
        );
        const toRejectedAt = updated.rows[0]?.rejected_at;
        if (toRejectedAt === undefined) {
          throw new Error("Restore update returned no row");
        }
        await client.query(
          `
            INSERT INTO moderation_actions (
              post_id, moderator_id, action, from_status, to_status,
              from_rejected_at, to_rejected_at
            )
            VALUES ($1, $2, 'restore', 'rejected', $3, $4, $5)
          `,
          [id, moderatorId, restoredStatus, post.rejected_at, toRejectedAt],
        );
      });
    } finally {
      client.release();
    }
  }

  async function purgeExpiredRejectedPosts(): Promise<number> {
    const result = await pool.query(
      "DELETE FROM posts WHERE status = 'rejected' AND rejected_at <= now() - interval '7 days'",
    );
    return result.rowCount ?? 0;
  }

  async function purgeExpiredSessions(): Promise<number> {
    const result = await pool.query(
      "DELETE FROM admin_sessions WHERE expires_at <= now()",
    );
    return result.rowCount ?? 0;
  }

  async function listBannedTerms(): Promise<BannedTerm[]> {
    const result = await pool.query<BannedTerm>(
      "SELECT term, type FROM banned_terms ORDER BY type, term",
    );
    return result.rows;
  }

  async function listSemesters(): Promise<Semester[]> {
    const result = await pool.query<Semester>(
      "SELECT id, name, ends_on::text AS ends_on, state FROM semesters ORDER BY ends_on DESC, id",
    );
    return result.rows;
  }

  async function createSemester(name: string, endsOn: string): Promise<Semester> {
    try {
      const result = await pool.query<Semester>(
        `
          INSERT INTO semesters (name, ends_on, state)
          VALUES ($1, $2::date, 'open')
          RETURNING id, name, ends_on::text AS ends_on, state
        `,
        [name.trim(), endsOn],
      );
      const semester = result.rows[0];
      if (!semester) {
        throw new Error("Semester insert returned no row");
      }
      return semester;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23505" &&
        "constraint" in error &&
        error.constraint === "semesters_one_open_idx"
      ) {
        throw new ApiError(409, "An open semester already exists");
      }
      throw error;
    }
  }

  async function closeSemester(id: string): Promise<void> {
    const client = await pool.connect();
    try {
      await transaction(client, async () => {
        const result = await client.query<{ state: "open" | "closed" }>(
          "SELECT state FROM semesters WHERE id = $1 FOR UPDATE",
          [id],
        );
        const semester = result.rows[0];
        if (!semester) {
          throw new ApiError(404, "Semester not found");
        }
        if (semester.state !== "open") {
          throw new ApiError(409, "Semester is already closed");
        }
        await client.query("UPDATE semesters SET state = 'closed' WHERE id = $1", [id]);
      });
    } finally {
      client.release();
    }
  }

  async function replaceBannedTerms(terms: BannedTerm[]): Promise<void> {
    const client = await pool.connect();
    try {
      await transaction(client, async () => {
        await client.query("DELETE FROM banned_terms");
        if (terms.length) {
          await client.query(
            `
              INSERT INTO banned_terms (term, type)
              SELECT term, type
              FROM unnest($1::text[], $2::text[]) AS values(term, type)
            `,
            [terms.map((item) => item.term), terms.map((item) => item.type)],
          );
        }
      });
    } finally {
      client.release();
    }
  }

  return {
    login,
    getSession,
    logout,
    listModerators,
    createModerator,
    deactivateModerator,
    moderationQueue,
    rejectedPosts,
    approvePost: (id: string, moderatorId: string) =>
      applyModerationAction(id, moderatorId, "approve"),
    rejectPost: (id: string, moderatorId: string) =>
      applyModerationAction(id, moderatorId, "reject"),
    undoModeration,
    restoreRejectedPost,
    purgeExpiredRejectedPosts,
    purgeExpiredSessions,
    listBannedTerms,
    replaceBannedTerms,
    listSemesters,
    createSemester,
    closeSemester,
  };
}