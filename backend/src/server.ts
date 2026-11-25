import { Pool } from "pg";
import {
  startRejectedPostCleanup,
  startSecurityDataCleanup,
} from "./admin/cleanup.js";
import { createAdminService } from "./admin/service.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createNamesService } from "./names/service.js";
import { verifyTurnstile } from "./posts/captcha.js";
import { createPostsFeedService, type FeedRow } from "./posts/feed.js";
import { createPostsService } from "./posts/service.js";
import { createApiServer } from "./http.js";
import {
  assertInteractionDeviceSchema,
  assertRuntimeRole,
} from "./db/permissions.js";

const config = loadConfig();
const pool = new Pool({
  connectionString: config.databaseUrl,
  max: config.dbPoolMax,
  connectionTimeoutMillis: config.dbConnectionTimeoutMs,
  statement_timeout: config.dbStatementTimeoutMs,
  query_timeout: config.dbQueryTimeoutMs,
});
const namesService = createNamesService(async (nameKeys) => {
  const result = await pool.query<{ name_key: string }>(
    "SELECT name_key FROM posts WHERE name_key = ANY($1::text[])",
    [nameKeys],
  );
  return result.rows.map((row) => row.name_key);
});
const postsService = createPostsService(pool, config);
const adminService = createAdminService(pool, config);
const postsFeedService = createPostsFeedService(async (sql, values) => {
  const result = await pool.query<FeedRow>(sql, values);
  return result.rows;
});
const app = createApp(
  config,
  async () => {
    await pool.query("SELECT 1");
  },
  namesService,
  {
    verifyCaptcha: (token) =>
      verifyTurnstile(token, config.turnstileSecretKey, {
        hostname: config.turnstileExpectedHostname,
        action: config.turnstileExpectedAction,
      }),
    checkPostRateLimit: postsService.checkPostRateLimit,
    checkNameRateLimit: postsService.checkNameRateLimit,
    createPost: postsService.createPost,
    patchPost: postsService.patchPost,
    updateProgress: postsService.updateProgress,
    deletePost: postsService.deletePost,
    addLike: postsService.addLike,
    removeLike: postsService.removeLike,
    reportPost: postsService.reportPost,
    listPosts: postsFeedService.listPosts,
    listAchievedPosts: postsFeedService.listAchievedPosts,
    listFeaturedPosts: postsFeedService.listFeaturedPosts,
    getRandomPost: postsFeedService.getRandomPost,
    listCategories: postsService.listCategories,
    listArchivedSemesters: postsService.listArchivedSemesters,
    listArchivedSemesterPosts: postsService.listArchivedSemesterPosts,
  },
  adminService,
);
const server = createApiServer(app, config);
let stopRejectedPostCleanup: (() => void) | undefined;
let stopSecurityDataCleanup: (() => void) | undefined;

async function start(): Promise<void> {
  await assertInteractionDeviceSchema(pool);
  if (config.nodeEnv === "production") {
    await assertRuntimeRole(pool);
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  console.log(`API listening on port ${config.port}`);
  stopRejectedPostCleanup = startRejectedPostCleanup(
    adminService.purgeRejectedPosts,
  );
  stopSecurityDataCleanup = startSecurityDataCleanup(
    async () => {
      const deleted = await Promise.all([
        postsService.purgeExpiredSecurityRecords(),
        adminService.purgeExpiredAuthData(),
      ]);
      return deleted.reduce((total, count) => total + count, 0);
    },
  );
}

async function close(): Promise<void> {
  stopRejectedPostCleanup?.();
  stopSecurityDataCleanup?.();
  if (server.listening) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await pool.end();
}

void start().catch(async () => {
  console.error("API startup failed; verify database connectivity and role privileges.");
  await pool.end();
  process.exitCode = 1;
});

process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
