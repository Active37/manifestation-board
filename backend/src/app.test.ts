import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import bcrypt from "bcryptjs";
import { Pool } from "pg";
import { createApp } from "./app.js";
import type { AppConfig } from "./config.js";
import { createAdminService } from "./admin/service.js";
import { assertRuntimeRole } from "./db/permissions.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

test("public v1 endpoints use the PRD database rules", {
  skip: !databaseUrl,
}, async () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const testPrefix = `v1-${randomUUID()}`;
  const bannedTerm = `badword${randomUUID().replaceAll("-", "")}`;
  const replayableCaptchaToken = randomUUID();
  let semesterId: string | undefined;
  let createdSemester = false;
  const createdSemesterIds: string[] = [];
  const createdNames: string[] = [];
  const createdModeratorIds: string[] = [];
  const usedCaptchaTokenHashes = new Set<string>();
  await pool.query("DELETE FROM post_rate_limits");
  const testConfig: AppConfig = {
    nodeEnv: "test",
    port: 3001,
    databaseUrl: databaseUrl ?? "postgresql://test:test@localhost/test",
    corsOrigins: [],
    trustedProxies: ["127.0.0.1"],
    ipHashSecret: "v1-integration-test-secret-0123456789",
    turnstileSecretKey: "test-turnstile-secret",
    postsPerHour: 3,
    likesPerMinute: 30,
  };
  const server = createApp(pool, {
    config: testConfig,
    verifyCaptcha: async (token) => token !== "rejected",
  }).listen(0);

  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  testConfig.corsOrigins.push(baseUrl);
  const createRequest = (
    displayName: string,
    body: string,
    deviceId: string,
    forwardedIp: string,
    captchaToken: string = randomUUID(),
    category?: string,
    checkInEmail?: string,
  ) => {
    usedCaptchaTokenHashes.add(
      createHash("sha256").update(captchaToken).digest("hex"),
    );
    return fetch(`${baseUrl}/posts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Device-Id": deviceId,
        "X-Forwarded-For": forwardedIp,
      },
      body: JSON.stringify({
        display_name: displayName,
        body,
        category,
        check_in_email: checkInEmail,
        captcha_token: captchaToken,
      }),
    });
  };

  try {
    const currentRole = await pool.query<{ is_superuser: boolean }>(
      "SELECT rolsuper AS is_superuser FROM pg_roles WHERE rolname = current_user",
    );
    if (currentRole.rows[0]?.is_superuser) {
      await assert.rejects(assertRuntimeRole(pool), /not least-privileged/);
    }

    const productionConfig: AppConfig = {
      ...testConfig,
      nodeEnv: "production",
      corsOrigins: ["https://board.example.org"],
    };
    const productionProbe = createApp(pool, {
      config: productionConfig,
      verifyCaptcha: async () => true,
    }).listen(0);
    await new Promise<void>((resolve, reject) => {
      productionProbe.once("listening", resolve);
      productionProbe.once("error", reject);
    });
    try {
      const probeAddress = productionProbe.address() as AddressInfo;
      const insecureResponse = await fetch(`http://127.0.0.1:${probeAddress.port}/names/random`, {
        headers: {
          Origin: "https://board.example.org",
          "X-Forwarded-Proto": "http",
        },
      });
      assert.equal(insecureResponse.status, 426);
    } finally {
      await new Promise<void>((resolve) => productionProbe.close(() => resolve()));
    }

    const adminPreflight = await fetch(`${baseUrl}/admin/posts/example/approve`, {
      method: "OPTIONS",
      headers: {
        Origin: baseUrl,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type,x-csrf-token",
      },
    });
    assert.equal(adminPreflight.status, 204);
    assert.match(
      adminPreflight.headers.get("access-control-allow-headers") ?? "",
      /x-csrf-token/i,
    );

    await pool.query(
      "INSERT INTO banned_terms (term, type) VALUES ($1, 'test')",
      [bannedTerm],
    );
    const openSemester = await pool.query<{ id: string }>(
      "SELECT id FROM semesters WHERE state = 'open' LIMIT 1",
    );
    semesterId = openSemester.rows[0]?.id;
    if (!semesterId) {
      const inserted = await pool.query<{ id: string }>(
        `
          INSERT INTO semesters (name, ends_on, state)
          VALUES ($1, CURRENT_DATE + 90, 'open')
          RETURNING id
        `,
        [`${testPrefix} semester`],
      );
      semesterId = inserted.rows[0]?.id;
      createdSemester = true;
      if (semesterId) {
        createdSemesterIds.push(semesterId);
      }
    }
    assert.ok(semesterId);

    const randomNameResponse = await fetch(`${baseUrl}/names/random`);
    assert.equal(randomNameResponse.status, 200);
    const randomName = await randomNameResponse.json() as { name: string };
    assert.match(randomName.name, /^[A-Za-z]+-[A-Za-z]+-\d{3}$/);
    const randomNameCheck = await fetch(
      `${baseUrl}/names/check?name=${encodeURIComponent(randomName.name)}`,
    );
    assert.deepEqual(await randomNameCheck.json(), {
      name: randomName.name,
      available: true,
    });

    const displayName = `${testPrefix}-owner`;
    const availabilityBefore = await fetch(
      `${baseUrl}/names/check?name=${encodeURIComponent(displayName)}`,
    );
    assert.deepEqual(await availabilityBefore.json(), {
      name: displayName,
      available: true,
    });

    const createdResponse = await createRequest(
      displayName,
      "Complete the project before semester ends",
      "owner-device",
      "192.0.2.1",
      replayableCaptchaToken,
      "academic",
      `${testPrefix}@example.test`,
    );
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json() as {
      id: string;
      display_name: string;
      body: string;
      category: string;
      edit_key: string;
    };
    createdNames.push(displayName);
    assert.equal(created.display_name, displayName);
    assert.equal(created.category, "academic");
    assert.equal("check_in_email" in created, false);
    assert.match(created.edit_key, /^[A-Za-z0-9_-]{43}$/);

    const storedCheckIn = await pool.query<{
      email: string;
      consented_at: Date;
      sent_at: Date | null;
      unsubscribed_at: Date | null;
    }>(
      "SELECT email, consented_at, sent_at, unsubscribed_at FROM check_ins WHERE post_id = $1",
      [created.id],
    );
    assert.equal(storedCheckIn.rows[0]?.email, `${testPrefix}@example.test`);
    assert.ok(storedCheckIn.rows[0]?.consented_at instanceof Date);
    assert.equal(storedCheckIn.rows[0]?.sent_at, null);
    assert.equal(storedCheckIn.rows[0]?.unsubscribed_at, null);

    const ownerPostResponse = await fetch(`${baseUrl}/posts/${created.id}/owner`, {
      headers: { "X-Edit-Key": created.edit_key },
    });
    assert.equal(ownerPostResponse.status, 200);
    const ownerPost = await ownerPostResponse.json() as Record<string, unknown>;
    assert.equal(ownerPost.id, created.id);
    assert.equal("status" in ownerPost, false);

    const replayedCaptcha = await createRequest(
      `${testPrefix}-replayed-captcha`,
      "This token has already been used",
      "replayed-captcha-device",
      "192.0.2.6",
      replayableCaptchaToken,
    );
    assert.equal(replayedCaptcha.status, 400);

    const duplicateResponse = await createRequest(
      displayName.toUpperCase(),
      "A duplicate name must fail",
      "duplicate-device",
      "192.0.2.5",
    );
    assert.equal(duplicateResponse.status, 409);

    const stored = await pool.query<{
      name_key: string;
      edit_key_hash: string;
      status: string;
    }>(
      "SELECT name_key, edit_key_hash, status FROM posts WHERE id = $1",
      [created.id],
    );
    assert.equal(stored.rows[0]?.name_key, displayName.toLowerCase());
    assert.notEqual(stored.rows[0]?.edit_key_hash, created.edit_key);
    assert.equal(stored.rows[0]?.status, "live");

    const heldName = `${testPrefix}-${bannedTerm}`;
    createdNames.push(heldName);
    const heldNameResponse = await createRequest(
      heldName,
      "A safe goal",
      "held-name-device",
      "192.0.2.2",
    );
    assert.equal(heldNameResponse.status, 201);
    const heldNamePost = await heldNameResponse.json() as { id: string; edit_key: string };
    const noCheckInEmail = await pool.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM check_ins WHERE post_id = $1",
      [heldNamePost.id],
    );
    assert.equal(noCheckInEmail.rows[0]?.count, 0);
    const heldOwnerResponse = await fetch(`${baseUrl}/posts/${heldNamePost.id}/owner`, {
      headers: { "X-Edit-Key": heldNamePost.edit_key },
    });
    assert.equal(heldOwnerResponse.status, 200);
    assert.equal(
      "status" in (await heldOwnerResponse.json() as Record<string, unknown>),
      false,
    );

    const obfuscatedBodyName = `${testPrefix}-obfuscated`;
    createdNames.push(obfuscatedBodyName);
    const obfuscatedBodyResponse = await createRequest(
      obfuscatedBodyName,
      [...bannedTerm].join("."),
      "obfuscated-device",
      "192.0.2.3",
    );
    assert.equal(obfuscatedBodyResponse.status, 201);
    const obfuscatedPost = await obfuscatedBodyResponse.json() as { id: string };

    const heldStatuses = await pool.query<{ id: string; status: string }>(
      "SELECT id, status FROM posts WHERE id = ANY($1::uuid[])",
      [[heldNamePost.id, obfuscatedPost.id]],
    );
    assert.ok(heldStatuses.rows.every((row) => row.status === "held"));

    const gibberishName = `${testPrefix}-gibberish`;
    createdNames.push(gibberishName);
    const gibberishResponse = await createRequest(
      gibberishName,
      "zzzzzzzzzzzz",
      "gibberish-device",
      "192.0.2.4",
    );
    assert.equal(gibberishResponse.status, 201);
    const gibberishPost = await gibberishResponse.json() as { id: string };
    const gibberishStatus = await pool.query<{ status: string }>(
      "SELECT status FROM posts WHERE id = $1",
      [gibberishPost.id],
    );
    assert.equal(gibberishStatus.rows[0]?.status, "held");

    const captchaFailureName = `${testPrefix}-captcha-failure`;
    const captchaFailure = await createRequest(
      captchaFailureName,
      "A valid goal",
      "captcha-failure-device",
      "203.0.113.200",
      "rejected",
    );
    assert.equal(captchaFailure.status, 400);

    const invalidEmail = await createRequest(
      `${testPrefix}-invalid-email`,
      "A valid goal",
      "invalid-email-device",
      "203.0.113.201",
      randomUUID(),
      undefined,
      "not-an-email",
    );
    assert.equal(invalidEmail.status, 400);

    const availabilityAfter = await fetch(
      `${baseUrl}/names/check?name=${encodeURIComponent(displayName.toUpperCase())}`,
    );
    assert.deepEqual(await availabilityAfter.json(), {
      name: displayName.toUpperCase(),
      available: false,
    });

    const feedResponse = await fetch(
      `${baseUrl}/posts?sort=newest&search=${encodeURIComponent(testPrefix)}`,
    );
    assert.equal(feedResponse.status, 200);
    const feed = await feedResponse.json() as {
      posts: { id: string; display_name: string }[];
      next_cursor: string | null;
    };
    assert.ok(feed.posts.some((post) => post.id === created.id));

    const pageNames = Array.from(
      { length: 31 },
      (_unused, index) => `${testPrefix}-page-${String(index + 1).padStart(2, "0")}`,
    );
    createdNames.push(...pageNames);
    await pool.query(
      `
        WITH page_posts AS (
          INSERT INTO posts (
            display_name, name_key, body, status, edit_key_hash,
            like_count, semester_id
          )
          SELECT names.name, lower(names.name), 'Pagination test goal', 'live',
            repeat('f', 64), names.ordinality::integer, $2
          FROM unnest($1::text[]) WITH ORDINALITY AS names(name, ordinality)
          RETURNING id, like_count
        )
        INSERT INTO likes (post_id, device_id, created_at)
        SELECT page_posts.id, md5(page_posts.id::text || liker.number::text), now()
        FROM page_posts
        CROSS JOIN LATERAL generate_series(1, page_posts.like_count) AS liker(number)
      `,
      [pageNames, semesterId],
    );

    const getPage = async (sort: string, cursor?: string) => {
      const params = new URLSearchParams({
        sort,
        search: `${testPrefix}-page-`,
      });
      if (cursor) {
        params.set("cursor", cursor);
      }
      const response = await fetch(`${baseUrl}/posts?${params}`);
      assert.equal(response.status, 200);
      return response.json() as Promise<{
        posts: { id: string; like_count: number }[];
        next_cursor: string | null;
      }>;
    };

    const newestPage = await getPage("newest");
    assert.equal(newestPage.posts.length, 30);
    assert.ok(newestPage.next_cursor);
    const newestSecondPage = await getPage("newest", newestPage.next_cursor);
    assert.equal(newestSecondPage.posts.length, 1);

    const shufflePage = await getPage("shuffle");
    const repeatedShufflePage = await getPage("shuffle");
    assert.deepEqual(
      shufflePage.posts.map((post) => post.id),
      repeatedShufflePage.posts.map((post) => post.id),
    );
    const shuffleSecondPage = await getPage("shuffle", shufflePage.next_cursor ?? undefined);
    assert.equal(shuffleSecondPage.posts.length, 1);
    assert.notEqual(shuffleSecondPage.posts[0]?.id, shufflePage.posts[0]?.id);

    for (const sort of ["most-liked-today", "most-liked-all-time"]) {
      const firstPage = await getPage(sort);
      assert.equal(firstPage.posts.length, 30);
      assert.equal(firstPage.posts[0]?.like_count, 31);
      const secondPage = await getPage(sort, firstPage.next_cursor ?? undefined);
      assert.equal(secondPage.posts.length, 1);
      assert.equal(secondPage.posts[0]?.like_count, 1);
    }

    const patchResponse = await fetch(`${baseUrl}/posts/${created.id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-Edit-Key": created.edit_key,
      },
      body: JSON.stringify({ body: "Complete the project and present it" }),
    });
    assert.equal(patchResponse.status, 200);
    assert.equal(
      (await patchResponse.json() as { body: string }).body,
      "Complete the project and present it",
    );

    const wrongKeyResponse = await fetch(`${baseUrl}/posts/${created.id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-Edit-Key": "B".repeat(43),
      },
      body: JSON.stringify({ body: "Must not be accepted" }),
    });
    assert.equal(wrongKeyResponse.status, 404);

    const deleteResponse = await fetch(`${baseUrl}/posts/${created.id}`, {
      method: "DELETE",
      headers: { "X-Edit-Key": created.edit_key },
    });
    assert.equal(deleteResponse.status, 204);
    const deletedCheckIn = await pool.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM check_ins WHERE post_id = $1",
      [created.id],
    );
    assert.equal(deletedCheckIn.rows[0]?.count, 0);
    const removedOwnerResponse = await fetch(`${baseUrl}/posts/${created.id}/owner`, {
      headers: { "X-Edit-Key": created.edit_key },
    });
    assert.equal(removedOwnerResponse.status, 410);

    const interactionName = `${testPrefix}-interaction`;
    createdNames.push(interactionName);
    const interactionCaptchaToken = randomUUID();
    usedCaptchaTokenHashes.add(
      createHash("sha256").update(interactionCaptchaToken).digest("hex"),
    );
    const interactionResponse = await fetch(`${baseUrl}/posts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Device-Id": "interaction-device",
      },
      body: JSON.stringify({
        display_name: interactionName,
        body: "A goal for interaction checks",
        captcha_token: interactionCaptchaToken,
      }),
    });
    assert.equal(interactionResponse.status, 201);
    const interactionPost = await interactionResponse.json() as { id: string };

    const request = async (
      path: string,
      method: string,
      deviceId: string,
      forwardedIp = "127.0.0.1",
    ): Promise<Response> => fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "X-Device-Id": deviceId,
        "X-Forwarded-For": forwardedIp,
        "Content-Type": "application/json",
      },
      body: method === "POST" ? "{}" : undefined,
    });
    const seedLikeRateLimit = async (
      subjectType: "device" | "ip",
      identifier: string,
    ) => {
      const subjectHash = createHmac("sha256", testConfig.ipHashSecret)
        .update(`${subjectType}:${identifier}`)
        .digest("hex");
      await pool.query(
        `
          INSERT INTO post_rate_limits (
            action_type, subject_type, subject_hash, window_started_at, request_count
          )
          VALUES (
            'like', $1, $2,
            date_trunc('minute', CURRENT_TIMESTAMP) + interval '10 minutes', 0
          )
          ON CONFLICT (action_type, subject_type, subject_hash) DO UPDATE SET
            window_started_at = EXCLUDED.window_started_at,
            request_count = 0
        `,
        [subjectType, subjectHash],
      );
    };

    const likePath = `/posts/${interactionPost.id}/like`;
    assert.deepEqual(await (await request(likePath, "POST", "device-a")).json(), {
      like_count: 1,
    });
    assert.deepEqual(await (await request(likePath, "POST", "device-a")).json(), {
      like_count: 1,
    });
    assert.deepEqual(await (await request(likePath, "POST", "device-b")).json(), {
      like_count: 2,
    });
    assert.deepEqual(await (await request(likePath, "DELETE", "device-a")).json(), {
      like_count: 1,
    });

    await seedLikeRateLimit("device", "like-limit-device");
    for (let attempt = 1; attempt <= 30; attempt += 1) {
      const response = await request(
        likePath,
        "POST",
        "like-limit-device",
        `192.0.2.${attempt}`,
      );
      assert.equal(response.status, 200);
    }
    const thirtyFirstDeviceLike = await request(
      likePath,
      "POST",
      "like-limit-device",
      "192.0.2.31",
    );
    assert.equal(thirtyFirstDeviceLike.status, 429);

    await seedLikeRateLimit("ip", "198.51.100.30");
    for (let attempt = 1; attempt <= 30; attempt += 1) {
      const response = await request(
        likePath,
        "POST",
        `like-ip-device-${attempt}`,
        "198.51.100.30",
      );
      assert.equal(response.status, 200);
    }
    const expectedIpHash = createHmac("sha256", testConfig.ipHashSecret)
      .update("ip:198.51.100.30")
      .digest("hex");
    const ipLimitState = await pool.query<{ request_count: number }>(
      `
        SELECT request_count FROM post_rate_limits
        WHERE action_type = 'like' AND subject_type = 'ip' AND subject_hash = $1
      `,
      [expectedIpHash],
    );
    assert.equal(ipLimitState.rows[0]?.request_count, 30);
    const thirtyFirstIpLike = await request(
      likePath,
      "POST",
      "like-ip-device-31",
      "198.51.100.30",
    );
    assert.equal(thirtyFirstIpLike.status, 429);

    const reportPath = `/posts/${interactionPost.id}/report`;
    const report = async (deviceId: string) => fetch(`${baseUrl}${reportPath}`, {
      method: "POST",
      headers: { "X-Device-Id": deviceId, "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "spam" }),
    });
    assert.deepEqual(await (await report("reporter-a")).json(), { report_count: 1 });
    assert.deepEqual(await (await report("reporter-a")).json(), { report_count: 1 });
    assert.deepEqual(await (await report("reporter-b")).json(), { report_count: 2 });
    assert.deepEqual(await (await report("reporter-c")).json(), { report_count: 3 });

    const status = await pool.query<{ status: string }>(
      "SELECT status FROM posts WHERE id = $1",
      [interactionPost.id],
    );
    assert.equal(status.rows[0]?.status, "hidden");

    const adminEmail = `${testPrefix}@example.test`;
    const adminPassword = "Test-Admin-Password-123";
    const adminPasswordHash = await bcrypt.hash(adminPassword, 4);
    const adminInsert = await pool.query<{ id: string }>(
      `
        INSERT INTO moderators (email, password_hash, role)
        VALUES ($1, $2, 'admin')
        RETURNING id
      `,
      [adminEmail, adminPasswordHash],
    );
    const adminId = adminInsert.rows[0]?.id;
    assert.ok(adminId);
    createdModeratorIds.push(adminId);

    const loginResponse = await fetch(`${baseUrl}/admin/login`, {
      method: "POST",
      headers: {
        Origin: baseUrl,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email: adminEmail, password: adminPassword }),
    });
    assert.equal(loginResponse.status, 200);
    const loginBody = await loginResponse.json() as { csrf_token: string };
    const adminCookie = loginResponse.headers.get("set-cookie")?.split(";")[0] ?? "";
    assert.ok(adminCookie.startsWith("__Host-admin_session="));

    const adminRequest = (
      path: string,
      method: string,
      csrfToken = loginBody.csrf_token,
      body?: unknown,
    ) => fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Origin: baseUrl,
        Cookie: adminCookie,
        "X-CSRF-Token": csrfToken,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const queueResponse = await fetch(`${baseUrl}/admin/queue`, {
      headers: { Cookie: adminCookie },
    });
    assert.equal(queueResponse.status, 200);
    const queue = await queueResponse.json() as {
      posts: { id: string; status: string }[];
    };
    assert.ok(queue.posts.some((post) => post.id === interactionPost.id && post.status === "hidden"));

    const approveResponse = await adminRequest(
      `/admin/posts/${interactionPost.id}/approve`,
      "POST",
      undefined,
      {},
    );
    assert.equal(approveResponse.status, 204);
    const undoResponse = await adminRequest(
      `/admin/posts/${interactionPost.id}/undo`,
      "POST",
      undefined,
      {},
    );
    assert.equal(undoResponse.status, 204);
    const hiddenAfterUndo = await pool.query<{ status: string }>(
      "SELECT status FROM posts WHERE id = $1",
      [interactionPost.id],
    );
    assert.equal(hiddenAfterUndo.rows[0]?.status, "hidden");

    const rejectResponse = await adminRequest(
      `/admin/posts/${heldNamePost.id}/reject`,
      "POST",
      undefined,
      {},
    );
    assert.equal(rejectResponse.status, 204);
    const rejectedOwnerResponse = await fetch(
      `${baseUrl}/posts/${heldNamePost.id}/owner`,
      { headers: { "X-Edit-Key": heldNamePost.edit_key } },
    );
    assert.equal(rejectedOwnerResponse.status, 410);
    const undoRejectResponse = await adminRequest(
      `/admin/posts/${heldNamePost.id}/undo`,
      "POST",
      undefined,
      {},
    );
    assert.equal(undoRejectResponse.status, 204);
    const afterUndoReject = await pool.query<{ status: string }>(
      "SELECT status FROM posts WHERE id = $1",
      [heldNamePost.id],
    );
    assert.equal(afterUndoReject.rows[0]?.status, "held");
    assert.equal((await adminRequest(
      `/admin/posts/${heldNamePost.id}/reject`,
      "POST",
      "X".repeat(43),
      {},
    )).status, 403);
    assert.equal((await adminRequest(
      `/admin/posts/${heldNamePost.id}/reject`,
      "POST",
      undefined,
      {},
    )).status, 204);
    const rejectedResponse = await fetch(`${baseUrl}/admin/rejected`, {
      headers: { Cookie: adminCookie },
    });
    assert.equal(rejectedResponse.status, 200);
    const rejected = await rejectedResponse.json() as {
      posts: { id: string }[];
    };
    assert.ok(rejected.posts.some((post) => post.id === heldNamePost.id));

    const restoreResponse = await adminRequest(
      `/admin/posts/${heldNamePost.id}/restore`,
      "POST",
      undefined,
      {},
    );
    assert.equal(restoreResponse.status, 204);
    const restored = await pool.query<{ status: string }>(
      "SELECT status FROM posts WHERE id = $1",
      [heldNamePost.id],
    );
    assert.equal(restored.rows[0]?.status, "held");

    assert.equal((await adminRequest(
      `/admin/posts/${heldNamePost.id}/reject`,
      "POST",
      undefined,
      {},
    )).status, 204);
    await pool.query(
      "UPDATE posts SET rejected_at = now() - interval '8 days' WHERE id = $1",
      [heldNamePost.id],
    );
    const expiredList = await fetch(`${baseUrl}/admin/rejected`, {
      headers: { Cookie: adminCookie },
    });
    const expiredBody = await expiredList.json() as { posts: { id: string }[] };
    assert.ok(!expiredBody.posts.some((post) => post.id === heldNamePost.id));
    await assert.rejects(
      createAdminService(pool).restoreRejectedPost(heldNamePost.id, adminId),
      { statusCode: 409 },
    );
    assert.equal(await createAdminService(pool).purgeExpiredRejectedPosts(), 1);

    const moderatorEmail = `${testPrefix}-moderator@example.test`;
    const moderatorResponse = await adminRequest(
      "/admin/moderators",
      "POST",
      undefined,
      {
        email: moderatorEmail,
        password: "Test-Moderator-Password-123",
        role: "moderator",
      },
    );
    assert.equal(moderatorResponse.status, 201);
    const createdModerator = await moderatorResponse.json() as {
      moderator: { id: string };
    };
    createdModeratorIds.push(createdModerator.moderator.id);

    const bannedTermsResponse = await adminRequest(
      "/admin/banned-terms",
      "PUT",
      undefined,
      { terms: [{ term: bannedTerm, type: "test" }, { term: "unsafe", type: "test" }] },
    );
    assert.equal(bannedTermsResponse.status, 200);

    const moderatorLogin = await fetch(`${baseUrl}/admin/login`, {
      method: "POST",
      headers: { Origin: baseUrl, "Content-Type": "application/json" },
      body: JSON.stringify({
        email: moderatorEmail,
        password: "Test-Moderator-Password-123",
      }),
    });
    assert.equal(moderatorLogin.status, 200);
    const moderatorCookie = moderatorLogin.headers.get("set-cookie")?.split(";")[0] ?? "";
    assert.ok(moderatorCookie);
    const moderatorForbidden = await fetch(`${baseUrl}/admin/moderators`, {
      headers: { Cookie: moderatorCookie },
    });
    assert.equal(moderatorForbidden.status, 403);

    const deactivateModerator = await adminRequest(
      `/admin/moderators/${createdModerator.moderator.id}`,
      "DELETE",
      undefined,
    );
    assert.equal(deactivateModerator.status, 204);
    const deactivated = await pool.query<{ active: boolean }>(
      "SELECT active FROM moderators WHERE id = $1",
      [createdModerator.moderator.id],
    );
    assert.equal(deactivated.rows[0]?.active, false);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const name = `${testPrefix}-device-limit-${attempt}`;
      createdNames.push(name);
      const response = await createRequest(
        name,
        "A rate limit test goal",
        "one-limited-device",
        `198.51.100.${attempt}`,
      );
      assert.equal(response.status, 201);
    }
    const fourthDevicePost = await createRequest(
      `${testPrefix}-device-limit-4`,
      "This post should be rate limited",
      "one-limited-device",
      "198.51.100.4",
    );
    assert.equal(fourthDevicePost.status, 429);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const name = `${testPrefix}-ip-limit-${attempt}`;
      createdNames.push(name);
      const response = await createRequest(
        name,
        "A rate limit test goal",
        `ip-limit-device-${attempt}`,
        "203.0.113.10",
      );
      assert.equal(response.status, 201);
    }
    const fourthIpPost = await createRequest(
      `${testPrefix}-ip-limit-4`,
      "This post should be rate limited",
      "ip-limit-device-4",
      "203.0.113.10",
    );
    assert.equal(fourthIpPost.status, 429);

    const rateSubjects = await pool.query<{ subject_hash: string }>(
      "SELECT subject_hash FROM post_rate_limits",
    );
    assert.ok(rateSubjects.rows.every((row) => /^[a-f0-9]{64}$/.test(row.subject_hash)));
    assert.ok(rateSubjects.rows.every((row) => row.subject_hash !== "203.0.113.10"));

    const storedDevices = await pool.query<{ device_id: string }>(
      "SELECT device_id FROM likes WHERE post_id = $1 UNION ALL SELECT device_id FROM reports WHERE post_id = $1",
      [interactionPost.id],
    );
    assert.ok(storedDevices.rows.every((row) => /^[a-f0-9]{64}$/.test(row.device_id)));
    assert.ok(storedDevices.rows.every((row) => !row.device_id.startsWith("reporter-")));

    const semestersResponse = await fetch(`${baseUrl}/admin/semesters`, {
      headers: { Cookie: adminCookie },
    });
    assert.equal(semestersResponse.status, 200);
    const semesters = await semestersResponse.json() as {
      semesters: { id: string; state: string }[];
    };
    assert.ok(semesters.semesters.some((semester) => semester.id === semesterId));

    if (createdSemester && semesterId) {
      const alreadyOpen = await adminRequest("/admin/semesters", "POST", undefined, {
        name: `${testPrefix} duplicate semester`,
        ends_on: "2027-12-31",
      });
      assert.equal(alreadyOpen.status, 409);

      const closeCurrent = await adminRequest(
        `/admin/semesters/${semesterId}/close`,
        "POST",
        undefined,
        {},
      );
      assert.equal(closeCurrent.status, 204);
      const closedState = await pool.query<{ state: string }>(
        "SELECT state FROM semesters WHERE id = $1",
        [semesterId],
      );
      assert.equal(closedState.rows[0]?.state, "closed");

      const nextSemesterResponse = await adminRequest(
        "/admin/semesters",
        "POST",
        undefined,
        { name: `${testPrefix} next semester`, ends_on: "2027-12-31" },
      );
      assert.equal(nextSemesterResponse.status, 201);
      const nextSemester = await nextSemesterResponse.json() as {
        semester: { id: string; state: string };
      };
      assert.equal(nextSemester.semester.state, "open");
      createdSemesterIds.push(nextSemester.semester.id);

      const closeNext = await adminRequest(
        `/admin/semesters/${nextSemester.semester.id}/close`,
        "POST",
        undefined,
        {},
      );
      assert.equal(closeNext.status, 204);

      const postAfterClosure = await createRequest(
        `${testPrefix}-post-after-close`,
        "This must not be accepted after the semester closes",
        "closed-semester-device",
        "192.0.2.80",
      );
      assert.equal(postAfterClosure.status, 409);
    } else {
      const secondOpen = await adminRequest("/admin/semesters", "POST", undefined, {
        name: `${testPrefix} conflicting semester`,
        ends_on: "2027-12-31",
      });
      assert.equal(secondOpen.status, 409);
    }

    const logoutResponse = await adminRequest("/admin/logout", "POST", undefined, {});
    assert.equal(logoutResponse.status, 204);
    const afterLogout = await fetch(`${baseUrl}/admin/queue`, {
      headers: { Cookie: adminCookie },
    });
    assert.equal(afterLogout.status, 401);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (createdNames.length) {
      await pool.query("DELETE FROM posts WHERE name_key = ANY($1::text[])", [
        createdNames.map((name) => name.toLowerCase()),
      ]);
    }
    if (createdSemesterIds.length) {
      await pool.query("DELETE FROM semesters WHERE id = ANY($1::uuid[])", [
        createdSemesterIds,
      ]);
    }
    if (createdModeratorIds.length) {
      await pool.query("DELETE FROM moderators WHERE id = ANY($1::uuid[])", [createdModeratorIds]);
    }
    await pool.query("DELETE FROM banned_terms WHERE type = 'test'");
    await pool.query("DELETE FROM banned_terms WHERE type = 'test' AND term = $1", [bannedTerm]);
    await pool.query("DELETE FROM post_rate_limits");
    if (usedCaptchaTokenHashes.size) {
      await pool.query("DELETE FROM used_captcha_tokens WHERE token_hash = ANY($1::text[])", [
        [...usedCaptchaTokenHashes],
      ]);
    }
    await pool.end();
  }
});