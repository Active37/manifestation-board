import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import express from "express";
import test from "node:test";
import { errorMiddleware } from "../errors.js";
import { postsRouter } from "../routes/posts.js";
import { semestersRouter } from "../routes/semesters.js";
import type { PostsApi } from "./types.js";

const allowedOrigin = "https://board.example";

async function withServer(
  api: PostsApi,
  run: (baseUrl: string) => Promise<void>,
  injectOrigin = true,
  captchaBypass = false,
): Promise<void> {
  const app = express();
  app.use(express.json({ limit: "16kb" }));
  app.use((req, _res, next) => {
    if (injectOrigin) {
      req.headers.origin ??= allowedOrigin;
    }
    next();
  });
  app.use("/posts", postsRouter(api, [allowedOrigin], captchaBypass));
  app.use("/semesters", semestersRouter(api));
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

function baseApi(overrides: Partial<PostsApi> = {}): PostsApi {
  return {
    verifyCaptcha: async (token) => token === "valid-token",
    checkPostRateLimit: async () => {},
    checkNameRateLimit: async () => {},
    createPost: async (post) => ({
      id: "post-id",
      ...post,
      progressStatus: "not_started",
      editKey: "one-time-edit-key",
    }),
    patchPost: async (id, _editKey, patch) => ({
      id,
      displayName: patch.displayName ?? "Jill",
      body: patch.body ?? "A goal",
      category: patch.category ?? null,
      progressStatus: "not_started",
    }),
    updateProgress: async (_id, _editKey, progressStatus) => ({
      progressStatus,
      badges: [],
    }),
    deletePost: async () => {},
    addLike: async () => {},
    removeLike: async () => {},
    reportPost: async () => {},
    listPosts: async () => ({ posts: [], nextCursor: null }),
    listAchievedPosts: async () => [],
    listFeaturedPosts: async () => [],
    getRandomPost: async () => null,
    listCategories: async () => ["academic", "career", "spiritual", "money", "fun-random"],
    listArchivedSemesters: async () => [],
    listArchivedSemesterPosts: async () => ({ posts: [], nextCursor: null }),
    ...overrides,
  };
}

test("creates a post with sanitized fields and does not disclose held status", async () => {
  let receivedPost: unknown;
  let receivedDevice: string | undefined;
  let receivedIp: string | undefined;
  let receivedCaptchaHash: string | undefined;
  await withServer(
    baseApi({
      checkPostRateLimit: async (deviceId, ip) => {
        receivedDevice = deviceId;
        receivedIp = ip;
      },
      createPost: async (post, captchaTokenHash) => {
        receivedPost = post;
        receivedCaptchaHash = captchaTokenHash;
        return {
          id: "post-id",
          ...post,
          progressStatus: "not_started",
          editKey: "one-time-edit-key",
        };
      },
    }),
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/posts`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Device-Id": "device-1",
        },
        body: JSON.stringify({
          displayName: "<b>Jill</b>",
          body: "<i>Finish a semester project</i>",
          captchaToken: "valid-token",
        }),
      });
      const body = await response.json();
      const setCookie = response.headers.get("set-cookie");
      const cookieToken = setCookie?.match(/__Host-board_device=([^;]+)/)?.[1];

      assert.equal(response.status, 201);
      assert.deepEqual(body, {
        id: "post-id",
        displayName: "Jill",
        body: "Finish a semester project",
        category: null,
        progressStatus: "not_started",
        editKey: "one-time-edit-key",
      });
      assert.equal("status" in body, false);
      assert.deepEqual(receivedPost, {
        displayName: "Jill",
        body: "Finish a semester project",
        category: null,
      });
      assert.match(cookieToken ?? "", /^[A-Za-z0-9_-]{43}$/);
      assert.equal(receivedDevice, cookieToken);
      assert.match(setCookie ?? "", /HttpOnly; Secure; SameSite=None/i);
      assert.ok(receivedIp);
      assert.equal(
        receivedCaptchaHash,
        createHash("sha256").update("valid-token").digest("hex"),
      );
    },
  );
});

test("rejects unknown fields and goals over 300 characters", async () => {
  await withServer(baseApi(), async (baseUrl) => {
    const unknownField = await fetch(`${baseUrl}/posts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Device-Id": "device-1",
      },
      body: JSON.stringify({
        displayName: "Jill",
        body: "A goal",
        captchaToken: "valid-token",
        status: "live",
      }),
    });
    const longGoal = await fetch(`${baseUrl}/posts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Device-Id": "device-1",
      },
      body: JSON.stringify({
        displayName: "Jill",
        body: "x".repeat(301),
        captchaToken: "valid-token",
      }),
    });
    const exactLimit = await fetch(`${baseUrl}/posts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Device-Id": "device-1",
      },
      body: JSON.stringify({
        displayName: "Jill",
        body: "x".repeat(300),
        captchaToken: "valid-token",
      }),
    });

    assert.equal(unknownField.status, 400);
    assert.equal(longGoal.status, 400);
    assert.equal(exactLimit.status, 201);
  });
});

