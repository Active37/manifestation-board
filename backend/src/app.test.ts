import assert from "node:assert/strict";
import test from "node:test";
import type { AdminApi } from "./admin/types.js";
import { createApp } from "./app.js";
import { createApiServer } from "./http.js";
import { createNamesService } from "./names/service.js";
import type { PostsApi } from "./posts/types.js";

const namesService = createNamesService(async (keys) =>
  keys.filter((key) => key === "manifest-lion-482"),
);
const postsApi: PostsApi = {
  verifyCaptcha: async () => true,
  checkPostRateLimit: async () => {},
  checkNameRateLimit: async () => {},
  createPost: async (post) => ({
    id: "post-id",
    ...post,
    progressStatus: "not_started",
    editKey: "test-edit-key",
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
    badges: progressStatus === "achieved" ? ["goal_achieved"] : [],
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
};
const adminApi: AdminApi = {
  login: async () => ({
    sessionToken: "A".repeat(43),
    csrfToken: "B".repeat(43),
  }),
  getSession: async () => null,
  logout: async () => {},
  recordAuthorizationFailure: async () => {},
  listModerators: async () => [],
  createModerator: async () => ({
    id: "00000000-0000-4000-8000-000000000001",
    email: "mod@example.com",
    role: "moderator",
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
  getCategories: async () => ["academic", "career", "spiritual", "money", "fun-random"],
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

async function withServer(
  checkDb: () => Promise<void>,
  run: (baseUrl: string) => Promise<void>,
  options: {
    namesService?: ReturnType<typeof createNamesService>;
    postsApi?: PostsApi;
    requestTimeoutMs?: number;
    trustedProxies?: string[];
    nodeEnv?: "development" | "test" | "production";
    postCaptchaBypass?: boolean;
  } = {},
): Promise<void> {
  const config = {
    nodeEnv: options.nodeEnv ?? "test",
    corsOrigins: ["https://board.example"],
    trustedProxies: options.trustedProxies ?? [],
    requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
    postCaptchaBypass: options.postCaptchaBypass ?? false,
  };
  const server = createApiServer(
    createApp(
      config,
      checkDb,
      options.namesService ?? namesService,
      options.postsApi ?? postsApi,
      adminApi,
    ),
    config,
  );

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
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

test("health checks the database and returns security and allowlist headers", async () => {
  let checked = false;
  await withServer(async () => {
    checked = true;
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`, {
      headers: { Origin: "https://board.example" },
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), "https://board.example");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("x-powered-by"), null);
    assert.match(response.headers.get("x-request-id") ?? "", /^[0-9a-f-]{36}$/i);
    assert.match(response.headers.get("access-control-expose-headers") ?? "", /x-request-id/i);
    assert.deepEqual(await response.json(), { status: "ok" });
  });
  assert.equal(checked, true);
});

test("passes local CAPTCHA bypass configuration to post creation", async () => {
  let captchaCalls = 0;
  await withServer(
    async () => {},
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/posts`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://board.example",
        },
        body: JSON.stringify({
          displayName: "Jill",
          body: "A goal",
        }),
      });

      assert.equal(response.status, 201);
      assert.equal(captchaCalls, 0);
    },
    {
      postCaptchaBypass: true,
      postsApi: {
        ...postsApi,
        verifyCaptcha: async () => {
          captchaCalls += 1;
          return false;
        },
      },
    },
  );
});

test("rejects unknown health and random-name query parameters", async () => {
  let healthChecks = 0;
  await withServer(async () => {
    healthChecks += 1;
  }, async (baseUrl) => {
    const health = await fetch(`${baseUrl}/health?debug=true`);
    const randomName = await fetch(`${baseUrl}/names/random?debug=true`);

    assert.equal(health.status, 400);
    assert.equal(randomName.status, 400);
    assert.equal(healthChecks, 0);
  });
});

test("returns a generic 503 without leaking database errors", async () => {
  await withServer(async () => {
    throw new Error("database credentials must not be exposed");
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`);

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "Service unavailable" });
  });
});

test("does not grant CORS access to an unlisted origin", async () => {
  await withServer(async () => {}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`, {
      headers: { Origin: "https://not-allowed.example" },
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  });
});

test("allows credentialed admin requests and the CSRF header from listed origins", async () => {
  await withServer(async () => {}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/admin/moderators`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://board.example",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type,x-csrf-token",
      },
    });

    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-credentials"), "true");
    assert.match(
      response.headers.get("access-control-allow-headers") ?? "",
      /x-csrf-token/i,
    );
  });
});

test("serves random and availability endpoints with strict query validation", async () => {
  await withServer(async () => {}, async (baseUrl) => {
    const randomResponse = await fetch(`${baseUrl}/names/random`);
    const randomBody = await randomResponse.json();
    const checkResponse = await fetch(
      `${baseUrl}/names/check?name=%3Cb%3EManifest-Lion-482%3C%2Fb%3E`,
    );
    const checkBody = await checkResponse.json();
    const invalidResponse = await fetch(
      `${baseUrl}/names/check?name=Manifest-Lion-482&unexpected=value`,
    );
    const duplicateParameter = await fetch(
      `${baseUrl}/names/check?name=Manifest-Lion-482&name=Other-Lion-123`,
    );

    assert.equal(randomResponse.status, 200);
    assert.match(randomBody.name, /^[A-Za-z]+-[A-Za-z]+-\d{3}$/);
    assert.equal(checkResponse.status, 200);
    assert.deepEqual(checkBody, { available: false });
    assert.equal(invalidResponse.status, 400);
    assert.equal(duplicateParameter.status, 400);
  });
});

test("validates and rate-limits name checks before database lookup", async () => {
  const events: string[] = [];
  const names = createNamesService(async () => {
    events.push("lookup");
    return [];
  });
  const api = {
    ...postsApi,
    checkNameRateLimit: async (ip: string) => {
      assert.ok(ip);
      events.push("rate-limit");
    },
  };
  await withServer(async () => {}, async (baseUrl) => {
    const invalid = await fetch(
      `${baseUrl}/names/check?name=Manifest-Lion-482&name=Other-Lion-123`,
    );
    const valid = await fetch(`${baseUrl}/names/check?name=Manifest-Lion-482`);

    assert.equal(invalid.status, 400);
    assert.equal(valid.status, 200);
    assert.deepEqual(events, ["rate-limit", "lookup"]);
  }, { namesService: names, postsApi: api });
});

test("limits JSON request bodies and does not expose parser errors", async () => {
  await withServer(async () => {}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "x".repeat(17_000) }),
    });
    const body = await response.json();

    assert.equal(response.status, 413);
    assert.deepEqual(body, { error: "Invalid request" });
    assert.equal(JSON.stringify(body).includes("stack"), false);
  });
});

test("rejects non-JSON and malformed request bodies before service calls", async () => {
  let rateLimitChecks = 0;
  const api = {
    ...postsApi,
    checkPostRateLimit: async () => {
      rateLimitChecks += 1;
    },
  };
  await withServer(async () => {}, async (baseUrl) => {
    const unsupported = await fetch(`${baseUrl}/posts`, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "X-Device-Id": "device-1",
      },
      body: "not json",
    });
    const malformed = await fetch(`${baseUrl}/posts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://board.example",
        "X-Device-Id": "device-1",
      },
      body: '{"displayName":',
    });

    assert.equal(unsupported.status, 415);
    assert.deepEqual(await unsupported.json(), {
      error: "Content-Type must be application/json",
    });
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), { error: "Invalid request" });
    assert.equal(rateLimitChecks, 0);
  }, { postsApi: api });
});

