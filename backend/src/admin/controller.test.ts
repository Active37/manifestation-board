import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import express from "express";
import test from "node:test";
import { adminRouter } from "./controller.js";
import type { AdminApi } from "./types.js";
import { errorMiddleware } from "../errors.js";

const origin = "https://admin.example";
const sessionToken = "A".repeat(43);
const csrfToken = "B".repeat(43);
const sessionCookie = `__Host-admin_session=${sessionToken}`;
const csrfHash = createHash("sha256").update(csrfToken).digest("hex");
const moderatorId = "00000000-0000-4000-8000-000000000001";

const defaultApi: AdminApi = {
  login: async () => ({ sessionToken, csrfToken }),
  getSession: async () => ({
    id: moderatorId,
    role: "admin",
    csrfHash,
  }),
  logout: async () => {},
  recordAuthorizationFailure: async () => {},
  listModerators: async () => [
    { id: moderatorId, email: "admin@example.com", role: "admin", active: true },
  ],
  createModerator: async (email, _password, role) => ({
    id: moderatorId,
    email,
    role,
    active: true,
  }),
  deleteModerator: async () => {},
  getModerationQueue: async () => [],
  getRejectedPosts: async () => [],
  approvePost: async () => {},
  rejectPost: async () => {},
  undoModeration: async () => {},
  restoreRejectedPost: async () => {},
  purgeRejectedPosts: async () => 0,
  purgeExpiredAuthData: async () => 0,
  getBannedTerms: async () => [],
  replaceBannedTerms: async () => {},
  getCategories: async () => [],
  replaceCategories: async () => {},
  featurePost: async () => {},
  unfeaturePost: async () => {},
  getAnalytics: async (semesterId) => ({
    semesterId,
    totals: { posts: 0, likes: 0, reports: 0, achievedGoals: 0 },
    moderation: { live: 0, held: 0, hidden: 0, rejected: 0, removed: 0 },
  }),
  archiveSemester: async () => {},
};

function makeApi(overrides: Partial<AdminApi> = {}): AdminApi {
  return { ...defaultApi, ...overrides };
}

async function withServer(
  api: AdminApi,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json({ limit: "16kb" }));
  app.use("/admin", adminRouter(api, [origin]));
  app.use(errorMiddleware);
  const server = createServer(app);

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Test server did not start");
  }

  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