test("does not create a post when CAPTCHA verification fails", async () => {
  let created = false;
  const calls: string[] = [];
  await withServer(
    baseApi({
      checkPostRateLimit: async () => {
        calls.push("rate limit");
      },
      verifyCaptcha: async () => {
        calls.push("CAPTCHA");
        return false;
      },
      createPost: async () => {
        created = true;
        throw new Error("Post creation should not run");
      },
    }),
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/posts`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Device-Id": "device-1",
        },
        body: JSON.stringify({
          displayName: "Jill",
          body: "A goal",
          captchaToken: "invalid-token",
        }),
      });

      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), {
        error: "CAPTCHA verification failed",
      });
      assert.equal(created, false);
      assert.deepEqual(calls, ["rate limit", "CAPTCHA"]);
    },
  );
});

test("allows local post creation without CAPTCHA when bypass is enabled", async () => {
  let captchaCalls = 0;
  let rateLimitCalls = 0;
  let receivedCaptchaHash = "";
  await withServer(
    baseApi({
      verifyCaptcha: async () => {
        captchaCalls += 1;
        return false;
      },
      checkPostRateLimit: async () => {
        rateLimitCalls += 1;
      },
      createPost: async (post, captchaTokenHash) => {
        receivedCaptchaHash = captchaTokenHash;
        return {
          id: "post-id",
          ...post,
          progressStatus: "not_started",
          editKey: "one-time-edit-key",
        };
      },
    }),
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/posts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: "Jill",
          body: "A goal",
        }),
      });

      assert.equal(response.status, 201);
      assert.equal(captchaCalls, 0);
      assert.equal(rateLimitCalls, 1);
      assert.match(receivedCaptchaHash, /^[a-f0-9]{64}$/);
    },
    true,
    true,
  );
});

test("requires CAPTCHA when local bypass is disabled", async () => {
  let rateLimitCalls = 0;
  await withServer(
    baseApi({
      checkPostRateLimit: async () => {
        rateLimitCalls += 1;
      },
    }),
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/posts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: "Jill",
          body: "A goal",
        }),
      });

      assert.equal(response.status, 400);
      assert.equal(rateLimitCalls, 0);
    },
  );
});

test("issues an anonymous device cookie without requiring X-Device-Id", async () => {
  let receivedDeviceId = "";
  await withServer(
    baseApi({
      checkPostRateLimit: async (deviceId) => {
        receivedDeviceId = deviceId;
      },
    }),
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/posts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: "Jill",
          body: "A goal",
          captchaToken: "valid-token",
        }),
      });
      const cookieToken = response.headers
        .get("set-cookie")
        ?.match(/__Host-board_device=([^;]+)/)?.[1];

      assert.equal(response.status, 201);
      assert.match(cookieToken ?? "", /^[A-Za-z0-9_-]{43}$/);
      assert.equal(receivedDeviceId, cookieToken);
    },
  );
});

test("replaces malformed or duplicate device cookies", async () => {
  let receivedDeviceId = "";
  const firstToken = "A".repeat(43);
  const secondToken = "B".repeat(43);
  await withServer(
    baseApi({
      checkPostRateLimit: async (deviceId) => {
        receivedDeviceId = deviceId;
      },
    }),
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/posts`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `__Host-board_device=${firstToken}; __Host-board_device=${secondToken}`,
        },
        body: JSON.stringify({
          displayName: "Jill",
          body: "A goal",
          captchaToken: "valid-token",
        }),
      });
      const cookieToken = response.headers
        .get("set-cookie")
        ?.match(/__Host-board_device=([^;]+)/)?.[1];

      assert.equal(response.status, 201);
      assert.match(cookieToken ?? "", /^[A-Za-z0-9_-]{43}$/);
      assert.notEqual(cookieToken, firstToken);
      assert.notEqual(cookieToken, secondToken);
      assert.equal(receivedDeviceId, cookieToken);
    },
  );
});

