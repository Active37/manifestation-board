import { Router } from "express";
import { z } from "zod";
import { ApiError } from "../errors.js";
import { createPostsFeedService } from "./feed.js";
import { createPostsService } from "./service.js";
import { feedSorts, postCategories, reportReasons } from "./types.js";

const postBodySchema = z.object({
  display_name: z.string().trim().min(1),
  body: z.string().trim().min(1).max(300),
  category: z.enum(postCategories).nullable().optional(),
  captcha_token: z.string().min(1).max(2048),
}).strict();

const patchBodySchema = z.object({
  display_name: z.string().trim().min(1).optional(),
  body: z.string().trim().min(1).max(300).optional(),
  category: z.enum(postCategories).nullable().optional(),
}).strict().refine((value) => Object.keys(value).length > 0);

const reportBodySchema = z.object({
  reason: z.enum(reportReasons),
  detail: z.string().nullable().optional(),
}).strict();

const postParamsSchema = z.object({ id: z.string().uuid() }).strict();
const feedQuerySchema = z.object({
  sort: z.enum(feedSorts).optional(),
  search: z.string().trim().min(1).optional(),
  cursor: z.string().min(1).max(4096).optional(),
}).strict();

type PostsService = ReturnType<typeof createPostsService>;
type PostsFeedService = ReturnType<typeof createPostsFeedService>;
type PostsRouterOptions = { verifyCaptcha: (token: string) => Promise<boolean> };

function parsedDeviceId(value: string | undefined): string {
  const parsed = z.string().min(1).max(200).safeParse(value);
  if (!parsed.success) {
    throw new ApiError(400, "A valid X-Device-Id header is required");
  }
  return parsed.data;
}

function postId(params: unknown): string {
  const parsed = postParamsSchema.safeParse(params);
  if (!parsed.success) {
    throw new ApiError(400, "Invalid post ID");
  }
  return parsed.data.id;
}

export function postsRouter(
  service: PostsService,
  feed: PostsFeedService,
  options: PostsRouterOptions,
): Router {
  const router = Router();

  router.get("/", async (req, res) => {
    const parsed = feedQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ApiError(400, "Invalid feed query");
    }
    res.json(await feed.listPosts(parsed.data));
  });

  router.post("/", async (req, res) => {
    const parsed = postBodySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError(400, "Invalid post request");
    }
    const deviceId = parsedDeviceId(req.get("X-Device-Id"));
    if (!req.ip) {
      throw new ApiError(400, "Invalid client address");
    }
    await service.checkPostRateLimit(deviceId, req.ip);
    if (!(await options.verifyCaptcha(parsed.data.captcha_token))) {
      throw new ApiError(400, "CAPTCHA verification failed");
    }
    const { captcha_token: _captchaToken, ...input } = parsed.data;
    res.status(201).json(await service.createPost(input));
  });

  router.patch("/:id", async (req, res) => {
    const id = postId(req.params);
    const editKey = z.string().regex(/^[A-Za-z0-9_-]{43}$/).safeParse(req.get("X-Edit-Key"));
    const parsed = patchBodySchema.safeParse(req.body);
    if (!editKey.success || !parsed.success) {
      throw new ApiError(400, "Invalid post edit request");
    }
    res.json(await service.patchPost(id, editKey.data, parsed.data));
  });

  router.delete("/:id", async (req, res) => {
    const id = postId(req.params);
    const editKey = z.string().regex(/^[A-Za-z0-9_-]{43}$/).safeParse(req.get("X-Edit-Key"));
    if (!editKey.success) {
      throw new ApiError(400, "Invalid post edit request");
    }
    await service.deletePost(id, editKey.data);
    res.status(204).end();
  });

  router.post("/:id/like", async (req, res) => {
    const id = postId(req.params);
    if (!req.ip) {
      throw new ApiError(400, "Invalid client address");
    }
    const likeCount = await service.addLike(
      id,
      parsedDeviceId(req.get("X-Device-Id")),
      req.ip,
    );
    res.json({ like_count: likeCount });
  });

  router.delete("/:id/like", async (req, res) => {
    const id = postId(req.params);
    if (!req.ip) {
      throw new ApiError(400, "Invalid client address");
    }
    const likeCount = await service.removeLike(
      id,
      parsedDeviceId(req.get("X-Device-Id")),
      req.ip,
    );
    res.json({ like_count: likeCount });
  });

  router.post("/:id/report", async (req, res) => {
    const id = postId(req.params);
    const parsed = reportBodySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError(400, "Invalid report request");
    }
    const reportCount = await service.reportPost(
      id,
      parsedDeviceId(req.get("X-Device-Id")),
      parsed.data.reason,
      parsed.data.detail ?? null,
    );
    res.json({ report_count: reportCount });
  });

  return router;
}