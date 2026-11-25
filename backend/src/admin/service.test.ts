import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import bcrypt from "bcryptjs";
import test from "node:test";
import {
  createAdminService,
  nextModerationStatus,
  nextLoginAttempt,
  normalizeAdminEmail,
} from "./service.js";
import type { AdminRole, BannedTerm } from "./types.js";

type TestModerator = {
  id: string;
  email: string;
  password_hash: string;
  role: AdminRole;
  active: boolean;
};

function fakePool(user: TestModerator | null): {
  pool: Pool;
  storedSession: () => { tokenHash: string; csrfHash: string } | null;
  auditEvents: () => unknown[][];
} {
  let session: { tokenHash: string; csrfHash: string } | null = null;
  let bannedTerms: BannedTerm[] = [];
  const categories = new Map<string, boolean>();
  const auditEvents: unknown[][] = [];
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      if (sql.includes("SELECT failed_attempts")) {
        return {
          rows: [
            {
              failed_attempts: 0,
              lockout_count: 0,
              window_started_at: new Date(),
              locked_until: null,
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("INSERT INTO admin_sessions")) {
        session = {
          tokenHash: String(values?.[0]),
          csrfHash: String(values?.[1]),
        };
      }
      if (
        sql.includes("DELETE FROM admin_sessions") &&
        sql.includes("RETURNING moderator_id")
      ) {
        const matched = session?.tokenHash === values?.[0];
        if (matched) {
          session = null;
        }
        return {
          rows: matched && user ? [{ moderator_id: user.id }] : [],
          rowCount: matched ? 1 : 0,
        };
      }
      if (sql.includes("DELETE FROM banned_terms")) {
        bannedTerms = [];
      }
      if (sql.includes("INSERT INTO banned_terms")) {
        const terms = values?.[0];
        const types = values?.[1];
        if (Array.isArray(terms) && Array.isArray(types)) {
          bannedTerms = terms.map((term, index) => ({
            term: String(term),
            type: String(types[index]),
          }));
        }
      }
      if (sql.includes("UPDATE goal_categories SET active = false")) {
        for (const slug of categories.keys()) {
          categories.set(slug, false);
        }
      }
      if (sql.includes("INSERT INTO goal_categories")) {
        const slugs = values?.[0];
        if (Array.isArray(slugs)) {
          for (const slug of slugs) {
            categories.set(String(slug), true);
          }
        }
      }
      if (sql.includes("INSERT INTO audit_logs")) {
        auditEvents.push(values ?? []);
      }
      return { rows: [], rowCount: 1 };
    },
    release: () => {},
  };
  const pool = {
    query: async (sql: string, values?: unknown[]) => {
      if (sql.includes("SELECT EXISTS")) {
        return { rows: [{ locked: false }], rowCount: 1 };
      }
      if (sql.includes("WITH expired_sessions")) {
        return { rows: [{ deleted: 3 }], rowCount: 1 };
      }
      if (sql.includes("FROM moderators") && sql.includes("WHERE email")) {
        return {
          rows: user?.email === values?.[0] ? [user] : [],
          rowCount: user?.email === values?.[0] ? 1 : 0,
        };
      }
      if (sql.includes("DELETE FROM admin_sessions")) {
        if (session?.tokenHash === values?.[0]) {
          session = null;
        }
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("FROM admin_sessions")) {
        const stored = session;
        const row =
          stored && stored.tokenHash === values?.[0] && user
            ? {
                id: user.id,
                role: user.role,
                csrfHash: stored.csrfHash,
              }
            : null;
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (sql.includes("FROM banned_terms")) {
        return { rows: bannedTerms, rowCount: bannedTerms.length };
      }
      if (sql.includes("FROM goal_categories")) {
        const rows = [...categories]
          .filter(([, active]) => active)
          .map(([slug]) => ({ slug }));
        return { rows, rowCount: rows.length };
      }
      throw new Error("Unexpected pool query");
    },
    connect: async () => client,
  } as unknown as Pool;

  return {
    pool,
    storedSession: () => session,
    auditEvents: () => auditEvents,
  };
}

test("normalizes administrator email identity", () => {
  assert.equal(normalizeAdminEmail("  Admin@EXAMPLE.com "), "admin@example.com");
  assert.equal(normalizeAdminEmail("ＡＤＭＩＮ@example.com"), "admin@example.com");
});

test("applies escalating login lockouts after five failures", () => {
  const now = 1_000_000;
  const firstLock = nextLoginAttempt(
    {
      failed_attempts: 4,
      lockout_count: 0,
      window_started_at: new Date(now - 1_000),
      locked_until: null,
    },
    now,
  );
  assert.ok(firstLock);
  assert.equal(firstLock.failures, 0);
  assert.equal(firstLock.lockoutCount, 1);
  assert.equal(firstLock.lockedUntil?.getTime(), now + 15 * 60 * 1000);

  const secondLock = nextLoginAttempt(
    {
      failed_attempts: 4,
      lockout_count: 1,
      window_started_at: new Date(now - 1_000),
      locked_until: new Date(now - 1),
    },
    now,
  );
  assert.ok(secondLock);
  assert.equal(secondLock.lockoutCount, 2);
  assert.equal(secondLock.lockedUntil?.getTime(), now + 30 * 60 * 1000);
});

test("applies configured admin login thresholds and lockout caps", () => {
  const now = 1_000_000;
  const next = nextLoginAttempt(
    {
      failed_attempts: 2,
      lockout_count: 1,
      window_started_at: new Date(now - 1_000),
      locked_until: null,
    },
    now,
    {
      failureLimit: 3,
      windowMs: 5 * 60 * 1000,
      initialLockoutMs: 60_000,
      maxLockoutMs: 120_000,
    },
  );
  assert.ok(next);
  assert.equal(next.failures, 0);
  assert.equal(next.lockoutCount, 2);
  assert.equal(next.lockedUntil?.getTime(), now + 120_000);
});

test("keeps locked identifiers locked and resets stale failure windows", () => {
  const now = 1_000_000;
  assert.equal(
    nextLoginAttempt(
      {
        failed_attempts: 0,
        lockout_count: 1,
        window_started_at: new Date(now),
        locked_until: new Date(now + 1_000),
      },
      now,
    ),
    null,
  );

  const next = nextLoginAttempt(
    {
      failed_attempts: 4,
      lockout_count: 0,
      window_started_at: new Date(now - 15 * 60 * 1000),
      locked_until: null,
    },
    now,
  );
  assert.deepEqual(next, {
    failures: 1,
    lockoutCount: 0,
    windowExpired: true,
    lockedUntil: null,
  });
});

test("permits only held approval and rejection, and rejected restoration", () => {
  assert.equal(nextModerationStatus("approve", "held"), "live");
  assert.equal(nextModerationStatus("reject", "held"), "rejected");
  assert.equal(nextModerationStatus("restore", "rejected"), "held");
  assert.throws(() => nextModerationStatus("approve", "live"), {
    message: "Post status does not allow this action",
  });
});

test("replaces the full banned-term list, including clearing it", async () => {
  const { pool, auditEvents } = fakePool(null);
  const service = createAdminService(pool, {
    ipHashSecret: "a-random-secret-with-at-least-32-characters",
  });
  const actorId = "00000000-0000-4000-8000-000000000003";
  const terms = [
    { term: "unhelpful-term", type: "custom" },
    { term: "another-term", type: "spam" },
  ];

  await service.replaceBannedTerms(terms, actorId);
  assert.deepEqual(await service.getBannedTerms(), terms);
  await service.replaceBannedTerms([], actorId);
  assert.deepEqual(await service.getBannedTerms(), []);
  assert.deepEqual(auditEvents(), [
    ["staff", actorId, "banned_terms_replaced", "banned_terms", null],
    ["staff", actorId, "banned_terms_replaced", "banned_terms", null],
  ]);
});

test("replaces available categories without deleting inactive values", async () => {
  const { pool, auditEvents } = fakePool(null);
  const service = createAdminService(pool, {
    ipHashSecret: "a-random-secret-with-at-least-32-characters",
  });
  const actorId = "00000000-0000-4000-8000-000000000003";

  await service.replaceCategories(["academic", "career"], actorId);
  assert.deepEqual(await service.getCategories(), ["academic", "career"]);
  await service.replaceCategories(["spiritual"], actorId);
  assert.deepEqual(await service.getCategories(), ["spiritual"]);
  await service.replaceCategories(["career", "spiritual"], actorId);
  assert.deepEqual(await service.getCategories(), ["career", "spiritual"]);
  assert.equal(auditEvents().length, 3);
  assert.deepEqual(auditEvents()[0], [
    "staff",
    actorId,
    "categories_replaced",
    "categories",
    null,
  ]);
});

test("features only live posts and allows unfeaturing hidden posts", async () => {
  const postId = "00000000-0000-4000-8000-000000000001";
  const actorId = "00000000-0000-4000-8000-000000000003";
  const queries: { sql: string; values?: unknown[] }[] = [];
  let status = "live";
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      queries.push({ sql, values });
      if (sql.includes("SELECT status FROM posts")) {
        return { rows: [{ status }], rowCount: 1 };
      }
      if (sql.includes("SELECT id FROM posts")) {
        return { rows: [{ id: postId }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
    release: () => {},
  };
  const pool = {
    connect: async () => client,
  } as unknown as Pool;
  const service = createAdminService(pool, {
    ipHashSecret: "a-random-secret-with-at-least-32-characters",
  });

  await service.featurePost(postId, actorId);
  assert.ok(
    queries.some(
      ({ sql }) =>
        sql.includes("SELECT status FROM posts") && sql.includes("FOR UPDATE"),
    ),
  );
  assert.ok(
    queries.some(({ sql }) => sql.includes("COALESCE(featured_at, now())")),
  );

  status = "hidden";
  await assert.rejects(
    service.featurePost(postId, actorId),
    /Only live posts can be featured/,
  );
  await service.unfeaturePost(postId, actorId);
  assert.ok(queries.some(({ sql }) => sql.includes("SET featured_at = NULL")));
  const auditValues = queries
    .filter(({ sql }) => sql.includes("INSERT INTO audit_logs"))
    .map(({ values }) => values);
  assert.deepEqual(auditValues, [
    ["staff", actorId, "post_featured", "post", postId],
    ["staff", actorId, "post_unfeatured", "post", postId],
  ]);
});

test("records approvals, rejections, restores, and undo actions", async () => {
  const postId = "00000000-0000-4000-8000-000000000001";
  const actorId = "00000000-0000-4000-8000-000000000003";
  let status = "held";
  let rejectedAt: Date | null = null;
  let nextActionId = 0;
  const moderationActions: {
    id: string;
    from_status: "held" | "live" | "rejected";
    to_status: "held" | "live" | "rejected";
    from_rejected_at: Date | null;
    to_rejected_at: Date | null;
    undone: boolean;
  }[] = [];
  const auditValues: unknown[][] = [];
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      if (sql.includes("SELECT id, status, rejected_at FROM posts")) {
        return {
          rows: [{ id: postId, status, rejected_at: rejectedAt }],
          rowCount: 1,
        };
      }
      if (sql.includes("UPDATE posts") && sql.includes("RETURNING rejected_at")) {
        status = String(values?.[1]);
        rejectedAt = status === "rejected" ? new Date("2026-01-01T00:00:00Z") : null;
        return { rows: [{ rejected_at: rejectedAt }], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO moderation_actions")) {
        moderationActions.push({
          id: String(++nextActionId),
          from_status: values?.[3] as "held" | "live" | "rejected",
          to_status: values?.[4] as "held" | "live" | "rejected",
          from_rejected_at: values?.[5] as Date | null,
          to_rejected_at: values?.[6] as Date | null,
          undone: false,
        });
      }
      if (sql.includes("SELECT id, from_status, to_status")) {
        const action = [...moderationActions].reverse().find((item) => !item.undone);
        return { rows: action ? [action] : [], rowCount: action ? 1 : 0 };
      }
      if (sql.includes("UPDATE posts") && !sql.includes("RETURNING rejected_at")) {
        status = String(values?.[1]);
        rejectedAt = (values?.[2] as Date | null) ?? null;
      }
      if (sql.includes("UPDATE moderation_actions SET undone_at")) {
        const action = moderationActions.find((item) => item.id === values?.[0]);
        if (action) {
          action.undone = true;
        }
      }
      if (sql.includes("INSERT INTO audit_logs")) {
        auditValues.push(values ?? []);
      }
      return { rows: [], rowCount: 1 };
    },
    release: () => {},
  };
  const pool = {
    connect: async () => client,
  } as unknown as Pool;
  const service = createAdminService(pool, {
    ipHashSecret: "a-random-secret-with-at-least-32-characters",
  });

  await service.approvePost(postId, actorId);
  await service.undoModeration(postId, actorId);
  await service.rejectPost(postId, actorId);
  await service.restoreRejectedPost(postId, actorId);

  assert.deepEqual(
    auditValues.map((values) => values[2]),
    [
      "post_approved",
      "moderation_undone",
      "post_rejected",
      "post_restored",
    ],
  );
  assert.ok(auditValues.every((values) => values[0] === "staff" && values[1] === actorId));
});

test("records moderator creation and deactivation", async () => {
  const actorId = "00000000-0000-4000-8000-000000000003";
  const targetId = "00000000-0000-4000-8000-000000000004";
  const auditValues: unknown[][] = [];
  let active = true;
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      if (sql.includes("INSERT INTO moderators")) {
        return {
          rows: [
            {
              id: targetId,
              email: "mod@example.com",
              role: "moderator",
              active: true,
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("SELECT id, role, active FROM moderators")) {
        return {
          rows: [
            {
              id: targetId,
              role: "moderator",
              active,
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("UPDATE moderators SET active = false")) {
        active = false;
      }
      if (sql.includes("INSERT INTO audit_logs")) {
        auditValues.push(values ?? []);
      }
      return { rows: [], rowCount: 1 };
    },
    release: () => {},
  };
  const pool = {
    connect: async () => client,
  } as unknown as Pool;
  const service = createAdminService(pool, {
    ipHashSecret: "a-random-secret-with-at-least-32-characters",
  });

  await service.createModerator(
    "mod@example.com",
    "A-long-test-password-123",
    "moderator",
    actorId,
  );
  await service.deleteModerator(targetId, actorId);

  assert.deepEqual(auditValues, [
    ["staff", actorId, "moderator_created", "moderator", targetId],
    ["staff", actorId, "moderator_deactivated", "moderator", targetId],
  ]);
});

test("records scheduled post purges as system actions", async () => {
  let query = "";
  const pool = {
    query: async (sql: string) => {
      query = sql;
      return { rows: [{ deleted: 2 }], rowCount: 1 };
    },
  } as unknown as Pool;
  const service = createAdminService(pool, {
    ipHashSecret: "a-random-secret-with-at-least-32-characters",
  });

  assert.equal(await service.purgeRejectedPosts(), 2);
  assert.match(query, /DELETE FROM posts/);
  assert.match(query, /INSERT INTO audit_logs/);
  assert.match(query, /SELECT 'system', 'post_purged', 'post', id/);
});

test("purges expired admin sessions and stale login lockouts", async () => {
  let query = "";
  const pool = {
    query: async (sql: string) => {
      query = sql;
      return { rows: [{ deleted: 3 }], rowCount: 1 };
    },
  } as unknown as Pool;
  const service = createAdminService(pool, {
    ipHashSecret: "a-random-secret-with-at-least-32-characters",
  });

  assert.equal(await service.purgeExpiredAuthData(), 3);
  assert.match(query, /DELETE FROM admin_sessions[\s\S]*expires_at <= now\(\)/);
  assert.match(query, /DELETE FROM admin_login_attempts[\s\S]*interval '30 days'/);
});

test("archives an open semester and records the acting administrator", async () => {
  const semesterId = "00000000-0000-4000-8000-000000000002";
  const actorId = "00000000-0000-4000-8000-000000000001";
  const queries: { sql: string; values?: unknown[] }[] = [];
  let state = "open";
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      queries.push({ sql, values });
      if (sql.includes("SELECT state FROM semesters")) {
        return { rows: [{ state }], rowCount: 1 };
      }
      if (sql.includes("UPDATE semesters SET state = 'closed'")) {
        state = "closed";
      }
      return { rows: [], rowCount: 1 };
    },
    release: () => {},
  };
  const pool = {
    connect: async () => client,
  } as unknown as Pool;
  const service = createAdminService(pool, {
    ipHashSecret: "a-random-secret-with-at-least-32-characters",
  });

  await service.archiveSemester(semesterId, actorId);
  assert.match(queries[1].sql, /FOR UPDATE/);
  assert.deepEqual(queries.at(-2)?.values, [
    "staff",
    actorId,
    "semester_archived",
    "semester",
    semesterId,
  ]);
  assert.equal(queries.some((query) => query.sql === "COMMIT"), true);

  await assert.rejects(
    service.archiveSemester(semesterId, actorId),
    /Semester is already archived/,
  );
  assert.equal(
    queries.filter((query) => query.sql.includes("INSERT INTO audit_logs")).length,
    1,
  );
});

test("returns only aggregate analytics and applies a semester filter", async () => {
  const semesterId = "00000000-0000-4000-8000-000000000002";
  const queries: { sql: string; values?: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, values?: unknown[]) => {
      queries.push({ sql, values });
      return {
        rows: [
          {
            posts: "10",
            likes: "20",
            reports: "3",
            achievedGoals: "2",
            live: "6",
            held: "1",
            hidden: "1",
            rejected: "1",
            removed: "1",
          },
        ],
        rowCount: 1,
      };
    },
  } as unknown as Pool;
  const service = createAdminService(pool, {
    ipHashSecret: "a-random-secret-with-at-least-32-characters",
  });

  assert.deepEqual(await service.getAnalytics(semesterId), {
    semesterId,
    totals: { posts: 10, likes: 20, reports: 3, achievedGoals: 2 },
    moderation: { live: 6, held: 1, hidden: 1, rejected: 1, removed: 1 },
  });
  assert.equal(queries[0].values?.[0], semesterId);
  assert.match(queries[0].sql, /semester_id = \$1::uuid/);
  assert.doesNotMatch(queries[0].sql, /device_id|ip_hash|display_name|email/i);
});

test("uses bcrypt credentials and stores only session token hashes", async () => {
  const user = {
    id: "00000000-0000-4000-8000-000000000001",
    email: "admin@example.com",
    password_hash: await bcrypt.hash("A-long-test-password-123", 4),
    role: "admin" as const,
    active: true,
  };
  const { pool, storedSession } = fakePool(user);
  const service = createAdminService(pool, {
    ipHashSecret: "a-random-secret-with-at-least-32-characters",
  });
  const session = await service.login(
    "ADMIN@example.com",
    "A-long-test-password-123",
    "192.0.2.1",
  );
  const stored = storedSession();

  assert.match(session.sessionToken, /^[A-Za-z0-9_-]{43}$/);
  assert.match(session.csrfToken, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(stored, {
    tokenHash: createHash("sha256").update(session.sessionToken).digest("hex"),
    csrfHash: createHash("sha256").update(session.csrfToken).digest("hex"),
  });
  assert.deepEqual(await service.getSession(session.sessionToken), {
    id: user.id,
    role: "admin",
    csrfHash: stored?.csrfHash,
  });
});

test("login and logout audit session events without credentials", async () => {
  const user = {
    id: "00000000-0000-4000-8000-000000000001",
    email: "admin@example.com",
    password_hash: await bcrypt.hash("A-long-test-password-123", 4),
    role: "admin" as const,
    active: true,
  };
  const { pool, storedSession, auditEvents } = fakePool(user);
  const service = createAdminService(pool, {
    ipHashSecret: "a-random-secret-with-at-least-32-characters",
  });
  const session = await service.login(
    "admin@example.com",
    "A-long-test-password-123",
    "192.0.2.1",
  );
  const tokenHash = createHash("sha256").update(session.sessionToken).digest("hex");

  await service.logout(session.sessionToken);

  assert.equal(storedSession(), null);
  assert.equal(await service.getSession(session.sessionToken), null);
  assert.notEqual(tokenHash, session.sessionToken);
  assert.deepEqual(
    auditEvents().map((values) => values[2]),
    ["admin_login_succeeded", "admin_logout"],
  );
  assert.equal(
    auditEvents().flat().includes(session.sessionToken),
    false,
  );
  assert.equal(auditEvents().flat().includes(user.email), false);
});

test("returns the same authentication error for unknown email and wrong password", async () => {
  const user = {
    id: "00000000-0000-4000-8000-000000000001",
    email: "admin@example.com",
    password_hash: await bcrypt.hash("A-long-test-password-123", 4),
    role: "admin" as const,
    active: true,
  };
  const errors: string[] = [];
  const auditRecords: unknown[][] = [];

  for (const [email, password, account] of [
    ["missing@example.com", "A-long-test-password-123", user],
    ["admin@example.com", "Wrong-long-password-123", user],
  ] as const) {
    const { pool, auditEvents } = fakePool(account);
    const service = createAdminService(pool, {
      ipHashSecret: "a-random-secret-with-at-least-32-characters",
    });
    await assert.rejects(
      service.login(email, password, "192.0.2.2"),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, "Invalid email or password");
        errors.push(error.message);
        return true;
      },
    );
    auditRecords.push(...auditEvents());
  }
  assert.deepEqual(errors, ["Invalid email or password", "Invalid email or password"]);
  assert.deepEqual(
    auditRecords.map((values) => values[2]),
    ["admin_login_failed", "admin_login_failed"],
  );
  assert.equal(
    auditRecords.flat().some((value) =>
      ["missing@example.com", "admin@example.com", "192.0.2.2", "Wrong-long-password-123"].includes(
        String(value),
      ),
    ),
    false,
  );
});

test("records authorization denials with safe metadata", async () => {
  const actorId = "00000000-0000-4000-8000-000000000003";
  const { pool, auditEvents } = fakePool(null);
  const service = createAdminService(pool, {
    ipHashSecret: "a-random-secret-with-at-least-32-characters",
  });

  await service.recordAuthorizationFailure(actorId);

  assert.deepEqual(auditEvents(), [
    [
      "staff",
      actorId,
      "authorization_denied",
      "auth",
      null,
      "failure",
      { scope: "admin" },
    ],
  ]);
});
