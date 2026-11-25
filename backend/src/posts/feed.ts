import type { QueryResultRow } from "pg";
import { z } from "zod";
import { httpError } from "../errors.js";
import { normalizeName } from "../names/service.js";
import type { FeedPage, FeedPost, FeedQuery, FeedSort } from "./types.js";

const pageSize = 30;
const cursorSchema = z
  .object({
    version: z.literal(1),
    sort: z.enum(["shuffle", "newest", "most-liked-today", "most-liked-all-time"]),
    search: z.string().nullable(),
    category: z.string().nullable().optional(),
    day: z.string().nullable(),
    values: z.array(z.string()).min(2).max(3),
  })
  .strict();

export type FeedRow = QueryResultRow & {
  id: string;
  displayName: string;
  body: string;
  category: string | null;
  progressStatus: FeedPost["progressStatus"];
  badges: FeedPost["badges"];
  likeCount: number;
  createdAt: Date | string;
  cursorCreatedAt?: string;
  shuffleKey?: string;
  todayLikeCount?: number;
};

export type FeedLookup = (
  sql: string,
  values: (string | number | null)[],
) => Promise<FeedRow[]>;

type FeedCursor = z.infer<typeof cursorSchema>;

function invalidCursor(): never {
  throw httpError(400, "Invalid or expired cursor");
}

function cursorDate(value: string): boolean {
  return z.string().datetime({ offset: true }).safeParse(value).success;
}

function cursorUuid(value: string): boolean {
  return z.string().uuid().safeParse(value).success;
}

function readCursor(
  value: string,
  sort: FeedSort,
  search: string | null,
  category: string | null,
  day: string | null,
): FeedCursor {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    return invalidCursor();
  }

  const parsed = cursorSchema.safeParse(decoded);
  if (
    !parsed.success ||
    parsed.data.sort !== sort ||
    parsed.data.search !== search ||
    (parsed.data.category ?? null) !== category ||
    parsed.data.day !== day
  ) {
    return invalidCursor();
  }

  const values = parsed.data.values;
  if (sort === "shuffle") {
    if (values.length !== 2 || !/^[a-f0-9]{32}$/.test(values[0]) || !cursorUuid(values[1])) {
      return invalidCursor();
    }
  } else if (sort === "newest") {
    if (values.length !== 2 || !cursorDate(values[0]) || !cursorUuid(values[1])) {
      return invalidCursor();
    }
  } else if (
    values.length !== 3 ||
    !/^\d+$/.test(values[0]) ||
    !Number.isSafeInteger(Number(values[0])) ||
    !cursorDate(values[1]) ||
    !cursorUuid(values[2])
  ) {
    return invalidCursor();
  }

  return parsed.data;
}

function toIsoString(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("Feed query returned an invalid timestamp");
  }
  return date.toISOString();
}

function cursorValues(sort: FeedSort, row: FeedRow): string[] {
  if (sort === "shuffle") {
    if (!row.shuffleKey) {
      throw new Error("Feed query did not return a shuffle key");
    }
    return [row.shuffleKey, row.id];
  }

  const createdAt = row.cursorCreatedAt;
  if (!createdAt || !cursorDate(createdAt)) {
    throw new Error("Feed query did not return a cursor timestamp");
  }

  if (sort === "newest") {
    return [createdAt, row.id];
  }

  const likes = sort === "most-liked-today" ? row.todayLikeCount : row.likeCount;
  if (likes === undefined || !Number.isSafeInteger(likes) || likes < 0) {
    throw new Error("Feed query returned an invalid like count");
  }
  return [String(likes), createdAt, row.id];
}

function encodeCursor(
  sort: FeedSort,
  search: string | null,
  category: string | null,
  day: string | null,
  row: FeedRow,
): string {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      sort,
      search,
      category,
      day,
      values: cursorValues(sort, row),
    }),
  ).toString("base64url");
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function toPublicPost(row: FeedRow): FeedPost {
  return {
    id: row.id,
    displayName: row.displayName,
    body: row.body,
    category: row.category,
    progressStatus: row.progressStatus,
    badges: row.badges,
    likeCount: row.likeCount,
    createdAt: toIsoString(row.createdAt),
  };
}

