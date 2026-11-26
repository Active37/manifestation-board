import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import type { AppConfig } from "../config.js";
import { ApiError } from "../errors.js";
import { containsBannedTerm, filterGoal } from "../filter/service.js";
import { normalizeName } from "../names/service.js";
import type {
  CreatedPost,
  NewPostInput,
  PostPatch,
  PostCategory,
  ReportReason,
} from "./types.js";

type PostStatus = "live" | "held" | "hidden" | "rejected" | "removed";

type StoredPost = QueryResultRow & {
  id: string;
  display_name: string;
  name_key: string;
  body: string;
  category: PostCategory | null;
  status: PostStatus;
  edit_key_hash: string;
  semester_id: string;
};

type CreatedPostRow = QueryResultRow & {
  id: string;
  display_name: string;
  body: string;
  created_at: Date | string;
};

type RateAction = "post" | "like";
type RateSubject = "device" | "ip";
type RateWindow = "hour" | "minute";

async function transaction<T>(
  client: PoolClient,
  action: () => Promise<T>,
): Promise<T> {
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

function nameConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505" &&
    "constraint" in error &&
    error.constraint === "posts_name_key_uq"
  );
}

function hasValidEditKey(storedHash: string, editKey: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(storedHash)) {
    return false;
  }
  const expected = Buffer.from(storedHash, "hex");
  const actual = createHash("sha256").update(editKey).digest();
  return timingSafeEqual(actual, expected);
}

function filteredByTerms(value: string, terms: string[]): boolean {
  const normalizedValue = normalizeName(value);
  return terms.some((term) => normalizedValue.includes(normalizeName(term)));
}

function createPostResponse(row: CreatedPostRow, category: PostCategory | null, editKey: string): CreatedPost {
  const createdAt = row.created_at instanceof Date
    ? row.created_at.toISOString()
    : new Date(row.created_at).toISOString();
  return {
    id: row.id,
    display_name: row.display_name,
    body: row.body,
    category,
    created_at: createdAt,
    edit_key: editKey,
  };
}

