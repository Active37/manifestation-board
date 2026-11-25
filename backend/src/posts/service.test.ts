import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import test from "node:test";
import {
  createPostsService,
  hasValidEditKey,
  hashRateLimitSubject,
  shouldHideAfterReports,
  statusAfterEdit,
} from "./service.js";

test("HMACs rate-limit identifiers without storing raw values", () => {
  const ipHash = hashRateLimitSubject(
    "a-random-secret-with-at-least-32-characters",
    "ip",
    "192.0.2.10",
  );
  const deviceHash = hashRateLimitSubject(
    "a-random-secret-with-at-least-32-characters",
    "device",
    "192.0.2.10",
  );

  assert.match(ipHash, /^[a-f0-9]{64}$/);
  assert.notEqual(ipHash, "192.0.2.10");
  assert.notEqual(ipHash, deviceHash);
});

test("stores keyed device hashes instead of cookie tokens for likes and reports", async () => {
  const secret = "a-random-secret-with-at-least-32-characters";
  const deviceId = "cookie-token-that-must-not-be-stored";
  const queries: { sql: string; values?: unknown[] }[] = [];
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      queries.push({ sql, values });
      if (sql.includes("INSERT INTO post_rate_limits")) {
        return { rows: [{ request_count: 1 }], rowCount: 1 };
      }
      if (sql.includes("JOIN semesters s")) {
        return {
          rows: [{ status: "live", semester_state: "open" }],
          rowCount: 1,
        };
      }
      if (sql.includes("UPDATE posts SET report_count")) {
        return { rows: [{ report_count: 1 }], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO likes") || sql.includes("INSERT INTO reports")) {
        return { rows: [{ post_id: "post-id" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };
  const service = createPostsService(
    { connect: async () => client } as unknown as Pool,
    {
      ipHashSecret: secret,
      postsPerHour: 3,
      likesPerMinute: 30,
      reportsPerHour: 5,
    },
  );

  await service.addLike("post-id", deviceId, "192.0.2.1");
  await service.reportPost("post-id", deviceId, "192.0.2.1", "spam", null);

  const likeInsert = queries.find(({ sql }) => sql.includes("INSERT INTO likes"));
  const reportInsert = queries.find(({ sql }) => sql.includes("INSERT INTO reports"));
  const storedHash = hashRateLimitSubject(secret, "device", deviceId);
  assert.deepEqual(likeInsert?.values, ["post-id", storedHash]);
  assert.deepEqual(reportInsert?.values, ["post-id", storedHash, "spam", null]);
  assert.match(likeInsert?.sql ?? "", /device_id_hash_version/);
  assert.match(reportInsert?.sql ?? "", /device_id_hash_version/);
  assert.equal(
    queries.some((query) => query.values?.includes(deviceId)),
    false,
  );
});

test("rate-limits post attempts using only HMACed device and IP identifiers", async () => {
  const secret = "a-random-secret-with-at-least-32-characters";
  const deviceId = "device-1";
  const ip = "192.0.2.1";
  const queries: { sql: string; values?: unknown[] }[] = [];
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      queries.push({ sql, values });
      return { rows: [{ request_count: 1 }], rowCount: 1 };
    },
    release: () => {},
  };
  const pool = {
    connect: async () => client,
  } as unknown as Pool;
  const service = createPostsService(pool, {
    ipHashSecret: secret,
    postsPerHour: 3,
    likesPerMinute: 30,
    reportsPerHour: 5,
  });

  await service.checkPostRateLimit(deviceId, ip);

  assert.equal(queries.length, 4);
  assert.deepEqual(queries[1]?.values, [
    "post",
    "device",
    hashRateLimitSubject(secret, "device", deviceId),
    3,
    "hour",
  ]);
  assert.deepEqual(queries[2]?.values, [
    "post",
    "ip",
    hashRateLimitSubject(secret, "ip", ip),
    3,
    "hour",
  ]);
  assert.equal(
    queries.some((query) => query.values?.includes(deviceId) || query.values?.includes(ip)),
    false,
  );
});

test("rate-limits name checks by HMACed IP in the shared database store", async () => {
  const secret = "a-random-secret-with-at-least-32-characters";
  const ip = "192.0.2.11";
  const queries: { sql: string; values?: unknown[] }[] = [];
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      queries.push({ sql, values });
      return { rows: [{ request_count: 1 }], rowCount: 1 };
    },
    release: () => {},
  };
  const service = createPostsService(
    { connect: async () => client } as unknown as Pool,
    {
      ipHashSecret: secret,
      postsPerHour: 3,
      likesPerMinute: 30,
      reportsPerHour: 5,
      namesPerMinute: 12,
    },
  );

  await service.checkNameRateLimit(ip);

  assert.deepEqual(queries[1]?.values, [
    "name",
    "ip",
    hashRateLimitSubject(secret, "ip", ip),
    12,
    "minute",
  ]);
  assert.equal(
    queries.some((query) => query.values?.includes(ip)),
    false,
  );
});