test("times out stalled request processing with a generic response", async () => {
  await withServer(
    async () => new Promise<void>(() => {}),
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/health`);
      assert.equal(response.status, 504);
      assert.deepEqual(await response.json(), { error: "Request timed out" });
    },
    { requestTimeoutMs: 30 },
  );
});

test("uses forwarded client IPs only from explicitly trusted proxies", async () => {
  const body = JSON.stringify({
    displayName: "Jill",
    body: "A goal",
    captchaToken: "valid-token",
  });

  let observedIp = "";
  const api = {
    ...postsApi,
    checkPostRateLimit: async (_deviceId: string, ip: string) => {
      observedIp = ip;
    },
  };

  await withServer(async () => {}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/posts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://board.example",
        "X-Device-Id": "device-1",
        "X-Forwarded-For": "203.0.113.9",
      },
      body,
    });

    assert.equal(response.status, 201);
    assert.equal(observedIp, "127.0.0.1");
  }, { postsApi: api });

  await withServer(async () => {}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/posts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://board.example",
        "X-Device-Id": "device-1",
        "X-Forwarded-For": "203.0.113.9",
      },
      body,
    });

    assert.equal(response.status, 201);
    assert.equal(observedIp, "203.0.113.9");
  }, { postsApi: api, trustedProxies: ["127.0.0.1"] });
});

test("rejects production HTTP and accepts HTTPS marked by a trusted proxy", async () => {
  let healthChecks = 0;
  await withServer(
    async () => {
      healthChecks += 1;
    },
    async (baseUrl) => {
      const plaintext = await fetch(`${baseUrl}/health`);
      const proxiedTls = await fetch(`${baseUrl}/health`, {
        headers: { "X-Forwarded-Proto": "https" },
      });

      assert.equal(plaintext.status, 426);
      assert.deepEqual(await plaintext.json(), { error: "HTTPS required" });
      assert.equal(proxiedTls.status, 200);
      assert.equal(healthChecks, 1);
    },
    { nodeEnv: "production", trustedProxies: ["127.0.0.1"] },
  );
});

test("does not trust an HTTPS forwarding header from an untrusted peer", async () => {
  await withServer(
    async () => {},
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/health`, {
        headers: { "X-Forwarded-Proto": "https" },
      });
      assert.equal(response.status, 426);
      assert.deepEqual(await response.json(), { error: "HTTPS required" });
    },
    { nodeEnv: "production", trustedProxies: ["127.0.0.2"] },
  );
});
