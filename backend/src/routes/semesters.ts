import { Router } from "express";
import { createPostsController } from "../posts/controller.js";
import type { PostsApi } from "../posts/types.js";

export function semestersRouter(api: PostsApi): Router {
  const router = Router();
  const controller = createPostsController(api);

  router.get("/", controller.archivedSemesters);
  router.get("/:id/posts", controller.archivedSemesterPosts);

  return router;
}
