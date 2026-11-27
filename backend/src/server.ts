import { createServer, type Server } from "node:http";
import { Pool } from "pg";
import { startScheduledCleanup } from "./admin/cleanup.js";
import { createAdminService } from "./admin/service.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { assertRuntimeRole } from "./db/permissions.js";
import { createPostsService } from "./posts/service.js";

const config = loadConfig();
const pool = new Pool({ connectionString: config.databaseUrl });
const postsService = createPostsService(pool, config);
const adminService = createAdminService(pool);
let server: Server | undefined;
let stopScheduledCleanup = () => {};

async function start(): Promise<void> {
  await pool.query("SELECT 1");
  if (config.nodeEnv === "production") {
    await assertRuntimeRole(pool);
  }
  stopScheduledCleanup = startScheduledCleanup(async () => {
    const deleted = await Promise.all([
      adminService.purgeExpiredRejectedPosts(),
      adminService.purgeExpiredSessions(),
      postsService.purgeExpiredRateLimits(),
      postsService.purgeExpiredCaptchaTokens(),
    ]);
    return deleted.reduce((total, count) => total + count, 0);
  });

  const app = createApp(pool, { config });
  server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server?.once("error", reject);
    server?.listen(config.port, () => resolve());
  });
  console.log(`API listening on port ${config.port}`);
}

async function shutdown(): Promise<void> {
  stopScheduledCleanup();
  if (server?.listening) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  }
  await pool.end();
}

void start().catch(async () => {
  console.error("API startup failed; verify database TLS and runtime-role grants.");
  await pool.end();
  process.exitCode = 1;
});

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());