test("validates and forwards feed query options", async () => {
  const receivedQueries: unknown[] = [];
  await withServer(
    baseApi({
      listPosts: async (query) => {
        receivedQueries.push(query);
        return { posts: [], nextCursor: null };
      },
    }),
    async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/posts?search=%3Cb%3EMANIFEST-Lion%3C%2Fb%3E`,
      );
      const unknownOption = await fetch(`${baseUrl}/posts?sort=newest&extra=1`);
      const invalidSort = await fetch(`${baseUrl}/posts?sort=oldest`);
      const duplicateSort = await fetch(
        `${baseUrl}/posts?sort=newest&sort=shuffle`,
      );
      const longSearch = await fetch(
        `${baseUrl}/posts?search=${"a".repeat(101)}`,
      );
      const validCategory = await fetch(`${baseUrl}/posts?category=academic`);
      const invalidCategory = await fetch(`${baseUrl}/posts?category=unknown`);

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { posts: [], nextCursor: null });
      assert.deepEqual(receivedQueries[0], { search: "manifest-lion" });
      assert.equal(unknownOption.status, 400);
      assert.equal(invalidSort.status, 400);
      assert.equal(duplicateSort.status, 400);
      assert.equal(longSearch.status, 400);
      assert.equal(validCategory.status, 200);
      assert.equal(invalidCategory.status, 400);
      assert.deepEqual(receivedQueries[1], { category: "academic" });
    },
  );
});

test("returns only backend-managed public categories", async () => {
  await withServer(
    baseApi({
      listCategories: async () => ["academic", "fun-random"],
    }),
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/posts/categories`);
      const invalid = await fetch(`${baseUrl}/posts/categories?active=true`);

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        categories: ["academic", "fun-random"],
      });
      assert.equal(invalid.status, 400);
    },
  );
});

test("retrieves public featured posts and rejects extra query parameters", async () => {
  let calls = 0;
  await withServer(
    baseApi({
      listFeaturedPosts: async () => {
        calls += 1;
        return [
          {
            id: "00000000-0000-4000-8000-000000000001",
            displayName: "Manifest-Lion-482",
            body: "A semester goal",
            category: "academic",
            progressStatus: "not_started",
            badges: [],
            likeCount: 2,
            createdAt: "2026-11-23T12:00:00.000Z",
          },
        ];
      },
    }),
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/posts/featured`);
      const invalid = await fetch(`${baseUrl}/posts/featured?status=held`);

      assert.equal(response.status, 200);
      assert.deepEqual((await response.json()).posts[0], {
        id: "00000000-0000-4000-8000-000000000001",
        displayName: "Manifest-Lion-482",
        body: "A semester goal",
        category: "academic",
        progressStatus: "not_started",
        badges: [],
        likeCount: 2,
        createdAt: "2026-11-23T12:00:00.000Z",
      });
      assert.equal(invalid.status, 400);
      assert.equal(calls, 1);
    },
  );
});

test("uses today's likes for trending posts and validates its cursor query", async () => {
  let receivedQuery: unknown;
  await withServer(
    baseApi({
      listPosts: async (query) => {
        receivedQuery = query;
        return { posts: [], nextCursor: null };
      },
    }),
    async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/posts/trending?cursor=next-page`,
      );
      const invalid = await fetch(
        `${baseUrl}/posts/trending?sort=newest`,
      );

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { posts: [], nextCursor: null });
      assert.deepEqual(receivedQuery, {
        sort: "most-liked-today",
        cursor: "next-page",
      });
      assert.equal(invalid.status, 400);
    },
  );
});