test("logs in with a secure cookie and returns only the CSRF token", async () => {
  let received: unknown;
  await withServer(
    makeApi({
      login: async (email, password, ip) => {
        received = { email, password, hasIp: Boolean(ip) };
        return { sessionToken, csrfToken };
      },
    }),
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/admin/login`, {
        method: "POST",
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: " ADMIN@EXAMPLE.COM ",
          password: "A-long-test-password-123",
        }),
      });

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { csrfToken });
      assert.match(
        response.headers.get("set-cookie") ?? "",
        /__Host-admin_session=.*; Max-Age=28800; Path=\/;.*; HttpOnly; Secure; SameSite=Strict/i,
      );
      assert.deepEqual(received, {
        email: "admin@example.com",
        password: "A-long-test-password-123",
        hasIp: true,
      });
    },
  );
});

test("logs out with origin and CSRF validation and clears the session cookie", async () => {
  let loggedOut: string | undefined;
  await withServer(
    makeApi({
      logout: async (token) => {
        loggedOut = token;
      },
    }),
    async (baseUrl) => {
      const missingCsrf = await fetch(`${baseUrl}/admin/logout`, {
        method: "POST",
        headers: { Origin: origin, Cookie: sessionCookie },
      });
      const response = await fetch(`${baseUrl}/admin/logout`, {
        method: "POST",
        headers: {
          Origin: origin,
          Cookie: sessionCookie,
          "X-CSRF-Token": csrfToken,
        },
      });

      assert.equal(missingCsrf.status, 403);
      assert.equal(response.status, 204);
      assert.equal(loggedOut, sessionToken);
      assert.match(
        response.headers.get("set-cookie") ?? "",
        /__Host-admin_session=;/,
      );
    },
  );
});

test("rejects cross-origin login and unknown login fields", async () => {
  let logins = 0;
  await withServer(
    makeApi({
      login: async () => {
        logins += 1;
        return { sessionToken, csrfToken };
      },
    }),
    async (baseUrl) => {
      const crossOrigin = await fetch(`${baseUrl}/admin/login`, {
        method: "POST",
        headers: {
          Origin: "https://attacker.example",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: "admin@example.com",
          password: "A-long-test-password-123",
        }),
      });
      const unknownField = await fetch(`${baseUrl}/admin/login`, {
        method: "POST",
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: "admin@example.com",
          password: "A-long-test-password-123",
          role: "admin",
        }),
      });

      assert.equal(crossOrigin.status, 403);
      assert.equal(unknownField.status, 400);
      assert.equal(logins, 0);
    },
  );
});

test("requires a session and admin role for moderator listing", async () => {
  await withServer(
    makeApi({
      getSession: async (token) =>
        token === sessionToken
          ? {
              id: moderatorId,
              role: "moderator",
              csrfHash,
            }
          : null,
    }),
    async (baseUrl) => {
      const unauthenticated = await fetch(`${baseUrl}/admin/moderators`);
      const moderator = await fetch(`${baseUrl}/admin/moderators`, {
        headers: { Cookie: sessionCookie },
      });

      assert.equal(unauthenticated.status, 401);
      assert.equal(moderator.status, 403);
    },
  );
});

test("requires CSRF protection when creating moderators", async () => {
  let creates = 0;
  let createdBy: string | undefined;
  await withServer(
    makeApi({
      createModerator: async (email, _password, role, actorId) => {
        creates += 1;
        createdBy = actorId;
        return { id: moderatorId, email, role, active: true };
      },
    }),
    async (baseUrl) => {
      const url = `${baseUrl}/admin/moderators`;
      const body = JSON.stringify({
        email: "new-mod@example.com",
        password: "Another-long-password-123",
        role: "moderator",
      });
      const missingCsrf = await fetch(url, {
        method: "POST",
        headers: {
          Origin: origin,
          Cookie: sessionCookie,
          "Content-Type": "application/json",
        },
        body,
      });
      const valid = await fetch(url, {
        method: "POST",
        headers: {
          Origin: origin,
          Cookie: sessionCookie,
          "X-CSRF-Token": csrfToken,
          "Content-Type": "application/json",
        },
        body,
      });

      assert.equal(missingCsrf.status, 403);
      assert.equal(valid.status, 201);
      assert.deepEqual(await valid.json(), {
        moderator: {
          id: moderatorId,
          email: "new-mod@example.com",
          role: "moderator",
          active: true,
        },
      });
      assert.equal(creates, 1);
      assert.equal(createdBy, moderatorId);
    },
  );
});

test("deactivates moderators through an authenticated CSRF-protected delete", async () => {
  let deletedId: string | undefined;
  let deletedBy: string | undefined;
  await withServer(
    makeApi({
      deleteModerator: async (id, actorId) => {
        deletedId = id;
        deletedBy = actorId;
      },
    }),
    async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/admin/moderators/${moderatorId}`,
        {
          method: "DELETE",
          headers: {
            Origin: origin,
            Cookie: sessionCookie,
            "X-CSRF-Token": csrfToken,
          },
        },
      );

      assert.equal(response.status, 204);
      assert.equal(deletedId, moderatorId);
      assert.equal(deletedBy, moderatorId);
    },
  );
});

test("allows moderators to read queue and rejected posts without sensitive fields", async () => {
  const queuePost = {
    id: moderatorId,
    displayName: "Manifest-Lion-482",
    body: "A reviewed goal",
    category: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  };
  const rejectedPost = {
    ...queuePost,
    rejectedAt: new Date("2026-01-02T00:00:00Z"),
  };
  await withServer(
    makeApi({
      getSession: async () => ({
        id: moderatorId,
        role: "moderator",
        csrfHash,
      }),
      getModerationQueue: async () => [queuePost],
      getRejectedPosts: async () => [rejectedPost],
    }),
    async (baseUrl) => {
      const queue = await fetch(`${baseUrl}/admin/queue`, {
        headers: { Cookie: sessionCookie },
      });
      const rejected = await fetch(`${baseUrl}/admin/rejected`, {
        headers: { Cookie: sessionCookie },
      });
      const unknownQuery = await fetch(
        `${baseUrl}/admin/queue?status=live`,
        { headers: { Cookie: sessionCookie } },
      );

      assert.equal(queue.status, 200);
      assert.deepEqual(await queue.json(), {
        posts: [{ ...queuePost, createdAt: queuePost.createdAt.toISOString() }],
      });
      assert.equal(rejected.status, 200);
      assert.deepEqual(await rejected.json(), {
        posts: [
          {
            ...rejectedPost,
            createdAt: rejectedPost.createdAt.toISOString(),
            rejectedAt: rejectedPost.rejectedAt?.toISOString(),
          },
        ],
      });
      assert.equal(unknownQuery.status, 400);
    },
  );
});

