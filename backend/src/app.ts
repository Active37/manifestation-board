import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import type { AdminApi } from "./admin/types.js";
import type { AppConfig } from "./config.js";
import { errorMiddleware, httpError } from "./errors.js";
import { requestIdMiddleware } from "./request-context.js";
import type { NamesService } from "./names/service.js";
import type { PostsApi } from "./posts/types.js";
import { adminRouter } from "./admin/controller.js";
import { healthRouter } from "./routes/health.js";
import { namesRouter } from "./routes/names.js";
import { postsRouter } from "./routes/posts.js";
import { semestersRouter } from "./routes/semesters.js";

export function createApp(
  config: Pick<
    AppConfig,
    | "corsOrigins"
    | "trustedProxies"
    | "requestTimeoutMs"
    | "nodeEnv"
    | "postCaptchaBypass"
  >,
  checkDb: () => Promise<void>,
  namesService: NamesService,
  postsApi: PostsApi,
  adminApi: AdminApi,
): Express {
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", config.trustedProxies);
  app.use(requestIdMiddleware);
  app.use((req, res, next) => {
    const timer = setTimeout(() => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.status(504).json({ error: "Request timed out" });
    }, config.requestTimeoutMs);
    res.once("finish", () => clearTimeout(timer));
    res.once("close", () => clearTimeout(timer));
    next();
  });
  app.use(helmet());
  app.use((req, _res, next) => {
    if (config.nodeEnv === "production" && !req.secure) {
      next(httpError(426, "HTTPS required"));
      return;
    }
    next();
  });
  app.use(
    cors({
      origin: (origin, callback) => {
        callback(null, origin !== undefined && config.corsOrigins.includes(origin));
      },
      credentials: true,
      exposedHeaders: ["X-Request-Id"],
      methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
      allowedHeaders: [
        "Content-Type",
        "Authorization",
        "X-Device-Id",
        "X-Edit-Key",
        "X-Captcha-Token",
        "X-CSRF-Token",
      ],
    }),
  );
  app.use((req, _res, next) => {
    const hasBody =
      req.headers["transfer-encoding"] !== undefined ||
      Number(req.headers["content-length"] ?? 0) > 0;
    if (!hasBody) {
      next();
      return;
    }

    if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
      next(httpError(400, "Request body is not allowed"));
      return;
    }
    if (!req.is("application/json")) {
      next(httpError(415, "Content-Type must be application/json"));
      return;
    }
    next();
  });
  app.use(express.json({ limit: "16kb" }));
  app.use(healthRouter(checkDb));
  app.use("/names", namesRouter(namesService, postsApi.checkNameRateLimit));
  app.use(
    "/posts",
    postsRouter(postsApi, config.corsOrigins, config.postCaptchaBypass),
  );
  app.use("/semesters", semestersRouter(postsApi));
  app.use("/admin", adminRouter(adminApi, config.corsOrigins));
  app.use(errorMiddleware);

  return app;
}
