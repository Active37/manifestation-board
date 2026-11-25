import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { recordAuditLog } from "../audit.js";
import { httpError } from "../errors.js";
import { filterGoal } from "../filter/service.js";
import { hashIdentifier } from "../identifiers.js";
import { normalizeName } from "../names/service.js";
import { setDatabaseRequestId } from "../request-context.js";
import { sanitizeText } from "../text.js";
import type {
  CreatedPost,
  EditedPost,
  FeedPage,
  FeedPost,
  NewPostInput,
  PatchPostInput,
  ProgressUpdate,
  ProgressStatus,
  ArchivedSemester,
  BadgeType,
} from "./types.js";

type RateSubjectType = "device" | "ip";
type RateAction = "post" | "like" | "report" | "name";
type RateWindow = "hour" | "minute";
export type PostStatus = "live" | "held" | "hidden" | "rejected" | "removed";
export type ReportReason = "offensive" | "sexual" | "harassment" | "spam" | "other";

type StoredPost = {
  id: string;
  display_name: string;
  body: string;
  category: string | null;
  status: PostStatus;
  edit_key_hash: string;
  semester_id: string;
};

type ArchivedPostRow = QueryResultRow & {
  id: string;
  displayName: string;
  body: string;
  category: string | null;
  progressStatus: ProgressStatus;
  likeCount: number;
  badges: BadgeType[];
  createdAt: Date | string;
  cursorCreatedAt: string;
};

const archivePageSize = 30;
const maxRateLimitViolations = 8;
const rateLimitAuditThresholds = new Set([1, 3, 7]);
const archiveCursorSchema = z
  .object({
    version: z.literal(1),
    semesterId: z.string().uuid(),
    createdAt: z.string().datetime({ offset: true }),
    postId: z.string().uuid(),
  })
  .strict();

function readArchiveCursor(value: string, semesterId: string): {
  createdAt: string;
  postId: string;
} {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw httpError(400, "Invalid archive cursor");
  }

  const parsed = archiveCursorSchema.safeParse(decoded);
  if (!parsed.success || parsed.data.semesterId !== semesterId) {
    throw httpError(400, "Invalid archive cursor");
  }
  return {
    createdAt: parsed.data.createdAt,
    postId: parsed.data.postId,
  };
}

function archiveCursor(semesterId: string, row: ArchivedPostRow): string {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      semesterId,
      createdAt: row.cursorCreatedAt,
      postId: row.id,
    }),
  ).toString("base64url");
}

function archivePost(row: ArchivedPostRow): FeedPost {
  const createdAt =
    row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt);
  if (!Number.isFinite(createdAt.getTime())) {
    throw new Error("Archive query returned an invalid timestamp");
  }
  return {
    id: row.id,
    displayName: row.displayName,
    body: row.body,
    category: row.category,
    progressStatus: row.progressStatus,
    badges: row.badges,
    likeCount: row.likeCount,
    createdAt: createdAt.toISOString(),
  };
}

export function hashRateLimitSubject(
  secret: string,
  type: RateSubjectType,
  value: string,
): string {
  return hashIdentifier(secret, type, value);
}