test("returns one random public post or null and rejects extra query parameters", async () => {
  await withServer(
    baseApi({
      getRandomPost: async () => null,
    }),
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/posts/random`);
      const invalid = await fetch(`${baseUrl}/posts/random?status=held`);

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { post: null });
      assert.equal(invalid.status, 400);
    },
  );
});

test("retrieves public achieved goals and rejects extra query parameters", async () => {
  let calls = 0;
  await withServer(
    baseApi({
      listAchievedPosts: async () => {
        calls += 1;
        return [
          {
            id: "00000000-0000-4000-8000-000000000001",
            displayName: "Manifest-Lion-482",
            body: "Finish a semester project",
            category: null,
            progressStatus: "achieved",
            badges: ["goal_achieved"],
            likeCount: 2,
            createdAt: "2026-11-23T12:00:00.000Z",
          },
        ];
      },
    }),
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/posts/achieved`);
      const invalid = await fetch(`${baseUrl}/posts/achieved?status=held`);

      assert.equal(response.status, 200);
      assert.deepEqual((await response.json()).posts[0], {
        id: "00000000-0000-4000-8000-000000000001",
        displayName: "Manifest-Lion-482",
        body: "Finish a semester project",
        category: null,
        progressStatus: "achieved",
        badges: ["goal_achieved"],
        likeCount: 2,
        createdAt: "2026-11-23T12:00:00.000Z",
      });
      assert.equal(invalid.status, 400);
      assert.equal(calls, 1);
    },
  );
});

test("lists archived semesters and live posts with strict archive query validation", async () => {
  const semesterId = "00000000-0000-4000-8000-000000000002";
  let requested: { id: string; cursor: string | undefined } | undefined;
  await withServer(
    baseApi({
      listArchivedSemesters: async () => [
        { id: semesterId, name: "Semester 1", endsOn: "2026-06-30" },
      ],
      listArchivedSemesterPosts: async (id, cursor) => {
        requested = { id, cursor };
        return {
          posts: [
            {
              id: "00000000-0000-4000-8000-000000000003",
              displayName: "Manifest-Lion-482",
              body: "A completed semester goal",
              category: null,
              progressStatus: "achieved",
              badges: ["goal_achieved"],
              likeCount: 2,
              createdAt: "2026-06-01T12:00:00.000Z",
            },
          ],
          nextCursor: null,
        };
      },
    }),
    async (baseUrl) => {
      const semesters = await fetch(`${baseUrl}/semesters`);
      const posts = await fetch(
        `${baseUrl}/semesters/${semesterId}/posts?cursor=next-page`,
      );
      const invalidId = await fetch(`${baseUrl}/semesters/not-a-uuid/posts`);
      const extraQuery = await fetch(
        `${baseUrl}/semesters/${semesterId}/posts?status=held`,
      );

      assert.equal(semesters.status, 200);
      assert.deepEqual(await semesters.json(), {
        semesters: [
          { id: semesterId, name: "Semester 1", endsOn: "2026-06-30" },
        ],
      });
      assert.equal(posts.status, 200);
      const response = await posts.json();
      assert.deepEqual(response.posts[0], {
        id: "00000000-0000-4000-8000-000000000003",
        displayName: "Manifest-Lion-482",
        body: "A completed semester goal",
        category: null,
        progressStatus: "achieved",
        badges: ["goal_achieved"],
        likeCount: 2,
        createdAt: "2026-06-01T12:00:00.000Z",
      });
      assert.equal("status" in response.posts[0], false);
      assert.equal("editKey" in response.posts[0], false);
      assert.equal(invalidId.status, 400);
      assert.equal(extraQuery.status, 400);
      assert.deepEqual(requested, { id: semesterId, cursor: "next-page" });
    },
  );
});

