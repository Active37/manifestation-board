import type { Pool, QueryResultRow } from "pg";
import { z } from "zod";
import { ApiError } from "../errors.js";
import { normalizeName } from "../names/service.js";
import type {
  FeedPage,
  FeedQuery,
  FeedSort,
  PublicPost,
} from "./types.js";

const pageSize = 30;

type FeedRow = QueryResultRow & {
  id: string;
  display_name: string;
  body: string;
  category: PublicPost["category"];
  like_count: number;
  created_at: Date | string;
  cursor_created_at?: string;
  shuffle_key?: string;
  today_like_count?: number;
};

const cursorSchema = z.object({
  version: z.literal(1),
  sort: z.enum(["shuffle", "newest", "most-liked-today", "most-liked-all-time"]),
  search: z.string().nullable(),
  day: z.string().nullable(),
  values: z.array(z.string()).min(2).max(3),
}).strict();

type FeedCursor = z.infer<typeof cursorSchema>;

function badCursor(): never {
  throw new ApiError(400, "Invalid or expired cursor");
}

function isUuid(value: string): boolean {
  return z.string().uuid().safeParse(value).success;
}

function readCursor(
  value: string,
  sort: FeedSort,
  search: string | null,
  day: string | null,
): FeedCursor {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    return badCursor();
  }
  const parsed = cursorSchema.safeParse(decoded);
  if (
    !parsed.success ||
    parsed.data.sort !== sort ||
    parsed.data.search !== search ||
    parsed.data.day !== day
  ) {
    return badCursor();
  }

  const values = parsed.data.values;
  if (sort === "shuffle") {
    if (values.length !== 2 || !/^[a-f0-9]{32}$/.test(values[0]) || !isUuid(values[1])) {
      return badCursor();
    }
  } else {
    const expectedLength = sort === "newest" ? 2 : 3;
    const timestamp = sort === "newest" ? values[0] : values[1];
    const postId = values.at(-1);
    if (
      values.length !== expectedLength ||
      !timestamp ||
      !z.string().datetime({ offset: true }).safeParse(timestamp).success ||
      !postId ||
      !isUuid(postId)
    ) {
      return badCursor();
    }
    if (expectedLength === 3 && (!/^\d+$/.test(values[0]) || !Number.isSafeInteger(Number(values[0])))) {
      return badCursor();
    }
  }
  return parsed.data;
}

function isoDate(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("Feed query returned an invalid timestamp");
  }
  return date.toISOString();
}

function cursorFor(
  sort: FeedSort,
  search: string | null,
  day: string | null,
  row: FeedRow,
): string {
  let values: string[];
  if (sort === "shuffle") {
    if (!row.shuffle_key) {
      throw new Error("Feed query did not return a shuffle key");
    }
    values = [row.shuffle_key, row.id];
  } else {
    if (!row.cursor_created_at) {
      throw new Error("Feed query did not return a cursor timestamp");
    }
    values = sort === "newest"
      ? [row.cursor_created_at, row.id]
      : [
          String(sort === "most-liked-today" ? row.today_like_count : row.like_count),
          row.cursor_created_at,
          row.id,
        ];
  }
  return Buffer.from(JSON.stringify({ version: 1, sort, search, day, values })).toString("base64url");
}

function toPublicPost(row: FeedRow): PublicPost {
  return {
    id: row.id,
    display_name: row.display_name,
    body: row.body,
    category: row.category,
    like_count: row.like_count,
    created_at: isoDate(row.created_at),
  };
}