async function inTransaction<T>(
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

async function recordRateLimit(
  client: PoolClient,
  actionType: RateAction,
  subjectType: RateSubjectType,
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
        END,
        blocked_until = NULL
      WHERE (current.blocked_until IS NULL OR current.blocked_until <= CURRENT_TIMESTAMP)
        AND (
          current.window_started_at < date_trunc($5, CURRENT_TIMESTAMP)
          OR current.request_count < $4
        )
      RETURNING request_count
    `,
    [actionType, subjectType, subjectHash, limit, window],
  );

  return result.rowCount === 1;
}

async function applySubjectRateLimit(
  client: PoolClient,
  action: RateAction,
  subjectType: RateSubjectType,
  subjectHash: string,
  limit: number,
  window: RateWindow,
): Promise<boolean> {
  const allowed = await recordRateLimit(
    client,
    action,
    subjectType,
    subjectHash,
    limit,
    window,
  );
  if (!allowed) {
    const result = await client.query<{ violation_count: number }>(
      `
        UPDATE post_rate_limits
        SET violation_count = LEAST(violation_count + 1, $4::integer),
          blocked_until = CURRENT_TIMESTAMP + make_interval(
            secs => LEAST(30 * power(2, LEAST(violation_count, 7))::integer, 3600)
          )
        WHERE action_type = $1 AND subject_type = $2 AND subject_hash = $3
        RETURNING violation_count
      `,
      [action, subjectType, subjectHash, maxRateLimitViolations],
    );
    const violationCount = result.rows[0]?.violation_count;
    if (violationCount && rateLimitAuditThresholds.has(violationCount)) {
      await recordAuditLog(
        client,
        "system",
        null,
        "rate_limit_exceeded",
        "auth",
        null,
        {
          outcome: "failure",
          metadata: { action, subjectType, violationCount },
        },
      );
    }
  }
  return allowed;
}

async function applyRateLimit(
  client: PoolClient,
  action: RateAction,
  deviceId: string,
  ip: string,
  limit: number,
  window: RateWindow,
  secret: string,
): Promise<boolean> {
  const deviceAllowed = await applySubjectRateLimit(
    client,
    action,
    "device",
    hashRateLimitSubject(secret, "device", deviceId),
    limit,
    window,
  );
  const ipAllowed = await applySubjectRateLimit(
    client,
    action,
    "ip",
    hashRateLimitSubject(secret, "ip", ip),
    limit,
    window,
  );
  return deviceAllowed && ipAllowed;
}

function isNameConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505" &&
    "constraint" in error &&
    error.constraint === "posts_name_key_uq"
  );
}

export function hasValidEditKey(
  storedHash: string | undefined,
  editKey: string,
): boolean {
  const validHash =
    storedHash !== undefined && /^[a-f0-9]{64}$/i.test(storedHash);
  const expected = validHash
    ? Buffer.from(storedHash, "hex")
    : Buffer.alloc(32);
  const supplied = createHash("sha256").update(editKey).digest();
  return timingSafeEqual(supplied, expected) && validHash;
}

async function findEditablePost(
  client: PoolClient,
  id: string,
  editKey: string,
): Promise<StoredPost> {
  const result = await client.query<StoredPost>(
    `
        SELECT id, display_name, body, category, status, edit_key_hash, semester_id
        FROM posts
        WHERE id = $1
        FOR UPDATE
    `,
    [id],
  );
  const post = result.rows[0];
  if (
    !hasValidEditKey(post?.edit_key_hash, editKey) ||
    !post ||
    post.status === "removed"
  ) {
    throw httpError(404, "Post not found");
  }
  return post;
}

async function requireOpenSemester(
  client: PoolClient,
  semesterId: string,
): Promise<void> {
  const result = await client.query<{ state: string }>(
    "SELECT state FROM semesters WHERE id = $1 FOR SHARE",
    [semesterId],
  );
  if (result.rows[0]?.state !== "open") {
    throw httpError(409, "Archived semesters are read-only");
  }
}

export function statusAfterEdit(status: PostStatus, flagged: boolean): PostStatus {
  if (status === "live" || status === "held") {
    return flagged ? "held" : "live";
  }
  return status;
}

export function shouldHideAfterReports(reportCount: number): boolean {
  return reportCount >= 3;
}

export function createPostsService(
  pool: Pool,
  config: Pick<
    AppConfig,
    | "ipHashSecret"
    | "postsPerHour"
    | "likesPerMinute"
    | "reportsPerHour"
  > &
    Partial<Pick<AppConfig, "namesPerMinute">>,
): {
  checkPostRateLimit: (deviceId: string, ip: string) => Promise<void>;
  checkNameRateLimit: (ip: string) => Promise<void>;
  createPost: (post: NewPostInput, captchaTokenHash: string) => Promise<CreatedPost>;
  patchPost: (id: string, editKey: string, patch: PatchPostInput) => Promise<EditedPost>;
  updateProgress: (
    id: string,
    editKey: string,
    progressStatus: ProgressStatus,
  ) => Promise<ProgressUpdate>;
  deletePost: (id: string, editKey: string) => Promise<void>;
  addLike: (id: string, deviceId: string, ip: string) => Promise<void>;
  removeLike: (id: string, deviceId: string, ip: string) => Promise<void>;
  reportPost: (
    id: string,
    deviceId: string,
    ip: string,
    reason: ReportReason,
    detail: string | null,
  ) => Promise<void>;
  purgeExpiredSecurityRecords: () => Promise<number>;
  listCategories: () => Promise<string[]>;
  listArchivedSemesters: () => Promise<ArchivedSemester[]>;
  listArchivedSemesterPosts: (
    semesterId: string,
    cursor?: string,
  ) => Promise<FeedPage>;
} {
  async function requireAvailableCategory(
    client: PoolClient,
    category: string | null,
  ): Promise<void> {
    if (category === null) {
      return;
    }

    const result = await client.query(
      "SELECT slug FROM goal_categories WHERE slug = $1 AND active = true FOR SHARE",
      [category],
    );
    if (!result.rowCount) {
      throw httpError(400, "Invalid post category");
    }
  }

  async function listCategories(): Promise<string[]> {
    const result = await pool.query<{ slug: string }>(
      "SELECT slug FROM goal_categories WHERE active = true ORDER BY slug",
    );
    return result.rows.map((row) => row.slug);
  }

  async function listArchivedSemesters(): Promise<ArchivedSemester[]> {
    const result = await pool.query<ArchivedSemester>(
      `
        SELECT id::text AS id, name, ends_on::text AS "endsOn"
        FROM semesters
        WHERE state = 'closed'
        ORDER BY ends_on DESC, name ASC, id ASC
      `,
    );
    return result.rows;
  }

  async function listArchivedSemesterPosts(
    semesterId: string,
    cursorValue?: string,
  ): Promise<FeedPage> {
    const semester = await pool.query(
      "SELECT id FROM semesters WHERE id = $1 AND state = 'closed'",
      [semesterId],
    );
    if (!semester.rowCount) {
      throw httpError(404, "Archived semester not found");
    }

    const cursor = cursorValue
      ? readArchiveCursor(cursorValue, semesterId)
      : null;
    const result = await pool.query<ArchivedPostRow>(
      `
        SELECT p.id::text AS id, p.display_name AS "displayName", p.body,
          p.category, p.progress_status AS "progressStatus",
          ARRAY(
            SELECT badge_type FROM post_badges b
            WHERE b.post_id = p.id ORDER BY badge_type
          ) AS badges,
          p.like_count AS "likeCount", p.created_at AS "createdAt",
          to_char(p.created_at AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorCreatedAt"
        FROM posts p
        WHERE p.semester_id = $1 AND p.status = 'live'
          AND ($2::timestamptz IS NULL OR
            (p.created_at, p.id) < ($2::timestamptz, $3::uuid))
        ORDER BY p.created_at DESC, p.id DESC
        LIMIT $4
      `,
      [
        semesterId,
        cursor?.createdAt ?? null,
        cursor?.postId ?? null,
        archivePageSize + 1,
      ],
    );
    const hasNextPage = result.rows.length > archivePageSize;
    const pageRows = result.rows.slice(0, archivePageSize);
    const lastRow = pageRows.at(-1);
    return {
      posts: pageRows.map(archivePost),
      nextCursor:
        hasNextPage && lastRow ? archiveCursor(semesterId, lastRow) : null,
    };
  }

  async function consumeRateLimit(
    action: RateAction,
    deviceId: string,
    ip: string,
    limit: number,
    window: RateWindow,
  ): Promise<void> {
    const client = await pool.connect();
    let allowed: boolean;
    try {
      allowed = await inTransaction(client, () =>
        applyRateLimit(
          client,
          action,
          deviceId,
          ip,
          limit,
          window,
          config.ipHashSecret,
        ),
      );
    } finally {
      client.release();
    }
    if (!allowed) {
      throw httpError(429, "Too many requests");
    }
  }

  async function consumeIpRateLimit(
    action: RateAction,
    ip: string,
    limit: number,
    window: RateWindow,
  ): Promise<void> {
    const client = await pool.connect();
    let allowed: boolean;
    try {
      allowed = await inTransaction(client, () =>
        applySubjectRateLimit(
          client,
          action,
          "ip",
          hashRateLimitSubject(config.ipHashSecret, "ip", ip),
          limit,
          window,
        ),
      );
    } finally {
      client.release();
    }
    if (!allowed) {
      throw httpError(429, "Too many requests");
    }
  }

  async function createPost(
    post: NewPostInput,
    captchaTokenHash: string,
  ): Promise<CreatedPost> {
    if (!/^[a-f0-9]{64}$/.test(captchaTokenHash)) {
      throw httpError(400, "CAPTCHA verification failed");
    }
    const displayName = sanitizeText(post.displayName);
    const body = sanitizeText(post.body);
    const category = post.category === null ? null : sanitizeText(post.category);
    const nameKey = normalizeName(displayName);
    const editKey = randomBytes(32).toString("base64url");
    const editKeyHash = createHash("sha256").update(editKey).digest("hex");
    const client = await pool.connect();

    try {
      return await inTransaction(client, async () => {
        const claimedCaptcha = await client.query(
          `
            INSERT INTO used_captcha_tokens (token_hash)
            VALUES ($1)
            ON CONFLICT (token_hash) DO NOTHING
            RETURNING token_hash
          `,
          [captchaTokenHash],
        );
        if (claimedCaptcha.rowCount !== 1) {
          throw httpError(400, "CAPTCHA verification failed");
        }

        const semesters = await client.query<{ id: string }>(
          "SELECT id FROM semesters WHERE state = 'open' FOR SHARE",
        );
        if (semesters.rows.length !== 1) {
          throw httpError(503, "No open semester is available");
        }
        await requireAvailableCategory(client, category);

        const bannedTerms = await client.query<{ term: string }>(
          "SELECT term FROM banned_terms",
        );
        const status = filterGoal(
          body,
          bannedTerms.rows.map((row) => row.term),
        ).flagged
          ? "held"
          : "live";
        const result = await client.query<Omit<CreatedPost, "editKey">>(
          `
            INSERT INTO posts (
              display_name, name_key, body, category, status, edit_key_hash, semester_id
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING id, display_name AS "displayName", body, category,
              progress_status AS "progressStatus"
          `,
          [
            displayName,
            nameKey,
            body,
            category,
            status,
            editKeyHash,
            semesters.rows[0].id,
          ],
        );

        const created = result.rows[0];
        if (!created) {
          throw new Error("Post insert returned no row");
        }

        return { ...created, editKey };
      });
    } catch (error) {
      if (isNameConflict(error)) {
        throw httpError(409, "Name is already in use");
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async function patchPost(
    id: string,
    editKey: string,
    patch: PatchPostInput,
  ): Promise<EditedPost> {
    const client = await pool.connect();
    try {
      return await inTransaction(client, async () => {
        const current = await findEditablePost(client, id, editKey);
        await requireOpenSemester(client, current.semester_id);
        const displayName =
          patch.displayName === undefined
            ? current.display_name
            : sanitizeText(patch.displayName);
        const body =
          patch.body === undefined ? current.body : sanitizeText(patch.body);
        const category =
          patch.category === undefined
            ? current.category
            : patch.category === null
              ? null
              : sanitizeText(patch.category);
        if (patch.category !== undefined) {
          await requireAvailableCategory(client, category);
        }
        const bannedTerms = await client.query<{ term: string }>(
          "SELECT term FROM banned_terms",
        );
        const flagged = filterGoal(
          body,
          bannedTerms.rows.map((row) => row.term),
        ).flagged;
        const status = statusAfterEdit(current.status, flagged);
        const updated = await client.query<EditedPost>(
          `
            UPDATE posts
            SET display_name = $2, name_key = $3, body = $4, category = $5,
              status = $6,
              featured_at = CASE WHEN $6 = 'live' THEN featured_at ELSE NULL END,
              updated_at = now()
            WHERE id = $1
            RETURNING id, display_name AS "displayName", body, category,
              progress_status AS "progressStatus"
          `,
          [id, displayName, normalizeName(displayName), body, category, status],
        );
        const post = updated.rows[0];
        if (!post) {
          throw new Error("Post update returned no row");
        }
        return post;
      });
    } catch (error) {
      if (isNameConflict(error)) {
        throw httpError(409, "Name is already in use");
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async function updateProgress(
    id: string,
    editKey: string,
    progressStatus: ProgressStatus,
  ): Promise<ProgressUpdate> {
    const client = await pool.connect();
    try {
      return await inTransaction(client, async () => {
        const editable = await findEditablePost(client, id, editKey);
        await requireOpenSemester(client, editable.semester_id);
        const updated = await client.query<{ progressStatus: ProgressStatus }>(
          `
            UPDATE posts
            SET progress_status = $2, updated_at = now()
            WHERE id = $1
            RETURNING progress_status AS "progressStatus"
          `,
          [id, progressStatus],
        );
        const post = updated.rows[0];
        if (!post) {
          throw new Error("Progress update returned no row");
        }
        if (progressStatus === "achieved") {
          await client.query(
            `
              INSERT INTO post_badges (post_id, badge_type)
              VALUES ($1, 'goal_achieved')
              ON CONFLICT (post_id, badge_type) DO NOTHING
            `,
            [id],
          );
        }
        const badges = await client.query<{ badge_type: BadgeType }>(
          "SELECT badge_type FROM post_badges WHERE post_id = $1 ORDER BY badge_type",
          [id],
        );
        return {
          progressStatus: post.progressStatus,
          badges: badges.rows.map((row) => row.badge_type),
        };
      });
    } finally {
      client.release();
    }
  }

  async function deletePost(id: string, editKey: string): Promise<void> {
    const client = await pool.connect();
    try {
      await inTransaction(client, async () => {
        const post = await findEditablePost(client, id, editKey);
        await requireOpenSemester(client, post.semester_id);
        await client.query(
          "UPDATE posts SET status = 'removed', rejected_at = NULL, featured_at = NULL, updated_at = now() WHERE id = $1",
          [id],
        );
        await recordAuditLog(
          client,
          "anonymous_owner",
          null,
          "post_removed",
          "post",
          id,
        );
      });
    } finally {
      client.release();
    }
  }

  async function addLike(id: string, deviceId: string, ip: string): Promise<void> {
    const storedDeviceId = hashIdentifier(
      config.ipHashSecret,
      "device",
      deviceId,
    );
    await consumeRateLimit(
      "like",
      deviceId,
      ip,
      config.likesPerMinute,
      "minute",
    );
    const client = await pool.connect();
    try {
      await inTransaction(client, async () => {
        const posts = await client.query<{
          status: PostStatus;
          semester_state: string;
        }>(
          `
            SELECT p.status, s.state AS semester_state
            FROM posts p
            JOIN semesters s ON s.id = p.semester_id
            WHERE p.id = $1
            FOR UPDATE OF p FOR SHARE OF s
          `,
          [id],
        );
        const post = posts.rows[0];
        if (!post) {
          throw httpError(404, "Post not found");
        }
        if (post.semester_state !== "open") {
          throw httpError(409, "Archived semesters are read-only");
        }

        const existing = await client.query(
          "SELECT 1 FROM likes WHERE post_id = $1 AND device_id = $2 AND device_id_hash_version = 1",
          [id, storedDeviceId],
        );
        if (existing.rowCount) {
          return;
        }
        if (post.status !== "live") {
          throw httpError(404, "Post not found");
        }

        const inserted = await client.query(
          `
            INSERT INTO likes (post_id, device_id, device_id_hash_version)
            VALUES ($1, $2, 1)
            ON CONFLICT (post_id, device_id) DO NOTHING
            RETURNING post_id
          `,
          [id, storedDeviceId],
        );
        if (inserted.rowCount === 1) {
          await client.query(
            "UPDATE posts SET like_count = like_count + 1 WHERE id = $1",
            [id],
          );
        }
      });
    } finally {
      client.release();
    }
  }

  async function removeLike(
    id: string,
    deviceId: string,
    ip: string,
  ): Promise<void> {
    const storedDeviceId = hashIdentifier(
      config.ipHashSecret,
      "device",
      deviceId,
    );
    await consumeRateLimit(
      "like",
      deviceId,
      ip,
      config.likesPerMinute,
      "minute",
    );
    const client = await pool.connect();
    try {
      await inTransaction(client, async () => {
        const posts = await client.query<{ semester_state: string }>(
          `
            SELECT s.state AS semester_state
            FROM posts p
            JOIN semesters s ON s.id = p.semester_id
            WHERE p.id = $1
            FOR UPDATE OF p FOR SHARE OF s
          `,
          [id],
        );
        if (!posts.rows[0]) {
          throw httpError(404, "Post not found");
        }
        if (posts.rows[0].semester_state !== "open") {
          throw httpError(409, "Archived semesters are read-only");
        }

        const removed = await client.query(
          "DELETE FROM likes WHERE post_id = $1 AND device_id = $2 AND device_id_hash_version = 1 RETURNING post_id",
          [id, storedDeviceId],
        );
        if (removed.rowCount === 1) {
          await client.query(
            "UPDATE posts SET like_count = like_count - 1 WHERE id = $1",
            [id],
          );
        }
      });
    } finally {
      client.release();
    }
  }

  async function reportPost(
    id: string,
    deviceId: string,
    ip: string,
    reason: ReportReason,
    detail: string | null,
  ): Promise<void> {
    const storedDeviceId = hashIdentifier(
      config.ipHashSecret,
      "device",
      deviceId,
    );
    await consumeRateLimit(
      "report",
      deviceId,
      ip,
      config.reportsPerHour,
      "hour",
    );
    const client = await pool.connect();
    try {
      await inTransaction(client, async () => {
        const posts = await client.query<{
          status: PostStatus;
          semester_state: string;
        }>(
          `
            SELECT p.status, s.state AS semester_state
            FROM posts p
            JOIN semesters s ON s.id = p.semester_id
            WHERE p.id = $1
            FOR UPDATE OF p FOR SHARE OF s
          `,
          [id],
        );
        const post = posts.rows[0];
        if (!post) {
          throw httpError(404, "Post not found");
        }
        if (post.semester_state !== "open") {
          throw httpError(409, "Archived semesters are read-only");
        }

        const existing = await client.query(
          "SELECT 1 FROM reports WHERE post_id = $1 AND device_id = $2 AND device_id_hash_version = 1",
          [id, storedDeviceId],
        );
        if (existing.rowCount) {
          return;
        }
        if (post.status !== "live") {
          throw httpError(404, "Post not found");
        }

        const inserted = await client.query(
          `
            INSERT INTO reports (
              post_id, device_id, device_id_hash_version, reason, detail
            )
            VALUES ($1, $2, 1, $3, $4)
            ON CONFLICT (post_id, device_id) DO NOTHING
            RETURNING post_id
          `,
          [
            id,
            storedDeviceId,
            reason,
            detail === null ? null : sanitizeText(detail),
          ],
        );
        if (inserted.rowCount === 1) {
          const updated = await client.query<{ report_count: number }>(
            "UPDATE posts SET report_count = report_count + 1 WHERE id = $1 RETURNING report_count",
            [id],
          );
          const reportCount = updated.rows[0]?.report_count;
          if (reportCount === undefined) {
            throw new Error("Report count update returned no row");
          }
          if (shouldHideAfterReports(reportCount)) {
            await client.query(
              "UPDATE posts SET status = 'hidden', featured_at = NULL WHERE id = $1 AND status = 'live'",
              [id],
            );
          }
        }
      });
    } finally {
      client.release();
    }
  }

  async function purgeExpiredSecurityRecords(): Promise<number> {
    const rateLimits = await pool.query(
      `
        DELETE FROM post_rate_limits
        WHERE window_started_at < CURRENT_TIMESTAMP - interval '2 days'
          AND (blocked_until IS NULL OR blocked_until < CURRENT_TIMESTAMP)
      `,
    );
    const captchaTokens = await pool.query(
      `
        DELETE FROM used_captcha_tokens
        WHERE created_at < CURRENT_TIMESTAMP - interval '10 minutes'
      `,
    );
    return (rateLimits.rowCount ?? 0) + (captchaTokens.rowCount ?? 0);
  }

  return {
    checkPostRateLimit: (deviceId, ip) =>
      consumeRateLimit("post", deviceId, ip, config.postsPerHour, "hour"),
    checkNameRateLimit: (ip) =>
      consumeIpRateLimit("name", ip, config.namesPerMinute ?? 30, "minute"),
    createPost,
    patchPost,
    updateProgress,
    deletePost,
    addLike,
    removeLike,
    reportPost,
    purgeExpiredSecurityRecords,
    listCategories,
    listArchivedSemesters,
    listArchivedSemesterPosts,
  };
}