export function createPostsService(
  pool: Pool,
  config: Pick<AppConfig, "ipHashSecret" | "postsPerHour" | "likesPerMinute">,
) {
  async function consumeRateLimit(
    action: RateAction,
    deviceId: string,
    ip: string,
    limit: number,
    window: RateWindow,
  ): Promise<void> {
    const client = await pool.connect();
    let allowed = false;
    try {
      allowed = await transaction(client, async () => {
        const deviceAllowed = await applySubjectRateLimit(
          client,
          action,
          "device",
          hashIdentifier(config.ipHashSecret, "device", deviceId),
          limit,
          window,
        );
        const ipAllowed = await applySubjectRateLimit(
          client,
          action,
          "ip",
          hashIdentifier(config.ipHashSecret, "ip", ip),
          limit,
          window,
        );
        return deviceAllowed && ipAllowed;
      });
    } finally {
      client.release();
    }
    if (!allowed) {
      throw new ApiError(429, "Too many requests");
    }
  }

  async function createPost(input: NewPostInput): Promise<CreatedPost> {
    const displayName = input.display_name.normalize("NFKC").trim();
    const nameKey = normalizeName(displayName);
    const body = input.body.normalize("NFKC").trim();
    const category = input.category ?? null;
    const editKey = randomBytes(32).toString("base64url");
    const editKeyHash = createHash("sha256").update(editKey).digest("hex");
    const client = await pool.connect();

    try {
      return await transaction(client, async () => {
        const duplicate = await client.query(
          "SELECT 1 FROM posts WHERE name_key = $1",
          [nameKey],
        );
        if (duplicate.rowCount) {
          throw new ApiError(409, "Display name is already taken");
        }

        const semester = await client.query<{ id: string }>(
          "SELECT id FROM semesters WHERE state = 'open' FOR SHARE",
        );
        const semesterId = semester.rows[0]?.id;
        if (!semesterId) {
          throw new ApiError(409, "No open semester is available");
        }

        const bannedTerms = await client.query<{ term: string }>(
          "SELECT term FROM banned_terms",
        );
        const terms = bannedTerms.rows.map((row) => row.term);
        const status =
          containsBannedTerm(displayName, terms) || filterGoal(body, terms).flagged
            ? "held"
            : "live";

        const inserted = await client.query<CreatedPostRow>(
          `
            INSERT INTO posts (
              display_name, name_key, body, category, status,
              edit_key_hash, semester_id
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING id, display_name, body, created_at
          `,
          [displayName, nameKey, body, category, status, editKeyHash, semesterId],
        );
        const row = inserted.rows[0];
        if (!row) {
          throw new Error("Post insert returned no row");
        }
        return createPostResponse(row, category, editKey);
      });
    } catch (error) {
      if (nameConflict(error)) {
        throw new ApiError(409, "Display name is already taken");
      }
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23514"
      ) {
        throw new ApiError(400, "Invalid post category or content");
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async function editablePost(
    client: PoolClient,
    id: string,
    editKey: string,
  ): Promise<StoredPost> {
    const result = await client.query<StoredPost>(
      `
        SELECT id, display_name, name_key, body, category, status,
          edit_key_hash, semester_id
        FROM posts
        WHERE id = $1
        FOR UPDATE
      `,
      [id],
    );
    const post = result.rows[0];
    if (!post || post.status === "removed" || !hasValidEditKey(post.edit_key_hash, editKey)) {
      throw new ApiError(404, "Post not found");
    }
    return post;
  }

  async function requireOpenSemester(client: PoolClient, semesterId: string): Promise<void> {
    const result = await client.query(
      "SELECT 1 FROM semesters WHERE id = $1 AND state = 'open' FOR SHARE",
      [semesterId],
    );
    if (!result.rowCount) {
      throw new ApiError(409, "Archived semesters are read-only");
    }
  }

  async function patchPost(
    id: string,
    editKey: string,
    patch: PostPatch,
  ): Promise<Omit<CreatedPost, "edit_key">> {
    const client = await pool.connect();
    try {
      return await transaction(client, async () => {
        const current = await editablePost(client, id, editKey);
        await requireOpenSemester(client, current.semester_id);
        const displayName = patch.display_name === undefined
          ? current.display_name
          : patch.display_name.normalize("NFKC").trim();
        const body = patch.body === undefined
          ? current.body
          : patch.body.normalize("NFKC").trim();
        const category = patch.category === undefined
          ? current.category
          : patch.category;
        const nameKey = normalizeName(displayName);
        const bannedTerms = await client.query<{ term: string }>(
          "SELECT term FROM banned_terms",
        );
        const terms = bannedTerms.rows.map((row) => row.term);
        const flagged =
          containsBannedTerm(displayName, terms) || filterGoal(body, terms).flagged;
        const status = current.status === "live" || current.status === "held"
          ? flagged ? "held" : "live"
          : current.status;
        const updated = await client.query<{
          id: string;
          display_name: string;
          body: string;
          category: PostCategory | null;
          created_at: Date | string;
        }>(
          `
            UPDATE posts
            SET display_name = $2, name_key = $3, body = $4, category = $5,
              status = $6, updated_at = now()
            WHERE id = $1
            RETURNING id, display_name, body, category, created_at
          `,
          [id, displayName, nameKey, body, category, status],
        );
        const row = updated.rows[0];
        if (!row) {
          throw new Error("Post update returned no row");
        }
        const createdAt = row.created_at instanceof Date
          ? row.created_at.toISOString()
          : new Date(row.created_at).toISOString();
        return {
          id: row.id,
          display_name: row.display_name,
          body: row.body,
          category: row.category,
          created_at: createdAt,
        };
      });
    } catch (error) {
      if (nameConflict(error)) {
        throw new ApiError(409, "Display name is already taken");
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async function deletePost(id: string, editKey: string): Promise<void> {
    const client = await pool.connect();
    try {
      await transaction(client, async () => {
        const post = await editablePost(client, id, editKey);
        await requireOpenSemester(client, post.semester_id);
        await client.query(
          "UPDATE posts SET status = 'removed', rejected_at = NULL, updated_at = now() WHERE id = $1",
          [id],
        );
      });
    } finally {
      client.release();
    }
  }

  async function lockedPostForInteraction(client: PoolClient, id: string): Promise<{
    status: PostStatus;
    semester_state: string;
  }> {
    const result = await client.query<{
      status: PostStatus;
      semester_state: string;
    }>(
      `
        SELECT p.status, s.state AS semester_state
        FROM posts p
        JOIN semesters s ON s.id = p.semester_id
        WHERE p.id = $1
        FOR UPDATE OF p, s
      `,
      [id],
    );
    const post = result.rows[0];
    if (!post) {
      throw new ApiError(404, "Post not found");
    }
    if (post.semester_state !== "open") {
      throw new ApiError(409, "Archived semesters are read-only");
    }
    return post;
  }

  async function likeCount(client: PoolClient, id: string): Promise<number> {
    const result = await client.query<{ like_count: number }>(
      "SELECT like_count FROM posts WHERE id = $1",
      [id],
    );
    return result.rows[0]?.like_count ?? 0;
  }

  async function addLike(id: string, deviceId: string, ip: string): Promise<number> {
    await consumeRateLimit("like", deviceId, ip, config.likesPerMinute, "minute");
    const storedDeviceId = hashIdentifier(config.ipHashSecret, "device", deviceId);
    const client = await pool.connect();
    try {
      return await transaction(client, async () => {
        const post = await lockedPostForInteraction(client, id);
        if (post.status !== "live") {
          throw new ApiError(404, "Post not found");
        }
        const inserted = await client.query(
          `
            INSERT INTO likes (post_id, device_id)
            VALUES ($1, $2)
            ON CONFLICT (post_id, device_id) DO NOTHING
            RETURNING post_id
          `,
          [id, storedDeviceId],
        );
        if (inserted.rowCount) {
          await client.query(
            "UPDATE posts SET like_count = like_count + 1 WHERE id = $1",
            [id],
          );
        }
        return likeCount(client, id);
      });
    } finally {
      client.release();
    }
  }

  async function removeLike(id: string, deviceId: string, ip: string): Promise<number> {
    await consumeRateLimit("like", deviceId, ip, config.likesPerMinute, "minute");
    const storedDeviceId = hashIdentifier(config.ipHashSecret, "device", deviceId);
    const client = await pool.connect();
    try {
      return await transaction(client, async () => {
        await lockedPostForInteraction(client, id);
        const removed = await client.query(
          "DELETE FROM likes WHERE post_id = $1 AND device_id = $2 RETURNING post_id",
          [id, storedDeviceId],
        );
        if (removed.rowCount) {
          await client.query(
            "UPDATE posts SET like_count = GREATEST(like_count - 1, 0) WHERE id = $1",
            [id],
          );
        }
        return likeCount(client, id);
      });
    } finally {
      client.release();
    }
  }

  async function reportPost(
    id: string,
    deviceId: string,
    reason: ReportReason,
    detail: string | null,
  ): Promise<number> {
    const storedDeviceId = hashIdentifier(config.ipHashSecret, "device", deviceId);
    const client = await pool.connect();
    try {
      return await transaction(client, async () => {
        const post = await lockedPostForInteraction(client, id);
        if (post.status !== "live") {
          throw new ApiError(404, "Post not found");
        }
        const inserted = await client.query(
          `
            INSERT INTO reports (post_id, device_id, reason, detail)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (post_id, device_id) DO NOTHING
            RETURNING post_id
          `,
          [id, storedDeviceId, reason, detail],
        );
        if (inserted.rowCount) {
          await client.query(
            `
              UPDATE posts
              SET report_count = report_count + 1,
                status = CASE WHEN report_count + 1 >= 3 THEN 'hidden' ELSE status END,
                updated_at = now()
              WHERE id = $1
            `,
            [id],
          );
        }
        const result = await client.query<{ report_count: number }>(
          "SELECT report_count FROM posts WHERE id = $1",
          [id],
        );
        return result.rows[0]?.report_count ?? 0;
      });
    } finally {
      client.release();
    }
  }

  async function purgeExpiredRateLimits(): Promise<number> {
    const result = await pool.query(
      "DELETE FROM post_rate_limits WHERE window_started_at < now() - interval '1 day'",
    );
    return result.rowCount ?? 0;
  }

  return {
    checkPostRateLimit: (deviceId: string, ip: string) =>
      consumeRateLimit("post", deviceId, ip, config.postsPerHour, "hour"),
    purgeExpiredRateLimits,
    createPost,
    patchPost,
    deletePost,
    addLike,
    removeLike,
    reportPost,
  };
}

function hashIdentifier(secret: string, type: RateSubject, value: string): string {
  return createHmac("sha256", secret).update(`${type}:${value}`).digest("hex");
}

async function applySubjectRateLimit(
  client: PoolClient,
  action: RateAction,
  subject: RateSubject,
  subjectHash: string,
  limit: number,
  window: RateWindow,
): Promise<boolean> {
  const result = await client.query(
    `
      INSERT INTO post_rate_limits AS current (
        action_type, subject_type, subject_hash, window_started_at, request_count
      )
      VALUES ($1, $2, $3, date_trunc($5, CURRENT_TIMESTAMP), 1)
      ON CONFLICT (action_type, subject_type, subject_hash) DO UPDATE SET
        window_started_at = CASE
          WHEN current.window_started_at < date_trunc($5, CURRENT_TIMESTAMP)
          THEN date_trunc($5, CURRENT_TIMESTAMP)
          ELSE current.window_started_at
        END,
        request_count = CASE
          WHEN current.window_started_at < date_trunc($5, CURRENT_TIMESTAMP)
          THEN 1
          ELSE current.request_count + 1
        END
      WHERE current.window_started_at < date_trunc($5, CURRENT_TIMESTAMP)
        OR current.request_count < $4
      RETURNING request_count
    `,
    [action, subject, subjectHash, limit, window],
  );
  return result.rowCount === 1;
}