test("routes approve, reject, undo, and restore through protected actions", async () => {
  const actions: string[] = [];
  await withServer(
    makeApi({
      getSession: async () => ({
        id: moderatorId,
        role: "moderator",
        csrfHash,
      }),
      approvePost: async (id, actorId) => {
        actions.push(`approve:${id}:${actorId}`);
      },
      rejectPost: async (id, actorId) => {
        actions.push(`reject:${id}:${actorId}`);
      },
      undoModeration: async (id, actorId) => {
        actions.push(`undo:${id}:${actorId}`);
      },
      restoreRejectedPost: async (id, actorId) => {
        actions.push(`restore:${id}:${actorId}`);
      },
    }),
    async (baseUrl) => {
      for (const action of ["approve", "reject", "undo", "restore"]) {
        const response = await fetch(
          `${baseUrl}/admin/posts/${moderatorId}/${action}`,
          {
            method: "POST",
            headers: {
              Origin: origin,
              Cookie: sessionCookie,
              "X-CSRF-Token": csrfToken,
            },
          },
        );
        assert.equal(response.status, 204);
      }

      assert.deepEqual(actions, [
        `approve:${moderatorId}:${moderatorId}`,
        `reject:${moderatorId}:${moderatorId}`,
        `undo:${moderatorId}:${moderatorId}`,
        `restore:${moderatorId}:${moderatorId}`,
      ]);
    },
  );
});

test("lists banned terms for admins but not moderators", async () => {
  const terms = [{ term: "bad-term", type: "custom" }];
  await withServer(
    makeApi({
      getSession: async (token) => ({
        id: moderatorId,
        role: token === "C".repeat(43) ? "moderator" : "admin",
        csrfHash,
      }),
      getBannedTerms: async () => terms,
    }),
    async (baseUrl) => {
      const admin = await fetch(`${baseUrl}/admin/banned-terms`, {
        headers: { Cookie: sessionCookie },
      });
      const moderator = await fetch(`${baseUrl}/admin/banned-terms`, {
        headers: { Cookie: `__Host-admin_session=${"C".repeat(43)}` },
      });
      const unknownQuery = await fetch(
        `${baseUrl}/admin/banned-terms?type=custom`,
        { headers: { Cookie: sessionCookie } },
      );

      assert.equal(admin.status, 200);
      assert.deepEqual(await admin.json(), { terms });
      assert.equal(moderator.status, 403);
      assert.equal(unknownQuery.status, 400);
    },
  );
});

test("replaces banned terms with strict, sanitized, non-duplicate input", async () => {
  let received: unknown;
  let replacedBy: string | undefined;
  await withServer(
    makeApi({
      replaceBannedTerms: async (terms, actorId) => {
        received = terms;
        replacedBy = actorId;
      },
    }),
    async (baseUrl) => {
      const url = `${baseUrl}/admin/banned-terms`;
      const headers = {
        Origin: origin,
        Cookie: sessionCookie,
        "X-CSRF-Token": csrfToken,
        "Content-Type": "application/json",
      };
      const missingCsrf = await fetch(url, {
        method: "PUT",
        headers: { ...headers, "X-CSRF-Token": "C".repeat(43) },
        body: JSON.stringify({ terms: [] }),
      });
      const unknownField = await fetch(url, {
        method: "PUT",
        headers,
        body: JSON.stringify({ terms: [], extra: true }),
      });
      const duplicateTerms = await fetch(url, {
        method: "PUT",
        headers,
        body: JSON.stringify({
          terms: [
            { term: "bad-term", type: "custom" },
            { term: "badterm", type: "CUSTOM" },
          ],
        }),
      });
      const valid = await fetch(url, {
        method: "PUT",
        headers,
        body: JSON.stringify({
          terms: [{ term: "<b>bad-term</b>", type: " custom " }],
        }),
      });

      assert.equal(missingCsrf.status, 403);
      assert.equal(unknownField.status, 400);
      assert.equal(duplicateTerms.status, 400);
      assert.equal(valid.status, 200);
      assert.deepEqual(await valid.json(), {
        terms: [{ term: "bad-term", type: "custom" }],
      });
      assert.deepEqual(received, [{ term: "bad-term", type: "custom" }]);
      assert.equal(replacedBy, moderatorId);
    },
  );
});

