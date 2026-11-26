import express, {
  type ErrorRequestHandler,
  type Express,
} from "express";
import cors from "cors";
import helmet from "helmet";
import type { Pool } from "pg";
import { adminRouter } from "./admin/controller.js";
import { createAdminService } from "./admin/service.js";
import { loadConfig, type AppConfig } from "./config.js";
import { ApiError } from "./errors.js";
import { namesRouter } from "./names/controller.js";
import { createNamesService } from "./names/service.js";
import { postsRouter } from "./posts/controller.js";
import { createPostsFeedService } from "./posts/feed.js";
import { createPostsService } from "./posts/service.js";
import { verifyTurnstile } from "./posts/captcha.js";

type AppOptions = {
  config?: AppConfig;
  verifyCaptcha?: (token: string) => Promise<boolean>;
};

export function createApp(pool: Pool, options: AppOptions = {}): Express {
  const config = options.config ?? loadConfig();
  const app = express();
  const postsService = createPostsService(pool, config);
  const postsFeedService = createPostsFeedService(pool);
  const namesService = createNamesService(pool);
  const adminService = createAdminService(pool);
  const verifyCaptcha = options.verifyCaptcha ?? ((token: string) =>
    verifyTurnstile(token, config.turnstileSecretKey));

  app.disable("x-powered-by");
  app.set("trust proxy", config.trustedProxies);
  app.use(helmet());
  app.use(cors({
    origin: (origin, callback) => {
      callback(null, origin !== undefined && config.corsOrigins.includes(origin));
    },
    credentials: true,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-Device-Id", "X-Edit-Key"],
  }));
  app.use(express.json({ limit: "16kb" }));
  app.use("/names", namesRouter(namesService));
  app.use("/posts", postsRouter(postsService, postsFeedService, { verifyCaptcha }));
  app.use("/admin", adminRouter(adminService, config.corsOrigins));
  app.use(((error, _req, res, _next) => {
    if (error instanceof ApiError) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }
    if (
      typeof error === "object" &&
      error !== null &&
      "type" in error &&
      error.type === "entity.too.large"
    ) {
      res.status(413).json({ error: "Request body is too large" });
      return;
    }
    console.error("Unhandled API error", error);
    res.status(500).json({ error: "Internal server error" });
  }) satisfies ErrorRequestHandler);

  return app;
}