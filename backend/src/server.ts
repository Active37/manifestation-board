import { Pool } from "pg";
import { startScheduledCleanup } from "./admin/cleanup.js";
import { createAdminService } from "./admin/service.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createPostsService } from "./posts/service.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required");
}

const config = loadConfig();

const pool = new Pool({ connectionString });
const postsService = createPostsService(pool, config);
const adminService = createAdminService(pool);
const stopScheduledCleanup = startScheduledCleanup(async () => {
  const deleted = await Promise.all([
    adminService.purgeExpiredRejectedPosts(),
    adminService.purgeExpiredSessions(),
    postsService.purgeExpiredRateLimits(),
  ]);
  return deleted.reduce((total, count) => total + count, 0);
});
const server = createApp(pool, { config }).listen(config.port, () => {
  console.log(`API listening on port ${config.port}`);
});

async function shutdown(): Promise<void> {
  stopScheduledCleanup();
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());