export function createPostsFeedService(
  findRows: FeedLookup,
  getNow: () => Date = () => new Date(),
): {
  listPosts: (query: FeedQuery) => Promise<FeedPage>;
  listAchievedPosts: () => Promise<FeedPost[]>;
  listFeaturedPosts: () => Promise<FeedPost[]>;
  getRandomPost: () => Promise<FeedPost | null>;
} {
  async function listPosts(query: FeedQuery): Promise<FeedPage> {
    const sort = query.sort ?? "shuffle";
    const search =
      query.search === undefined ? null : normalizeName(query.search);
    const category = query.category ?? null;
    if (search === "") {
      throw httpError(400, "Invalid feed query");
    }

    const today = getNow().toISOString().slice(0, 10);
    const day =
      sort === "shuffle" || sort === "most-liked-today" ? today : null;
    const cursor = query.cursor
      ? readCursor(query.cursor, sort, search, category, day)
      : null;
    const searchPattern =
      search === null ? null : `%${escapeLike(search)}%`;
    let rows: FeedRow[];

    if (sort === "shuffle") {
      rows = await findRows(
        `
          SELECT p.id::text AS id, p.display_name AS "displayName", p.body,
            p.category, p.progress_status AS "progressStatus",
            ARRAY(
              SELECT badge_type FROM post_badges b
              WHERE b.post_id = p.id ORDER BY badge_type
            ) AS badges,
            p.like_count AS "likeCount", p.created_at AS "createdAt",
            to_char(p.created_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorCreatedAt",
            md5($2 || p.id::text) AS "shuffleKey"
          FROM posts p
          WHERE p.status = 'live'
            AND ($1::text IS NULL OR p.name_key LIKE $1 ESCAPE E'\\\\')
            AND ($3::text IS NULL OR p.category = $3)
            AND ($4::text IS NULL OR (md5($2 || p.id::text), p.id) > ($4, $5::uuid))
          ORDER BY md5($2 || p.id::text) ASC, p.id ASC
          LIMIT $6
        `,
        [
          searchPattern,
          day,
          category,
          cursor?.values[0] ?? null,
          cursor?.values[1] ?? null,
          pageSize + 1,
        ],
      );
    } else if (sort === "newest") {
      rows = await findRows(
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
          WHERE p.status = 'live'
            AND ($1::text IS NULL OR p.name_key LIKE $1 ESCAPE E'\\\\')
            AND ($2::text IS NULL OR p.category = $2)
            AND ($3::timestamptz IS NULL OR
              (p.created_at, p.id) < ($3::timestamptz, $4::uuid))
          ORDER BY p.created_at DESC, p.id DESC
          LIMIT $5
        `,
        [
          searchPattern,
          category,
          cursor?.values[0] ?? null,
          cursor?.values[1] ?? null,
          pageSize + 1,
        ],
      );
    } else if (sort === "most-liked-all-time") {
      rows = await findRows(
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
          WHERE p.status = 'live'
            AND ($1::text IS NULL OR p.name_key LIKE $1 ESCAPE E'\\\\')
            AND ($2::text IS NULL OR p.category = $2)
            AND ($3::integer IS NULL OR
              (p.like_count, p.created_at, p.id) <
              ($3::integer, $4::timestamptz, $5::uuid))
          ORDER BY p.like_count DESC, p.created_at DESC, p.id DESC
          LIMIT $6
        `,
        [
          searchPattern,
          category,
          cursor ? Number(cursor.values[0]) : null,
          cursor?.values[1] ?? null,
          cursor?.values[2] ?? null,
          pageSize + 1,
        ],
      );
    } else {
      const start = `${today}T00:00:00.000Z`;
      const endDate = new Date(start);
      endDate.setUTCDate(endDate.getUTCDate() + 1);
      rows = await findRows(
        `
          WITH daily_likes AS (
            SELECT post_id, count(*)::integer AS like_count
            FROM likes
            WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz
            GROUP BY post_id
          )
          SELECT p.id::text AS id, p.display_name AS "displayName", p.body,
            p.category, p.progress_status AS "progressStatus",
            ARRAY(
              SELECT badge_type FROM post_badges b
              WHERE b.post_id = p.id ORDER BY badge_type
            ) AS badges,
            p.like_count AS "likeCount", p.created_at AS "createdAt",
            to_char(p.created_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorCreatedAt",
            COALESCE(daily_likes.like_count, 0) AS "todayLikeCount"
          FROM posts p
          LEFT JOIN daily_likes ON daily_likes.post_id = p.id
          WHERE p.status = 'live'
            AND ($3::text IS NULL OR p.name_key LIKE $3 ESCAPE E'\\\\')
            AND ($4::text IS NULL OR p.category = $4)
            AND ($5::integer IS NULL OR
              (COALESCE(daily_likes.like_count, 0), p.created_at, p.id) <
              ($5::integer, $6::timestamptz, $7::uuid))
          ORDER BY COALESCE(daily_likes.like_count, 0) DESC,
            p.created_at DESC, p.id DESC
          LIMIT $8
        `,
        [
          start,
          endDate.toISOString(),
          searchPattern,
          category,
          cursor ? Number(cursor.values[0]) : null,
          cursor?.values[1] ?? null,
          cursor?.values[2] ?? null,
          pageSize + 1,
        ],
      );
    }

    const hasNextPage = rows.length > pageSize;
    const pageRows = rows.slice(0, pageSize);
    const lastRow = pageRows.at(-1);

    return {
      posts: pageRows.map(toPublicPost),
      nextCursor:
        hasNextPage && lastRow
          ? encodeCursor(sort, search, category, day, lastRow)
          : null,
    };
  }

  async function listAchievedPosts(): Promise<FeedPost[]> {
    const rows = await findRows(
      `
        SELECT p.id::text AS id, p.display_name AS "displayName", p.body,
          p.category, p.progress_status AS "progressStatus",
          ARRAY(
            SELECT badge_type FROM post_badges b
            WHERE b.post_id = p.id ORDER BY badge_type
          ) AS badges,
          p.like_count AS "likeCount", p.created_at AS "createdAt"
        FROM posts p
        WHERE p.status = 'live' AND p.progress_status = 'achieved'
        ORDER BY p.created_at DESC, p.id DESC
      `,
      [],
    );
    return rows.map(toPublicPost);
  }

  async function listFeaturedPosts(): Promise<FeedPost[]> {
    const rows = await findRows(
      `
        SELECT p.id::text AS id, p.display_name AS "displayName", p.body,
          p.category, p.progress_status AS "progressStatus",
          ARRAY(
            SELECT badge_type FROM post_badges b
            WHERE b.post_id = p.id ORDER BY badge_type
          ) AS badges,
          p.like_count AS "likeCount", p.created_at AS "createdAt"
        FROM posts p
        WHERE p.status = 'live' AND p.featured_at IS NOT NULL
        ORDER BY p.featured_at DESC, p.id DESC
      `,
      [],
    );
    return rows.map(toPublicPost);
  }

  async function getRandomPost(): Promise<FeedPost | null> {
    const rows = await findRows(
      `
        SELECT p.id::text AS id, p.display_name AS "displayName", p.body,
          p.category, p.progress_status AS "progressStatus",
          ARRAY(
            SELECT badge_type FROM post_badges b
            WHERE b.post_id = p.id ORDER BY badge_type
          ) AS badges,
          p.like_count AS "likeCount", p.created_at AS "createdAt"
        FROM posts p
        WHERE p.status = 'live'
        ORDER BY random()
        LIMIT 1
      `,
      [],
    );
    const post = rows[0];
    return post ? toPublicPost(post) : null;
  }

  return {
    listPosts,
    listAchievedPosts,
    listFeaturedPosts,
    getRandomPost,
  };
}