test("updates progress only through the edit-key endpoint", async () => {
  const calls: { id: string; editKey: string; progressStatus: string }[] = [];
  await withServer(
    baseApi({
      updateProgress: async (id, editKey, progressStatus) => {
        calls.push({ id, editKey, progressStatus });
        return {
          progressStatus,
          badges: progressStatus === "achieved" ? ["goal_achieved"] : [],
        };
      },
    }),
    async (baseUrl) => {
      const url =
        `${baseUrl}/posts/00000000-0000-4000-8000-000000000001/progress`;
      const headers = {
        "Content-Type": "application/json",
        "X-Edit-Key": "A".repeat(43),
      };
      const updated = await fetch(url, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ progressStatus: "achieved" }),
      });
      const invalidStatus = await fetch(url, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ progressStatus: "approved" }),
      });
      const unknownField = await fetch(url, {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          progressStatus: "in_progress",
          status: "live",
        }),
      });
      const missingKey = await fetch(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ progressStatus: "in_progress" }),
      });

      assert.equal(updated.status, 200);
      assert.deepEqual(await updated.json(), {
        progressStatus: "achieved",
        badges: ["goal_achieved"],
      });
      assert.equal(invalidStatus.status, 400);
      assert.equal(unknownField.status, 400);
      assert.equal(missingKey.status, 400);
      assert.deepEqual(calls, [
        {
          id: "00000000-0000-4000-8000-000000000001",
          editKey: "A".repeat(43),
          progressStatus: "achieved",
        },
      ]);
    },
  );
});