export function createPostsFeedService(pool: Pool, getNow: () => Date = () => new Date()) {
  async function findRows(sql: string, values: (string | number | null)[]): Promise<FeedRow[]> {
    const result = await pool.query<FeedRow>(sql, values);
    return result.rows;
  }

  async function listPosts(query: FeedQuery = {}): Promise<FeedPage> {
    const sort = query.sort ?? "shuffle";
    const search = query.search === undefined ? null : normalizeName(query.search);
    const today = getNow().toISOString().slice(0, 10);
    const day = sort === "shuffle" || sort === "most-liked-today" ? today : null;
    const cursor = query.cursor ? readCursor(query.cursor, sort, search, day) : null;
    let rows: FeedRow[];

    if (sort === "shuffle") {
      rows = await findRows(
        `
          SELECT p.id::text AS id, p.display_name, p.body, p.category,
            p.like_count, p.created_at,
            to_char(p.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
              AS cursor_created_at,
            md5($1 || p.id::text) AS shuffle_key
          FROM posts p
          WHERE p.status = 'live'
            AND ($2::text IS NULL OR position($2 in p.name_key) > 0)
            AND ($3::text IS NULL OR
              (md5($1 || p.id::text), p.id) > ($3, $4::uuid))
          ORDER BY md5($1 || p.id::text), p.id
          LIMIT $5
        `,
        [day, search, cursor?.values[0] ?? null, cursor?.values[1] ?? null, pageSize + 1],
      );
    } else if (sort === "newest") {
      rows = await findRows(
        `
          SELECT p.id::text AS id, p.display_name, p.body, p.category,
            p.like_count, p.created_at,
            to_char(p.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
              AS cursor_created_at
          FROM posts p
          WHERE p.status = 'live'
            AND ($1::text IS NULL OR position($1 in p.name_key) > 0)
            AND ($2::timestamptz IS NULL OR
              (p.created_at, p.id) < ($2::timestamptz, $3::uuid))
          ORDER BY p.created_at DESC, p.id DESC
          LIMIT $4
        `,
        [search, cursor?.values[0] ?? null, cursor?.values[1] ?? null, pageSize + 1],
      );
    } else if (sort === "most-liked-all-time") {
      rows = await findRows(
        `
          SELECT p.id::text AS id, p.display_name, p.body, p.category,
            p.like_count, p.created_at,
            to_char(p.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
              AS cursor_created_at
          FROM posts p
          WHERE p.status = 'live'
            AND ($1::text IS NULL OR position($1 in p.name_key) > 0)
            AND ($2::integer IS NULL OR
              (p.like_count, p.created_at, p.id) <
              ($2::integer, $3::timestamptz, $4::uuid))
          ORDER BY p.like_count DESC, p.created_at DESC, p.id DESC
          LIMIT $5
        `,
        [
          search,
          cursor ? Number(cursor.values[0]) : null,
          cursor?.values[1] ?? null,
          cursor?.values[2] ?? null,
          pageSize + 1,
        ],
      );
    } else {
      const endDay = new Date(`${today}T00:00:00.000Z`);
      endDay.setUTCDate(endDay.getUTCDate() + 1);
      rows = await findRows(
        `
          WITH daily_likes AS (
            SELECT post_id, count(*)::integer AS like_count
            FROM likes
            WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz
            GROUP BY post_id
          )
          SELECT p.id::text AS id, p.display_name, p.body, p.category,
            p.like_count, p.created_at,
            to_char(p.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
              AS cursor_created_at,
            COALESCE(daily_likes.like_count, 0) AS today_like_count
          FROM posts p
          LEFT JOIN daily_likes ON daily_likes.post_id = p.id
          WHERE p.status = 'live'
            AND ($3::text IS NULL OR position($3 in p.name_key) > 0)
            AND ($4::integer IS NULL OR
              (COALESCE(daily_likes.like_count, 0), p.created_at, p.id) <
              ($4::integer, $5::timestamptz, $6::uuid))
          ORDER BY COALESCE(daily_likes.like_count, 0) DESC,
            p.created_at DESC, p.id DESC
          LIMIT $7
        `,
        [
          `${today}T00:00:00.000Z`,
          endDay.toISOString(),
          search,
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
      next_cursor: hasNextPage && lastRow ? cursorFor(sort, search, day, lastRow) : null,
    };
  }

  return { listPosts };
}