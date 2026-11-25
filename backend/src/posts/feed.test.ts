import assert from "node:assert/strict";
import test from "node:test";
import { createPostsFeedService, type FeedRow } from "./feed.js";

const today = "2026-11-23";
const now = () => new Date(`${today}T12:00:00.000Z`);

function row(index: number, sortFields: Partial<FeedRow> = {}): FeedRow {
  return {
    id: `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
    displayName: `Manifest-Lion-${index}`,
    body: "A semester goal",
    category: null,
    progressStatus: "not_started",
    badges: [],
    likeCount: index,
    createdAt: `${today}T12:00:00.000Z`,
    cursorCreatedAt: `${today}T12:00:00.000000Z`,
    ...sortFields,
  };
}

test("defaults to a UTC-daily stable shuffle and caps pages at 30", async () => {
  let query: string | undefined;
  let values: (string | number | null)[] | undefined;
  const service = createPostsFeedService(async (sql, params) => {
    query = sql;
    values = params;
    return Array.from({ length: 31 }, (_, index) =>
      row(index + 1, { shuffleKey: index.toString(16).padStart(32, "0") }),
    );
  }, now);

  const page = await service.listPosts({});

  assert.equal(page.posts.length, 30);
  assert.ok(page.nextCursor);
  assert.match(query ?? "", /md5\(\$2 \|\| p\.id::text\)/);
  assert.equal(values?.[1], today);
  assert.equal(values?.[5], 31);
  assert.equal(page.posts[0].progressStatus, "not_started");
  assert.equal("status" in page.posts[0], false);
  assert.equal("editKey" in page.posts[0], false);
});

test("binds cursors to their sort, search, category, and UTC day", async () => {
  const service = createPostsFeedService(
    async () =>
      Array.from({ length: 31 }, (_, index) =>
        row(index + 1, { shuffleKey: index.toString(16).padStart(32, "0") }),
      ),
    now,
  );
  const firstPage = await service.listPosts({ search: "Manifest" });
  assert.ok(firstPage.nextCursor);

  await assert.rejects(
    service.listPosts({ search: "Different", cursor: firstPage.nextCursor ?? "" }),
    /Invalid or expired cursor/,
  );
  await assert.rejects(
    service.listPosts({
      category: "academic",
      cursor: firstPage.nextCursor ?? "",
    }),
    /Invalid or expired cursor/,
  );
  await assert.rejects(
    service.listPosts({
      sort: "newest",
      search: "Manifest",
      cursor: firstPage.nextCursor ?? "",
    }),
    /Invalid or expired cursor/,
  );
});

test("expires shuffle cursors at the next UTC day boundary", async () => {
  let currentDay = today;
  const service = createPostsFeedService(
    async () =>
      Array.from({ length: 31 }, (_, index) =>
        row(index + 1, { shuffleKey: index.toString(16).padStart(32, "0") }),
      ),
    () => new Date(`${currentDay}T12:00:00.000Z`),
  );
  const firstPage = await service.listPosts({});
  currentDay = "2026-11-24";

  await assert.rejects(
    service.listPosts({ cursor: firstPage.nextCursor ?? "" }),
    /Invalid or expired cursor/,
  );
});

test("uses keyset values from the previous page", async () => {
  const pages = [
    Array.from({ length: 31 }, (_, index) =>
      row(index + 1, { shuffleKey: (index + 1).toString(16).padStart(32, "0") }),
    ),
    [row(31, { shuffleKey: "31".padStart(32, "0") })],
  ];
  const queries: { sql: string; values: (string | number | null)[] }[] = [];
  const service = createPostsFeedService(async (sql, values) => {
    queries.push({ sql, values });
    return pages.shift() ?? [];
  }, now);

  const first = await service.listPosts({});
  assert.ok(first.nextCursor);
  const second = await service.listPosts({ cursor: first.nextCursor ?? "" });

  assert.equal(second.posts.length, 1);
  assert.equal(second.nextCursor, null);
  assert.ok(queries[1].sql.includes("(md5($2 || p.id::text), p.id) >"));
  assert.equal(queries[1].values[3], "1e".padStart(32, "0"));
});

test("keeps database timestamp precision in newest-sort cursors", async () => {
  const createdAt = `${today}T12:00:00.123456Z`;
  const queries: (string | number | null)[][] = [];
  let call = 0;
  const service = createPostsFeedService(async (_sql, values) => {
    queries.push(values);
    call += 1;
    return call === 1
      ? Array.from({ length: 31 }, (_, index) =>
          row(index + 1, {
            createdAt: `${today}T12:00:00.123Z`,
            cursorCreatedAt: createdAt,
          }),
        )
      : [];
  }, now);

  const firstPage = await service.listPosts({ sort: "newest" });
  assert.ok(firstPage.nextCursor);
  const secondPage = await service.listPosts({
    sort: "newest",
    cursor: firstPage.nextCursor ?? "",
  });

  assert.equal(secondPage.nextCursor, null);
  assert.equal(queries[1][2], createdAt);
});

test("uses the selected SQL order and literal contains search", async () => {
  const queries: { sql: string; values: (string | number | null)[] }[] = [];
  const service = createPostsFeedService(async (sql, values) => {
    queries.push({ sql, values });
    return [];
  }, now);

  await service.listPosts({ sort: "newest", search: "_goal%" });
  await service.listPosts({ sort: "most-liked-today" });
  await service.listPosts({ sort: "most-liked-all-time" });
  await service.listPosts({ category: "academic" });

  assert.ok(queries[0].sql.includes("ORDER BY p.created_at DESC, p.id DESC"));
  assert.equal(queries[0].values[0], "%\\_goal\\%%");
  assert.ok(queries[0].sql.includes("p.category = $2"));
  assert.ok(queries[1].sql.includes("FROM likes"));
  assert.equal(queries[1].values[0], `${today}T00:00:00.000Z`);
  assert.ok(queries[2].sql.includes("ORDER BY p.like_count DESC"));
  assert.equal(queries[3].values[2], "academic");
});

test("lists achieved goals only from live posts without private fields", async () => {
  let query = "";
  const service = createPostsFeedService(async (sql) => {
    query = sql;
    return [row(1, { progressStatus: "achieved", badges: ["goal_achieved"] })];
  }, now);

  const posts = await service.listAchievedPosts();

  assert.match(query, /WHERE p\.status = 'live' AND p\.progress_status = 'achieved'/);
  assert.match(query, /FROM post_badges/);
  assert.deepEqual(posts, [
    {
      id: row(1).id,
      displayName: "Manifest-Lion-1",
      body: "A semester goal",
      category: null,
      progressStatus: "achieved",
      badges: ["goal_achieved"],
      likeCount: 1,
      createdAt: `${today}T12:00:00.000Z`,
    },
  ]);
  assert.equal("editKey" in posts[0], false);
  assert.equal("status" in posts[0], false);
});

test("lists featured goals only from live posts without private fields", async () => {
  let query = "";
  const service = createPostsFeedService(async (sql) => {
    query = sql;
    return [row(1)];
  }, now);

  const posts = await service.listFeaturedPosts();

  assert.match(query, /WHERE p\.status = 'live' AND p\.featured_at IS NOT NULL/);
  assert.match(query, /ORDER BY p\.featured_at DESC, p\.id DESC/);
  assert.deepEqual(posts, [
    {
      id: row(1).id,
      displayName: "Manifest-Lion-1",
      body: "A semester goal",
      category: null,
      progressStatus: "not_started",
      badges: [],
      likeCount: 1,
      createdAt: `${today}T12:00:00.000Z`,
    },
  ]);
  assert.equal("status" in posts[0], false);
  assert.equal("featuredAt" in posts[0], false);
});

test("selects a random live post and returns null for an empty public feed", async () => {
  let query = "";
  const service = createPostsFeedService(async (sql) => {
    query = sql;
    return [row(1)];
  }, now);

  const post = await service.getRandomPost();

  assert.match(query, /WHERE p\.status = 'live'/);
  assert.match(query, /ORDER BY random\(\)\s+LIMIT 1/);
  assert.deepEqual(post, {
    id: row(1).id,
    displayName: "Manifest-Lion-1",
    body: "A semester goal",
    category: null,
    progressStatus: "not_started",
    badges: [],
    likeCount: 1,
    createdAt: `${today}T12:00:00.000Z`,
  });
  assert.equal(post && "status" in post, false);

  const emptyService = createPostsFeedService(async () => [], now);
  assert.equal(await emptyService.getRandomPost(), null);
});