test("patches a post with its edit key and sanitized content", async () => {
  let received: unknown;
  await withServer(
    baseApi({
      patchPost: async (id, editKey, patch) => {
        received = { id, editKey, patch };
        return {
          id,
          displayName: patch.displayName ?? "Jill",
          body: patch.body ?? "A goal",
          category: patch.category ?? null,
          progressStatus: "not_started",
        };
      },
    }),
    async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/posts/00000000-0000-4000-8000-000000000001`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "X-Edit-Key": "A".repeat(43),
          },
          body: JSON.stringify({ body: "<b>Updated goal</b>" }),
        },
      );
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.deepEqual(body, {
        id: "00000000-0000-4000-8000-000000000001",
        displayName: "Jill",
        body: "Updated goal",
        category: null,
        progressStatus: "not_started",
      });
      assert.equal("editKey" in body, false);
      assert.equal("status" in body, false);
      assert.deepEqual(received, {
        id: "00000000-0000-4000-8000-000000000001",
        editKey: "A".repeat(43),
        patch: { body: "Updated goal" },
      });
    },
  );
});

test("rejects invalid post ids, missing edit keys, and unknown patch fields", async () => {
  await withServer(baseApi(), async (baseUrl) => {
    const invalidId = await fetch(`${baseUrl}/posts/not-a-uuid`, {
      method: "DELETE",
      headers: { "X-Edit-Key": "A".repeat(43) },
    });
    const missingKey = await fetch(
      `${baseUrl}/posts/00000000-0000-4000-8000-000000000001`,
      { method: "DELETE" },
    );
    const unknownField = await fetch(
      `${baseUrl}/posts/00000000-0000-4000-8000-000000000001`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Edit-Key": "A".repeat(43),
        },
        body: JSON.stringify({ status: "live" }),
      },
    );
    const progressOnContentPatch = await fetch(
      `${baseUrl}/posts/00000000-0000-4000-8000-000000000001`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Edit-Key": "A".repeat(43),
        },
        body: JSON.stringify({ progressStatus: "achieved" }),
      },
    );
    const emptyPatch = await fetch(
      `${baseUrl}/posts/00000000-0000-4000-8000-000000000001`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Edit-Key": "A".repeat(43),
        },
        body: JSON.stringify({}),
      },
    );

    assert.equal(invalidId.status, 400);
    assert.equal(missingKey.status, 400);
    assert.equal(unknownField.status, 400);
    assert.equal(progressOnContentPatch.status, 400);
    assert.equal(emptyPatch.status, 400);
  });
});

test("soft deletes a post using its edit key", async () => {
  let deleted: { id: string; editKey: string } | undefined;
  await withServer(
    baseApi({
      deletePost: async (id, editKey) => {
        deleted = { id, editKey };
      },
    }),
    async (baseUrl) => {
      const url = `${baseUrl}/posts/00000000-0000-4000-8000-000000000001`;
      const unknownBody = await fetch(url, {
        method: "DELETE",
        headers: {
          "X-Edit-Key": "A".repeat(43),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ force: true }),
      });
      const response = await fetch(
        url,
        {
          method: "DELETE",
          headers: { "X-Edit-Key": "A".repeat(43) },
        },
      );

      assert.equal(unknownBody.status, 400);
      assert.equal(response.status, 204);
      assert.deepEqual(deleted, {
        id: "00000000-0000-4000-8000-000000000001",
        editKey: "A".repeat(43),
      });
    },
  );
});

test("adds and removes likes with the HttpOnly cookie identity", async () => {
  const calls: { action: string; id: string; deviceId: string; ip: string }[] = [];
  await withServer(
    baseApi({
      addLike: async (id, deviceId, ip) => {
        calls.push({ action: "add", id, deviceId, ip });
      },
      removeLike: async (id, deviceId, ip) => {
        calls.push({ action: "remove", id, deviceId, ip });
      },
    }),
    async (baseUrl) => {
      const postUrl = `${baseUrl}/posts/00000000-0000-4000-8000-000000000001/like`;
      const headers = { "X-Device-Id": "device-1" };
      const unknownBody = await fetch(postUrl, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ liked: true }),
      });
      const added = await fetch(postUrl, { method: "POST", headers });
      const cookie = added.headers.get("set-cookie")?.split(";", 1)[0];
      const removed = await fetch(postUrl, {
        method: "DELETE",
        headers: { ...headers, Cookie: cookie ?? "" },
      });
      const deviceId = cookie?.split("=", 2)[1];

      assert.equal(unknownBody.status, 400);
      assert.equal(added.status, 204);
      assert.equal(removed.status, 204);
      assert.equal(removed.headers.get("set-cookie"), null);
      assert.match(deviceId ?? "", /^[A-Za-z0-9_-]{43}$/);
      assert.deepEqual(
        calls.map(({ action, id, deviceId }) => ({ action, id, deviceId })),
        [
          {
            action: "add",
            id: "00000000-0000-4000-8000-000000000001",
            deviceId,
          },
          {
            action: "remove",
            id: "00000000-0000-4000-8000-000000000001",
            deviceId,
          },
        ],
      );
      assert.ok(calls.every((call) => call.ip));
    },
  );
});

test("requires a report reason and sanitizes optional details", async () => {
  let received: unknown;
  await withServer(
    baseApi({
      reportPost: async (id, deviceId, ip, reason, detail) => {
        received = { id, deviceId, ip: Boolean(ip), reason, detail };
      },
    }),
    async (baseUrl) => {
      const url = `${baseUrl}/posts/00000000-0000-4000-8000-000000000001/report`;
      const missingReason = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Device-Id": "device-1",
        },
        body: JSON.stringify({ detail: "Please review" }),
      });
      const invalidReason = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Device-Id": "device-1",
        },
        body: JSON.stringify({ reason: "unknown" }),
      });
      const valid = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Device-Id": "device-1",
        },
        body: JSON.stringify({
          reason: "spam",
          detail: "<b>Repeated post</b>",
        }),
      });
      const cookieToken = valid.headers
        .get("set-cookie")
        ?.match(/__Host-board_device=([^;]+)/)?.[1];

      assert.equal(missingReason.status, 400);
      assert.equal(invalidReason.status, 400);
      assert.equal(valid.status, 204);
      assert.deepEqual(received, {
        id: "00000000-0000-4000-8000-000000000001",
        deviceId: cookieToken,
        ip: true,
        reason: "spam",
        detail: "Repeated post",
      });
    },
  );
});

test("rejects state-changing requests from an untrusted origin", async () => {
  let called = false;
  await withServer(
    baseApi({
      addLike: async () => {
        called = true;
      },
    }),
    async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/posts/00000000-0000-4000-8000-000000000001/like`,
        {
          method: "POST",
          headers: { Origin: "https://attacker.example" },
        },
      );

      assert.equal(response.status, 403);
      assert.equal(called, false);
      assert.equal(response.headers.get("set-cookie"), null);
    },
  );
});

test("rejects state-changing requests without an Origin header", async () => {
  let called = false;
  await withServer(
    baseApi({
      addLike: async () => {
        called = true;
      },
    }),
    async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/posts/00000000-0000-4000-8000-000000000001/like`,
        { method: "POST" },
      );

      assert.equal(response.status, 403);
      assert.equal(called, false);
    },
    false,
  );
});