test("restricts category management to admins and validates replacements", async () => {
  let received: string[] | undefined;
  let replacedBy: string | undefined;
  await withServer(
    makeApi({
      getSession: async (token) => ({
        id: moderatorId,
        role: token === "C".repeat(43) ? "moderator" : "admin",
        csrfHash,
      }),
      getCategories: async () => ["academic", "fun-random"],
      replaceCategories: async (categories, actorId) => {
        received = categories;
        replacedBy = actorId;
      },
    }),
    async (baseUrl) => {
      const url = `${baseUrl}/admin/categories`;
      const headers = {
        Origin: origin,
        Cookie: sessionCookie,
        "X-CSRF-Token": csrfToken,
        "Content-Type": "application/json",
      };
      const admin = await fetch(url, {
        headers: { Cookie: sessionCookie },
      });
      const moderator = await fetch(url, {
        headers: { Cookie: `__Host-admin_session=${"C".repeat(43)}` },
      });
      const invalidQuery = await fetch(`${url}?active=true`, {
        headers: { Cookie: sessionCookie },
      });
      const missingCsrf = await fetch(url, {
        method: "PUT",
        headers: { ...headers, "X-CSRF-Token": "C".repeat(43) },
        body: JSON.stringify({ categories: ["academic"] }),
      });
      const duplicate = await fetch(url, {
        method: "PUT",
        headers,
        body: JSON.stringify({ categories: ["academic", "academic"] }),
      });
      const invalidSlug = await fetch(url, {
        method: "PUT",
        headers,
        body: JSON.stringify({ categories: ["Fun / Random"] }),
      });
      const valid = await fetch(url, {
        method: "PUT",
        headers,
        body: JSON.stringify({ categories: ["academic", "new-category"] }),
      });

      assert.equal(admin.status, 200);
      assert.deepEqual(await admin.json(), {
        categories: ["academic", "fun-random"],
      });
      assert.equal(moderator.status, 403);
      assert.equal(invalidQuery.status, 400);
      assert.equal(missingCsrf.status, 403);
      assert.equal(duplicate.status, 400);
      assert.equal(invalidSlug.status, 400);
      assert.equal(valid.status, 200);
      assert.deepEqual(await valid.json(), {
        categories: ["academic", "new-category"],
      });
      assert.deepEqual(received, ["academic", "new-category"]);
      assert.equal(replacedBy, moderatorId);
    },
  );
});

test("requires an admin, origin, and CSRF token to feature posts", async () => {
  const actions: string[] = [];
  await withServer(
    makeApi({
      getSession: async (token) => ({
        id: moderatorId,
        role: token === "C".repeat(43) ? "moderator" : "admin",
        csrfHash,
      }),
      featurePost: async (id, actorId) => {
        actions.push(`feature:${id}:${actorId}`);
      },
      unfeaturePost: async (id, actorId) => {
        actions.push(`unfeature:${id}:${actorId}`);
      },
    }),
    async (baseUrl) => {
      const url = `${baseUrl}/admin/posts/${moderatorId}/feature`;
      const headers = {
        Origin: origin,
        Cookie: sessionCookie,
        "X-CSRF-Token": csrfToken,
      };
      const missingCsrf = await fetch(url, {
        method: "POST",
        headers: { ...headers, "X-CSRF-Token": "C".repeat(43) },
      });
      const moderator = await fetch(url, {
        method: "POST",
        headers: {
          ...headers,
          Cookie: `__Host-admin_session=${"C".repeat(43)}`,
        },
      });
      const invalidId = await fetch(
        `${baseUrl}/admin/posts/not-a-uuid/feature`,
        {
          method: "POST",
          headers,
        },
      );
      const feature = await fetch(url, { method: "POST", headers });
      const unfeature = await fetch(url, { method: "DELETE", headers });

      assert.equal(missingCsrf.status, 403);
      assert.equal(moderator.status, 403);
      assert.equal(invalidId.status, 400);
      assert.equal(feature.status, 204);
      assert.equal(unfeature.status, 204);
      assert.deepEqual(actions, [
        `feature:${moderatorId}:${moderatorId}`,
        `unfeature:${moderatorId}:${moderatorId}`,
      ]);
    },
  );
});