test("applies progressive temporary blocks after rate-limit violations", async () => {
  const secret = "a-random-secret-with-at-least-32-characters";
  const queries: { sql: string; values?: unknown[] }[] = [];
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      queries.push({ sql, values });
      return {
        rows: [],
        rowCount: sql.includes("INSERT INTO post_rate_limits") ? 0 : 1,
      };
    },
    release: () => {},
  };
  const service = createPostsService(
    { connect: async () => client } as unknown as Pool,
    {
      ipHashSecret: secret,
      postsPerHour: 3,
      likesPerMinute: 30,
      reportsPerHour: 5,
    },
  );

  await assert.rejects(service.checkPostRateLimit("device-1", "192.0.2.1"), {
    statusCode: 429,
  });

  const blocks = queries.filter((query) =>
    query.sql.includes("SET violation_count"),
  );
  assert.equal(blocks.length, 2);
  assert.ok(blocks.every((query) => query.sql.includes("blocked_until")));
  assert.ok(blocks.every((query) => !query.values?.includes("device-1")));
  assert.ok(blocks.every((query) => !query.values?.includes("192.0.2.1")));
});

test("audits rate-limit violations without recording IP or device hashes", async () => {
  const secret = "a-random-secret-with-at-least-32-characters";
  const ip = "192.0.2.21";
  const queries: { sql: string; values?: unknown[] }[] = [];
  let violationCount = 0;
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      queries.push({ sql, values });
      if (sql.includes("INSERT INTO post_rate_limits")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("UPDATE post_rate_limits")) {
        violationCount = Math.min(violationCount + 1, 8);
        return { rows: [{ violation_count: violationCount }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
    release: () => {},
  };
  const service = createPostsService(
    { connect: async () => client } as unknown as Pool,
    {
      ipHashSecret: secret,
      postsPerHour: 3,
      likesPerMinute: 30,
      reportsPerHour: 5,
      namesPerMinute: 12,
    },
  );

  for (let attempt = 0; attempt < 10; attempt += 1) {
    await assert.rejects(service.checkNameRateLimit(ip), {
      statusCode: 429,
    });
  }

  const audits = queries.filter(({ sql }) => sql.includes("INSERT INTO audit_logs"));
  assert.deepEqual(
    audits.map(({ values }) => values?.[6]),
    [1, 3, 7].map((count) => ({
      action: "name",
      subjectType: "ip",
      violationCount: count,
    })),
  );
  assert.equal(
    audits.some(({ values }) =>
      values?.some((value) =>
        [ip, hashRateLimitSubject(secret, "ip", ip)].includes(String(value)),
      ),
    ),
    false,
  );
});

test("rejects a previously consumed CAPTCHA token digest before post queries", async () => {
  const statements: string[] = [];
  const client = {
    query: async (sql: string) => {
      statements.push(sql);
      return {
        rows: [],
        rowCount: sql.includes("INSERT INTO used_captcha_tokens") ? 0 : 1,
      };
    },
    release: () => {},
  };
  const service = createPostsService(
    { connect: async () => client } as unknown as Pool,
    {
      ipHashSecret: "a-random-secret-with-at-least-32-characters",
      postsPerHour: 3,
      likesPerMinute: 30,
      reportsPerHour: 5,
    },
  );

  await assert.rejects(
    service.createPost(
      { displayName: "Jill", body: "A goal", category: null },
      "a".repeat(64),
    ),
    /CAPTCHA verification failed/,
  );
  assert.equal(statements.some((sql) => sql.includes("FROM semesters")), false);
  assert.ok(statements.includes("ROLLBACK"));
});

test("re-filters active posts but preserves moderation states", () => {
  assert.equal(statusAfterEdit("live", true), "held");
  assert.equal(statusAfterEdit("held", false), "live");
  assert.equal(statusAfterEdit("hidden", false), "hidden");
  assert.equal(statusAfterEdit("rejected", true), "rejected");
  assert.equal(statusAfterEdit("removed", false), "removed");
});

test("validates an edit key against its stored hash", () => {
  const key = "A".repeat(43);
  const storedHash = createHash("sha256").update(key).digest("hex");

  assert.equal(hasValidEditKey(storedHash, key), true);
  assert.equal(hasValidEditKey(storedHash, "B".repeat(43)), false);
  assert.equal(hasValidEditKey(undefined, key), false);
});

test("auto-hides after the third unique report", () => {
  assert.equal(shouldHideAfterReports(1), false);
  assert.equal(shouldHideAfterReports(2), false);
  assert.equal(shouldHideAfterReports(3), true);
  assert.equal(shouldHideAfterReports(4), true);
});

test("owner progress updates preserve moderation status and require the edit key", async () => {
  const postId = "00000000-0000-4000-8000-000000000001";
  const editKey = "A".repeat(43);
  const editKeyHash = createHash("sha256").update(editKey).digest("hex");
  const queries: { sql: string; values?: unknown[] }[] = [];
  const awardedBadges = new Set<string>();
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      queries.push({ sql, values });
      if (sql.includes("SELECT id, display_name")) {
        return {
          rows: [
            {
              id: postId,
              display_name: "Manifest-Lion-482",
              body: "A goal",
              category: null,
              status: "held",
              edit_key_hash: editKeyHash,
              semester_id: "00000000-0000-4000-8000-000000000002",
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("SELECT state FROM semesters")) {
        return { rows: [{ state: "open" }], rowCount: 1 };
      }
      if (sql.includes("RETURNING progress_status")) {
        return { rows: [{ progressStatus: values?.[1] }], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO post_badges")) {
        awardedBadges.add(String(values?.[0]));
      }
      if (sql.includes("SELECT badge_type FROM post_badges")) {
        const rows = awardedBadges.has(postId)
          ? [{ badge_type: "goal_achieved" }]
          : [];
        return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: 1 };
    },
    release: () => {},
  };
  const pool = {
    connect: async () => client,
  } as unknown as Pool;
  const service = createPostsService(pool, {
    ipHashSecret: "a-random-secret-with-at-least-32-characters",
    postsPerHour: 3,
    likesPerMinute: 30,
    reportsPerHour: 5,
  });

  assert.deepEqual(await service.updateProgress(postId, editKey, "achieved"), {
    progressStatus: "achieved",
    badges: ["goal_achieved"],
  });
  assert.deepEqual(await service.updateProgress(postId, editKey, "in_progress"), {
    progressStatus: "in_progress",
    badges: ["goal_achieved"],
  });
  assert.deepEqual(await service.updateProgress(postId, editKey, "achieved"), {
    progressStatus: "achieved",
    badges: ["goal_achieved"],
  });
  assert.equal(
    queries.filter((query) => query.sql.includes("INSERT INTO post_badges")).length,
    2,
  );
  assert.ok(
    queries
      .filter((query) => query.sql.includes("INSERT INTO post_badges"))
      .every((query) => query.sql.includes("ON CONFLICT (post_id, badge_type) DO NOTHING")),
  );
  const progressUpdate = queries.find((query) =>
    query.sql.includes("SET progress_status"),
  );
  assert.ok(progressUpdate);
  assert.match(progressUpdate.sql, /SET progress_status = \$2/);
  assert.doesNotMatch(progressUpdate.sql, /\bstatus\s*=/);
  assert.deepEqual(progressUpdate.values, [postId, "achieved"]);

  await assert.rejects(
    service.updateProgress(postId, "B".repeat(43), "in_progress"),
    /Post not found/,
  );
  assert.equal(
    queries.filter((query) => query.sql.includes("SET progress_status")).length,
    3,
  );
});

test("validates assigned categories against the active catalog", async () => {
  const postId = "00000000-0000-4000-8000-000000000001";
  const editKey = "A".repeat(43);
  const editKeyHash = createHash("sha256").update(editKey).digest("hex");
  const queries: { sql: string; values?: unknown[] }[] = [];
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      queries.push({ sql, values });
      if (sql.includes("INSERT INTO post_rate_limits")) {
        return { rows: [{ request_count: 1 }], rowCount: 1 };
      }
      if (sql.includes("SELECT id FROM semesters")) {
        return {
          rows: [{ id: "00000000-0000-4000-8000-000000000002" }],
          rowCount: 1,
        };
      }
      if (sql.includes("SELECT slug FROM goal_categories")) {
        const row = values?.[0] === "academic" ? [{ slug: "academic" }] : [];
        return { rows: row, rowCount: row.length };
      }
      if (sql.includes("SELECT state FROM semesters")) {
        return { rows: [{ state: "open" }], rowCount: 1 };
      }
      if (sql.includes("SELECT term FROM banned_terms")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("SELECT id, display_name")) {
        return {
          rows: [
            {
              id: postId,
              display_name: "Manifest-Lion-482",
              body: "A goal",
              category: "academic",
              status: "live",
              edit_key_hash: editKeyHash,
              semester_id: "00000000-0000-4000-8000-000000000002",
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("INSERT INTO posts")) {
        return {
          rows: [
            {
              id: postId,
              displayName: "Manifest-Lion-482",
              body: "A goal",
              category: values?.[3],
              progressStatus: "not_started",
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    },
    release: () => {},
  };
  const pool = {
    connect: async () => client,
  } as unknown as Pool;
  const service = createPostsService(pool, {
    ipHashSecret: "a-random-secret-with-at-least-32-characters",
    postsPerHour: 3,
    likesPerMinute: 30,
    reportsPerHour: 5,
  });

  const created = await service.createPost(
    {
      displayName: "Manifest-Lion-482",
      body: "A goal",
      category: "academic",
    },
    createHash("sha256").update("one-time-test-token").digest("hex"),
  );
  assert.equal(created.category, "academic");
  assert.ok(
    queries.some(
      (query) =>
        query.sql.includes("goal_categories") && query.sql.includes("FOR SHARE"),
    ),
  );

  await assert.rejects(
    service.patchPost(postId, editKey, { category: "career" }),
    /Invalid post category/,
  );
  assert.equal(
    queries.filter((query) => query.sql.includes("UPDATE posts")).length,
    0,
  );
});

test("clears a feature when an edit moves a live post back to moderation", async () => {
  const postId = "00000000-0000-4000-8000-000000000001";
  const editKey = "A".repeat(43);
  const editKeyHash = createHash("sha256").update(editKey).digest("hex");
  let update: { sql: string; values?: unknown[] } | undefined;
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      if (sql.includes("SELECT id, display_name")) {
        return {
          rows: [
            {
              id: postId,
              display_name: "Manifest-Lion-482",
              body: "A goal",
              category: "academic",
              status: "live",
              edit_key_hash: editKeyHash,
              semester_id: "00000000-0000-4000-8000-000000000002",
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("SELECT state FROM semesters")) {
        return { rows: [{ state: "open" }], rowCount: 1 };
      }
      if (sql.includes("SELECT term FROM banned_terms")) {
        return { rows: [{ term: "flag" }], rowCount: 1 };
      }
      if (sql.includes("SET display_name = $2")) {
        update = { sql, values };
        return {
          rows: [
            {
              id: postId,
              displayName: "Manifest-Lion-482",
              body: "flag this goal",
              category: "academic",
              progressStatus: "not_started",
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    },
    release: () => {},
  };
  const pool = {
    connect: async () => client,
  } as unknown as Pool;
  const service = createPostsService(pool, {
    ipHashSecret: "a-random-secret-with-at-least-32-characters",
    postsPerHour: 3,
    likesPerMinute: 30,
    reportsPerHour: 5,
  });

  await service.patchPost(postId, editKey, { body: "flag this goal" });

  assert.ok(update);
  assert.equal(update.values?.[5], "held");
  assert.match(update.sql, /featured_at = CASE WHEN \$6 = 'live' THEN featured_at ELSE NULL END/);
});

test("records owner deletions without storing the edit key", async () => {
  const postId = "00000000-0000-4000-8000-000000000001";
  const editKey = "A".repeat(43);
  const editKeyHash = createHash("sha256").update(editKey).digest("hex");
  let auditValues: unknown[] | undefined;
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      if (sql.includes("SELECT id, display_name")) {
        return {
          rows: [
            {
              id: postId,
              display_name: "Manifest-Lion-482",
              body: "A goal",
              category: null,
              status: "live",
              edit_key_hash: editKeyHash,
              semester_id: "00000000-0000-4000-8000-000000000002",
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("SELECT state FROM semesters")) {
        return { rows: [{ state: "open" }], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO audit_logs")) {
        auditValues = values;
      }
      return { rows: [], rowCount: 1 };
    },
    release: () => {},
  };
  const pool = {
    connect: async () => client,
  } as unknown as Pool;
  const service = createPostsService(pool, {
    ipHashSecret: "a-random-secret-with-at-least-32-characters",
    postsPerHour: 3,
    likesPerMinute: 30,
    reportsPerHour: 5,
  });

  await service.deletePost(postId, editKey);

  assert.deepEqual(auditValues, [
    "anonymous_owner",
    null,
    "post_removed",
    "post",
    postId,
  ]);
  assert.equal(auditValues?.includes(editKey), false);
});

test("lists closed semesters and paginates only live public posts", async () => {
  const semesterId = "00000000-0000-4000-8000-000000000002";
  const otherSemesterId = "00000000-0000-4000-8000-000000000004";
  const unarchivedSemesterId = "00000000-0000-4000-8000-000000000005";
  const queries: { sql: string; values?: unknown[] }[] = [];
  const archiveRows = Array.from({ length: 31 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    displayName: `Manifest-Lion-${index + 1}`,
    body: "A semester goal",
    category: null,
    progressStatus: "achieved",
    likeCount: 2,
    badges: ["goal_achieved"],
    createdAt: new Date("2026-06-01T12:00:00.123Z"),
    cursorCreatedAt: "2026-06-01T12:00:00.123456Z",
  }));
  const pool = {
    query: async (sql: string, values?: unknown[]) => {
      queries.push({ sql, values });
      if (sql.includes("FROM semesters") && sql.includes("state = 'closed'")) {
        if (sql.includes("SELECT id FROM")) {
          const found = values?.[0] !== unarchivedSemesterId;
          return {
            rows: found ? [{ id: values?.[0] }] : [],
            rowCount: found ? 1 : 0,
          };
        }
        return {
          rows: [
            { id: semesterId, name: "Semester 1", endsOn: "2026-06-30" },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM posts p")) {
        return {
          rows: values?.[1] ? [] : archiveRows,
          rowCount: values?.[1] ? 0 : archiveRows.length,
        };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
  const service = createPostsService(pool, {
    ipHashSecret: "a-random-secret-with-at-least-32-characters",
    postsPerHour: 3,
    likesPerMinute: 30,
    reportsPerHour: 5,
  });

  assert.deepEqual(await service.listArchivedSemesters(), [
    { id: semesterId, name: "Semester 1", endsOn: "2026-06-30" },
  ]);
  const firstPage = await service.listArchivedSemesterPosts(semesterId);
  assert.equal(firstPage.posts.length, 30);
  assert.ok(firstPage.nextCursor);
  assert.deepEqual(firstPage.posts[0]?.badges, ["goal_achieved"]);
  assert.equal("status" in firstPage.posts[0], false);
  assert.equal("editKey" in firstPage.posts[0], false);
  const postsQuery = queries.find((query) => query.sql.includes("FROM posts p"));
  assert.match(postsQuery?.sql ?? "", /p\.status = 'live'/);
  assert.match(postsQuery?.sql ?? "", /p\.semester_id = \$1/);
  assert.doesNotMatch(postsQuery?.sql ?? "", /device_id|edit_key_hash|report_count/);
  assert.equal(postsQuery?.values?.[0], semesterId);
  assert.equal(postsQuery?.values?.[3], 31);

  await service.listArchivedSemesterPosts(semesterId, firstPage.nextCursor ?? "");
  const nextQuery = queries.filter((query) => query.sql.includes("FROM posts p"))[1];
  assert.equal(nextQuery?.values?.[0], semesterId);
  assert.equal(nextQuery?.values?.[1], "2026-06-01T12:00:00.123456Z");
  assert.equal(nextQuery?.values?.[2], archiveRows[29]?.id);

  const postsQueryCount = queries.filter((query) =>
    query.sql.includes("FROM posts p"),
  ).length;
  await assert.rejects(
    service.listArchivedSemesterPosts(otherSemesterId, firstPage.nextCursor ?? ""),
    /Invalid archive cursor/,
  );
  await assert.rejects(
    service.listArchivedSemesterPosts(unarchivedSemesterId),
    /Archived semester not found/,
  );
  assert.equal(
    queries.filter((query) => query.sql.includes("FROM posts p")).length,
    postsQueryCount,
  );
});

test("prevents owner changes to archived semester posts", async () => {
  const postId = "00000000-0000-4000-8000-000000000001";
  const semesterId = "00000000-0000-4000-8000-000000000002";
  const editKey = "A".repeat(43);
  const editKeyHash = createHash("sha256").update(editKey).digest("hex");
  const queries: string[] = [];
  const client = {
    query: async (sql: string) => {
      queries.push(sql);
      if (sql.includes("SELECT id, display_name")) {
        return {
          rows: [
            {
              id: postId,
              display_name: "Manifest-Lion-482",
              body: "A goal",
              category: null,
              status: "live",
              edit_key_hash: editKeyHash,
              semester_id: semesterId,
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("SELECT state FROM semesters")) {
        return { rows: [{ state: "closed" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
    release: () => {},
  };
  const pool = {
    connect: async () => client,
  } as unknown as Pool;
  const service = createPostsService(pool, {
    ipHashSecret: "a-random-secret-with-at-least-32-characters",
    postsPerHour: 3,
    likesPerMinute: 30,
    reportsPerHour: 5,
  });

  await assert.rejects(
    service.patchPost(postId, editKey, { body: "Changed" }),
    /Archived semesters are read-only/,
  );
  await assert.rejects(
    service.updateProgress(postId, editKey, "achieved"),
    /Archived semesters are read-only/,
  );
  await assert.rejects(
    service.deletePost(postId, editKey),
    /Archived semesters are read-only/,
  );
  assert.equal(queries.some((sql) => sql.includes("UPDATE posts")), false);
});

test("prevents likes and reports from changing archived semester posts", async () => {
  const queries: string[] = [];
  const client = {
    query: async (sql: string) => {
      queries.push(sql);
      if (sql.includes("INSERT INTO post_rate_limits")) {
        return { rows: [{ request_count: 1 }], rowCount: 1 };
      }
      if (sql.includes("JOIN semesters s")) {
        return {
          rows: [{ id: "00000000-0000-4000-8000-000000000001", status: "live", semester_state: "closed" }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    },
    release: () => {},
  };
  const pool = {
    connect: async () => client,
  } as unknown as Pool;
  const service = createPostsService(pool, {
    ipHashSecret: "a-random-secret-with-at-least-32-characters",
    postsPerHour: 3,
    likesPerMinute: 30,
    reportsPerHour: 5,
  });

  await assert.rejects(
    service.addLike("post-id", "device-1", "192.0.2.1"),
    /Archived semesters are read-only/,
  );
  await assert.rejects(
    service.removeLike("post-id", "device-1", "192.0.2.1"),
    /Archived semesters are read-only/,
  );
  await assert.rejects(
    service.reportPost("post-id", "device-1", "192.0.2.1", "spam", null),
    /Archived semesters are read-only/,
  );
  assert.equal(
    queries.some((sql) =>
      /(?:INSERT INTO likes|DELETE FROM likes|INSERT INTO reports)/.test(sql),
    ),
    false,
  );
});
