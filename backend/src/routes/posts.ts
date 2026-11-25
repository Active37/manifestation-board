import { Router } from "express";
import { createPostsController } from "../posts/controller.js";
import type { PostsApi } from "../posts/types.js";

export function postsRouter(
  api: PostsApi,
  allowedOrigins: string[],
  captchaBypass = false,
): Router {
  const router = Router();
  const controller = createPostsController(api, allowedOrigins, captchaBypass);

  router.get("/categories", controller.categories);
  router.get("/achieved", controller.achieved);
  router.get("/featured", controller.featured);
  router.get("/trending", controller.trending);
  router.get("/random", controller.random);
  router.get("/", controller.list);
  router.post("/", controller.create);
  router.patch("/:id", controller.patch);
  router.patch("/:id/progress", controller.updateProgress);
  router.delete("/:id", controller.remove);
  router.post("/:id/like", controller.like);
  router.delete("/:id/like", controller.unlike);
  router.post("/:id/report", controller.report);

  return router;
}
