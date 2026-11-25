import { createHash, randomBytes } from "node:crypto";
import type { Request, RequestHandler } from "express";
import { z } from "zod";
import { categorySlugSchema } from "../categories.js";
import { httpError } from "../errors.js";
import { normalizeName } from "../names/service.js";
import { sanitizeText } from "../text.js";
import { getDeviceIdentity } from "./device-cookie.js";
import {
  feedSorts,
  progressStatuses,
  reportReasons,
  type PostsApi,
} from "./types.js";

const postBodySchema = z
  .object({
    displayName: z
      .string()
      .max(120)
      .transform(sanitizeText)
      .pipe(z.string().min(1).max(120)),
    body: z
      .string()
      .transform(sanitizeText)
      .pipe(z.string().min(1).max(300)),
    category: categorySlugSchema
      .transform(sanitizeText)
      .nullable()
      .default(null),
    captchaToken: z.string().min(1).max(2048).optional(),
  })
  .strict();

const postParamsSchema = z.object({ id: z.string().uuid() }).strict();
const emptyQuerySchema = z.object({}).strict();
const emptyBodySchema = z.object({}).strict();
const archivedSemesterParamsSchema = z.object({ id: z.string().uuid() }).strict();
const editKeySchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const progressBodySchema = z
  .object({ progressStatus: z.enum(progressStatuses) })
  .strict();