test("archives semesters through an admin-only CSRF-protected action", async () => {
  const archived: { id: string; actorId: string }[] = [];
  await withServer(
    makeApi({
      getSession: async (token) => ({
        id: moderatorId,
        role: token === "C".repeat(43) ? "moderator" : "admin",
        csrfHash,
      }),
      archiveSemester: async (id, actorId) => {
        archived.push({ id, actorId });
      },
    }),
    async (baseUrl) => {
      const url = `${baseUrl}/admin/semesters/${moderatorId}/archive`;
      const headers = {
        Origin: origin,
        Cookie: sessionCookie,
        "X-CSRF-Token": csrfToken,
      };
      const noCsrf = await fetch(url, {
        method: "POST",
        headers: { Origin: origin, Cookie: sessionCookie },
      });
      const moderator = await fetch(url, {
        method: "POST",
        headers: {
          ...headers,
          Cookie: `__Host-admin_session=${"C".repeat(43)}`,
        },
      });
      const invalidId = await fetch(
        `${baseUrl}/admin/semesters/not-a-uuid/archive`,
        { method: "POST", headers },
      );
      const unknownQuery = await fetch(`${url}?state=open`, {
        method: "POST",
        headers,
      });
      const unknownBody = await fetch(url, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ state: "closed" }),
      });
      const valid = await fetch(url, { method: "POST", headers });

      assert.equal(noCsrf.status, 403);
      assert.equal(moderator.status, 403);
      assert.equal(invalidId.status, 400);
      assert.equal(unknownQuery.status, 400);
      assert.equal(unknownBody.status, 400);
      assert.equal(valid.status, 204);
      assert.deepEqual(archived, [{ id: moderatorId, actorId: moderatorId }]);
    },
  );
});

test("restricts aggregate analytics to admins and validates semester filters", async () => {
  const semesterId = "00000000-0000-4000-8000-000000000002";
  const requested: (string | null)[] = [];
  await withServer(
    makeApi({
      getSession: async (token) => ({
        id: moderatorId,
        role: token === "C".repeat(43) ? "moderator" : "admin",
        csrfHash,
      }),
      getAnalytics: async (requestedSemesterId) => {
        requested.push(requestedSemesterId);
        return {
          semesterId: requestedSemesterId,
          totals: { posts: 10, likes: 20, reports: 3, achievedGoals: 2 },
          moderation: { live: 6, held: 1, hidden: 1, rejected: 1, removed: 1 },
        };
      },
    }),
    async (baseUrl) => {
      const base = `${baseUrl}/admin/analytics`;
      const all = await fetch(base, {
        headers: { Cookie: sessionCookie },
      });
      const filtered = await fetch(`${base}?semesterId=${semesterId}`, {
        headers: { Cookie: sessionCookie },
      });
      const moderator = await fetch(base, {
        headers: { Cookie: `__Host-admin_session=${"C".repeat(43)}` },
      });
      const invalid = await fetch(`${base}?semesterId=not-a-uuid`, {
        headers: { Cookie: sessionCookie },
      });
      const extra = await fetch(`${base}?semesterId=${semesterId}&email=x`, {
        headers: { Cookie: sessionCookie },
      });

      assert.equal(all.status, 200);
      assert.deepEqual(await all.json(), {
        semesterId: null,
        totals: { posts: 10, likes: 20, reports: 3, achievedGoals: 2 },
        moderation: { live: 6, held: 1, hidden: 1, rejected: 1, removed: 1 },
      });
      assert.equal(filtered.status, 200);
      assert.equal(moderator.status, 403);
      assert.equal(invalid.status, 400);
      assert.equal(extra.status, 400);
      assert.deepEqual(requested, [null, semesterId]);
    },
  );
});