const patchBodySchema = z
  .object({
    displayName: z
      .string()
      .max(120)
      .transform(sanitizeText)
      .pipe(z.string().min(1).max(120))
      .optional(),
    body: z.string().transform(sanitizeText).pipe(z.string().min(1).max(300)).optional(),
    category: categorySlugSchema
      .transform(sanitizeText)
      .nullable()
      .optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0);
const reportBodySchema = z
  .object({
    reason: z.enum(reportReasons),
    detail: z
      .string()
      .max(1000)
      .transform(sanitizeText)
      .pipe(z.string().min(1).max(1000))
      .nullable()
      .default(null),
  })
  .strict();
const feedQuerySchema = z
  .object({
    sort: z.enum(feedSorts).optional(),
    search: z
      .string()
      .max(100)
      .transform(normalizeName)
      .pipe(z.string().min(1).max(100))
      .optional(),
    category: categorySlugSchema.optional(),
    cursor: z.string().min(1).max(4096).optional(),
  })
  .strict();
const achievedQuerySchema = z.object({}).strict();
const trendingQuerySchema = z
  .object({ cursor: z.string().min(1).max(4096).optional() })
  .strict();
const archivedSemesterQuerySchema = z
  .object({ cursor: z.string().min(1).max(4096).optional() })
  .strict();

function postId(req: Request): string {
  if (!emptyQuerySchema.safeParse(req.query).success) {
    throw httpError(400, "Invalid post request");
  }
  const params = postParamsSchema.safeParse(req.params);
  if (!params.success) {
    throw httpError(400, "Invalid post request");
  }
  return params.data.id;
}

function postIdentity(req: Request): { id: string; editKey: string } {
  const id = postId(req);
  const editKey = editKeySchema.safeParse(req.get("X-Edit-Key"));
  if (!editKey.success) {
    throw httpError(400, "Invalid post request");
  }
  return { id, editKey: editKey.data };
}

export function createPostsController(
  api: PostsApi,
  allowedOrigins: string[] = [],
  captchaBypass = false,
): {
  create: RequestHandler;
  list: RequestHandler;
  patch: RequestHandler;
  updateProgress: RequestHandler;
  remove: RequestHandler;
  like: RequestHandler;
  unlike: RequestHandler;
  report: RequestHandler;
  achieved: RequestHandler;
  featured: RequestHandler;
  categories: RequestHandler;
  trending: RequestHandler;
  random: RequestHandler;
  archivedSemesters: RequestHandler;
  archivedSemesterPosts: RequestHandler;
} {
  return {
    create: async (req, res) => {
      if (!emptyQuerySchema.safeParse(req.query).success) {
        throw httpError(400, "Invalid post request");
      }
      const parsed = postBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw httpError(400, "Invalid post request");
      }
      if (!captchaBypass && !parsed.data.captchaToken) {
        throw httpError(400, "Invalid post request");
      }

      const identity = getDeviceIdentity(req, res, allowedOrigins);

      await api.checkPostRateLimit(identity.deviceId, identity.ip);
      const { captchaToken, ...post } = parsed.data;
      let captchaTokenHash: string;
      if (captchaBypass) {
        captchaTokenHash = createHash("sha256")
          .update(randomBytes(32).toString("base64url"))
          .digest("hex");
      } else {
        if (!captchaToken || !(await api.verifyCaptcha(captchaToken))) {
          throw httpError(400, "CAPTCHA verification failed");
        }
        captchaTokenHash = createHash("sha256")
          .update(captchaToken)
          .digest("hex");
      }

      const created = await api.createPost(post, captchaTokenHash);
      res.status(201).json(created);
    },
    list: async (req, res) => {
      const parsed = feedQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw httpError(400, "Invalid feed query");
      }

      if (
        parsed.data.category !== undefined &&
        !(await api.listCategories()).includes(parsed.data.category)
      ) {
        throw httpError(400, "Invalid feed category");
      }
      res.json(await api.listPosts(parsed.data));
    },
    categories: async (req, res) => {
      if (!achievedQuerySchema.safeParse(req.query).success) {
        throw httpError(400, "Invalid categories query");
      }
      res.json({ categories: await api.listCategories() });
    },
    achieved: async (req, res) => {
      if (!achievedQuerySchema.safeParse(req.query).success) {
        throw httpError(400, "Invalid achieved-goals query");
      }
      res.json({ posts: await api.listAchievedPosts() });
    },
    featured: async (req, res) => {
      if (!achievedQuerySchema.safeParse(req.query).success) {
        throw httpError(400, "Invalid featured-posts query");
      }
      res.json({ posts: await api.listFeaturedPosts() });
    },
    trending: async (req, res) => {
      const parsed = trendingQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw httpError(400, "Invalid trending-posts query");
      }
      res.json(
        await api.listPosts({
          sort: "most-liked-today",
          cursor: parsed.data.cursor,
        }),
      );
    },
    random: async (req, res) => {
      if (!achievedQuerySchema.safeParse(req.query).success) {
        throw httpError(400, "Invalid random-post query");
      }
      res.json({ post: await api.getRandomPost() });
    },
    archivedSemesters: async (req, res) => {
      if (!achievedQuerySchema.safeParse(req.query).success) {
        throw httpError(400, "Invalid archived-semesters query");
      }
      res.json({ semesters: await api.listArchivedSemesters() });
    },
    archivedSemesterPosts: async (req, res) => {
      const params = archivedSemesterParamsSchema.safeParse(req.params);
      const query = archivedSemesterQuerySchema.safeParse(req.query);
      if (!params.success || !query.success) {
        throw httpError(400, "Invalid archived-semester query");
      }
      res.json(
        await api.listArchivedSemesterPosts(
          params.data.id,
          query.data.cursor,
        ),
      );
    },
    patch: async (req, res) => {
      const identity = postIdentity(req);
      const parsed = patchBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw httpError(400, "Invalid post request");
      }

      res.json(
        await api.patchPost(identity.id, identity.editKey, parsed.data),
      );
    },
    updateProgress: async (req, res) => {
      const identity = postIdentity(req);
      const parsed = progressBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw httpError(400, "Invalid progress request");
      }
      const progressUpdate = await api.updateProgress(
        identity.id,
        identity.editKey,
        parsed.data.progressStatus,
      );
      res.json(progressUpdate);
    },
    remove: async (req, res) => {
      const identity = postIdentity(req);
      if (!emptyBodySchema.safeParse(req.body ?? {}).success) {
        throw httpError(400, "Invalid post request");
      }
      await api.deletePost(identity.id, identity.editKey);
      res.status(204).end();
    },
    like: async (req, res) => {
      const id = postId(req);
      if (!emptyBodySchema.safeParse(req.body ?? {}).success) {
        throw httpError(400, "Invalid interaction request");
      }
      const identity = getDeviceIdentity(req, res, allowedOrigins);
      await api.addLike(id, identity.deviceId, identity.ip);
      res.status(204).end();
    },
    unlike: async (req, res) => {
      const id = postId(req);
      if (!emptyBodySchema.safeParse(req.body ?? {}).success) {
        throw httpError(400, "Invalid interaction request");
      }
      const identity = getDeviceIdentity(req, res, allowedOrigins);
      await api.removeLike(id, identity.deviceId, identity.ip);
      res.status(204).end();
    },
    report: async (req, res) => {
      const id = postId(req);
      const parsed = reportBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw httpError(400, "Invalid report request");
      }
      const identity = getDeviceIdentity(req, res, allowedOrigins);

      await api.reportPost(
        id,
        identity.deviceId,
        identity.ip,
        parsed.data.reason,
        parsed.data.detail,
      );
      res.status(204).end();
    },
  };
}
