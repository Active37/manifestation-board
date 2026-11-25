import { createHash, timingSafeEqual } from "node:crypto";
import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { categorySlugSchema } from "../categories.js";
import { httpError } from "../errors.js";
import { normalizeForMatch } from "../filter/service.js";
import { normalizeAdminEmail } from "./service.js";
import { sanitizeText } from "../text.js";
import {
  adminRoles,
  type AdminApi,
  type AdminSession,
  type BannedTerm,
} from "./types.js";

const sessionCookie = "__Host-admin_session";
const sessionDurationMs = 8 * 60 * 60 * 1000;

const passwordSchema = z
  .string()
  .min(12)
  .max(128)
  .refine((password) => Buffer.byteLength(password, "utf8") <= 72);
const loginSchema = z
  .object({
    email: z
      .string()
      .transform(normalizeAdminEmail)
      .pipe(z.string().email().max(320)),
    password: passwordSchema,
  })
  .strict();
const moderatorSchema = z
  .object({
    email: z
      .string()
      .transform(normalizeAdminEmail)
      .pipe(z.string().email().max(320)),
    password: passwordSchema,
    role: z.enum(adminRoles),
  })
  .strict();
const moderatorParamsSchema = z.object({ id: z.string().uuid() }).strict();
const postParamsSchema = z.object({ id: z.string().uuid() }).strict();
const semesterParamsSchema = z.object({ id: z.string().uuid() }).strict();
const emptyQuerySchema = z.object({}).strict();
const emptyBodySchema = z.object({}).strict();
const bannedTermSchema = z
  .object({
    term: z
      .string()
      .transform(sanitizeText)
      .pipe(
        z
          .string()
          .min(1)
          .max(100)
          .refine((term) => normalizeForMatch(term).length > 0),
      ),
    type: z
      .string()
      .transform(sanitizeText)
      .pipe(z.string().min(1).max(40)),
  })
  .strict();
const bannedTermsSchema = z
  .object({ terms: z.array(bannedTermSchema).max(500) })
  .strict();
const categoriesSchema = z
  .object({ categories: z.array(categorySlugSchema).max(100) })
  .strict();
const analyticsQuerySchema = z
  .object({ semesterId: z.string().uuid().optional() })
  .strict();

function hasDuplicateTerms(terms: BannedTerm[]): boolean {
  const keys = new Set<string>();
  for (const { term, type } of terms) {
    const key = `${type.toLowerCase()}\0${normalizeForMatch(term)}`;
    if (keys.has(key)) {
      return true;
    }
    keys.add(key);
  }
  return false;
}

function isAllowedOrigin(origin: string | undefined, origins: string[]): boolean {
  return origin !== undefined && origins.includes(origin);
}

function requireAllowedOrigin(origins: string[]): RequestHandler {
  return (req, _res, next) => {
    if (!isAllowedOrigin(req.get("Origin"), origins)) {
      next(httpError(403, "Request origin not allowed"));
      return;
    }
    next();
  };
}

function readSessionCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) {
    return null;
  }
  const values = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${sessionCookie}=`));
  if (values.length !== 1) {
    return null;
  }

  const token = values[0]?.slice(sessionCookie.length + 1);
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

function matchesCsrfHash(expectedHash: string, token: string | undefined): boolean {
  if (
    !token ||
    !/^[A-Za-z0-9_-]{43}$/.test(token) ||
    !/^[a-f0-9]{64}$/i.test(expectedHash)
  ) {
    return false;
  }
  const expected = Buffer.from(expectedHash, "hex");
  const actual = createHash("sha256").update(token).digest();
  return timingSafeEqual(actual, expected);
}

export function adminRouter(api: AdminApi, corsOrigins: string[]) {
  const router = Router();
  const originCheck = requireAllowedOrigin(corsOrigins);

  const requireSession: RequestHandler = async (req, res, next) => {
    const token = readSessionCookie(req.get("Cookie"));
    if (!token) {
      throw httpError(401, "Authentication required");
    }
    const session = await api.getSession(token);
    if (!session) {
      throw httpError(401, "Authentication required");
    }
    res.locals.admin = session satisfies AdminSession;
    next();
  };

  const requireAdmin: RequestHandler = async (_req, res, next) => {
    const session = res.locals.admin as AdminSession | undefined;
    if (!session) {
      next(httpError(401, "Authentication required"));
      return;
    }
    if (session.role !== "admin") {
      await api.recordAuthorizationFailure(session.id);
      next(httpError(403, "Admin access required"));
      return;
    }
    next();
  };

  const requireStaff: RequestHandler = (_req, res, next) => {
    const session = res.locals.admin as AdminSession | undefined;
    if (!session) {
      next(httpError(401, "Authentication required"));
      return;
    }
    if (session.role !== "admin" && session.role !== "moderator") {
      next(httpError(403, "Staff access required"));
      return;
    }
    next();
  };

  const requireCsrf: RequestHandler = (req, res, next) => {
    const session = res.locals.admin as AdminSession | undefined;
    if (!session || !matchesCsrfHash(session.csrfHash, req.get("X-CSRF-Token"))) {
      next(httpError(403, "Invalid CSRF token"));
      return;
    }
    next();
  };

  router.post("/login", originCheck, async (req, res) => {
    if (!emptyQuerySchema.safeParse(req.query).success) {
      throw httpError(400, "Invalid login request");
    }
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success || !req.ip) {
      throw httpError(400, "Invalid login request");
    }

    const session = await api.login(
      parsed.data.email,
      parsed.data.password,
      req.ip,
    );
    res.cookie(sessionCookie, session.sessionToken, {
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      path: "/",
      maxAge: sessionDurationMs,
    });
    res.json({ csrfToken: session.csrfToken });
  });

  router.post("/logout", originCheck, async (req, res) => {
    if (
      !emptyQuerySchema.safeParse(req.query).success ||
      !emptyBodySchema.safeParse(req.body ?? {}).success
    ) {
      throw httpError(400, "Invalid logout request");
    }

    const token = readSessionCookie(req.get("Cookie"));
    if (token) {
      const session = await api.getSession(token);
      if (session && !matchesCsrfHash(session.csrfHash, req.get("X-CSRF-Token"))) {
        throw httpError(403, "Invalid CSRF token");
      }
      await api.logout(token);
    }

    res.clearCookie(sessionCookie, {
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      path: "/",
    });
    res.status(204).end();
  });

  router.get("/moderators", requireSession, requireAdmin, async (req, res) => {
    if (!emptyQuerySchema.safeParse(req.query).success) {
      throw httpError(400, "Invalid moderator query");
    }
    res.json({ moderators: await api.listModerators() });
  });

  router.post(
    "/moderators",
    originCheck,
    requireSession,
    requireAdmin,
    requireCsrf,
    async (req, res) => {
      if (!emptyQuerySchema.safeParse(req.query).success) {
        throw httpError(400, "Invalid moderator request");
      }
      const parsed = moderatorSchema.safeParse(req.body);
      if (!parsed.success) {
        throw httpError(400, "Invalid moderator request");
      }

      const moderator = await api.createModerator(
        parsed.data.email,
        parsed.data.password,
        parsed.data.role,
        (res.locals.admin as AdminSession).id,
      );
      res.status(201).json({ moderator });
    },
  );

  router.delete(
    "/moderators/:id",
    originCheck,
    requireSession,
    requireAdmin,
    requireCsrf,
    async (req, res) => {
      const parsed = moderatorParamsSchema.safeParse(req.params);
      if (
        !parsed.success ||
        !emptyQuerySchema.safeParse(req.query).success
      ) {
        throw httpError(400, "Invalid moderator request");
      }
      await api.deleteModerator(
        parsed.data.id,
        (res.locals.admin as AdminSession).id,
      );
      res.status(204).end();
    },
  );

  router.get("/queue", requireSession, requireStaff, async (req, res) => {
    if (!emptyQuerySchema.safeParse(req.query).success) {
      throw httpError(400, "Invalid moderation query");
    }
    res.json({ posts: await api.getModerationQueue() });
  });

  router.get("/rejected", requireSession, requireStaff, async (req, res) => {
    if (!emptyQuerySchema.safeParse(req.query).success) {
      throw httpError(400, "Invalid moderation query");
    }
    res.json({ posts: await api.getRejectedPosts() });
  });

  router.get("/banned-terms", requireSession, requireAdmin, async (req, res) => {
    if (!emptyQuerySchema.safeParse(req.query).success) {
      throw httpError(400, "Invalid banned-terms query");
    }
    res.json({ terms: await api.getBannedTerms() });
  });

  router.put(
    "/banned-terms",
    originCheck,
    requireSession,
    requireAdmin,
    requireCsrf,
    async (req, res) => {
      if (!emptyQuerySchema.safeParse(req.query).success) {
        throw httpError(400, "Invalid banned-terms request");
      }
      const parsed = bannedTermsSchema.safeParse(req.body);
      if (!parsed.success) {
        throw httpError(400, "Invalid banned-terms request");
      }
      if (hasDuplicateTerms(parsed.data.terms)) {
        throw httpError(400, "Invalid banned-terms request");
      }

      await api.replaceBannedTerms(
        parsed.data.terms,
        (res.locals.admin as AdminSession).id,
      );
      res.json({ terms: parsed.data.terms });
    },
  );

  router.get("/categories", requireSession, requireAdmin, async (req, res) => {
    if (!emptyQuerySchema.safeParse(req.query).success) {
      throw httpError(400, "Invalid categories query");
    }
    res.json({ categories: await api.getCategories() });
  });

  router.get("/analytics", requireSession, requireAdmin, async (req, res) => {
    const parsed = analyticsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw httpError(400, "Invalid analytics query");
    }
    res.json(await api.getAnalytics(parsed.data.semesterId ?? null));
  });

  router.post(
    "/semesters/:id/archive",
    originCheck,
    requireSession,
    requireAdmin,
    requireCsrf,
    async (req, res) => {
      const params = semesterParamsSchema.safeParse(req.params);
      const body = emptyBodySchema.safeParse(req.body ?? {});
      if (
        !params.success ||
        !body.success ||
        !emptyQuerySchema.safeParse(req.query).success
      ) {
        throw httpError(400, "Invalid semester archive request");
      }
      await api.archiveSemester(
        params.data.id,
        (res.locals.admin as AdminSession).id,
      );
      res.status(204).end();
    },
  );

  router.put(
    "/categories",
    originCheck,
    requireSession,
    requireAdmin,
    requireCsrf,
    async (req, res) => {
      if (!emptyQuerySchema.safeParse(req.query).success) {
        throw httpError(400, "Invalid categories request");
      }
      const parsed = categoriesSchema.safeParse(req.body);
      if (
        !parsed.success ||
        new Set(parsed.data.categories).size !== parsed.data.categories.length
      ) {
        throw httpError(400, "Invalid categories request");
      }

      await api.replaceCategories(
        parsed.data.categories,
        (res.locals.admin as AdminSession).id,
      );
      res.json({ categories: parsed.data.categories });
    },
  );

  function addPostAction(
    path: string,
    action: (id: string, moderatorId: string) => Promise<void>,
  ): void {
    router.post(
      path,
      originCheck,
      requireSession,
      requireStaff,
      requireCsrf,
      async (req, res) => {
        const params = postParamsSchema.safeParse(req.params);
        const body = emptyBodySchema.safeParse(req.body ?? {});
        if (
          !params.success ||
          !body.success ||
          !emptyQuerySchema.safeParse(req.query).success
        ) {
          throw httpError(400, "Invalid moderation request");
        }
        const session = res.locals.admin as AdminSession;
        await action(params.data.id, session.id);
        res.status(204).end();
      },
    );
  }

  addPostAction("/posts/:id/approve", api.approvePost);
  addPostAction("/posts/:id/reject", api.rejectPost);
  addPostAction("/posts/:id/undo", api.undoModeration);
  addPostAction("/posts/:id/restore", api.restoreRejectedPost);

  router.post(
    "/posts/:id/feature",
    originCheck,
    requireSession,
    requireAdmin,
    requireCsrf,
    async (req, res) => {
      const params = postParamsSchema.safeParse(req.params);
      const body = emptyBodySchema.safeParse(req.body ?? {});
      if (
        !params.success ||
        !body.success ||
        !emptyQuerySchema.safeParse(req.query).success
      ) {
        throw httpError(400, "Invalid feature request");
      }
      await api.featurePost(params.data.id, (res.locals.admin as AdminSession).id);
      res.status(204).end();
    },
  );

  router.delete(
    "/posts/:id/feature",
    originCheck,
    requireSession,
    requireAdmin,
    requireCsrf,
    async (req, res) => {
      const params = postParamsSchema.safeParse(req.params);
      const body = emptyBodySchema.safeParse(req.body ?? {});
      if (
        !params.success ||
        !body.success ||
        !emptyQuerySchema.safeParse(req.query).success
      ) {
        throw httpError(400, "Invalid feature request");
      }
      await api.unfeaturePost(
        params.data.id,
        (res.locals.admin as AdminSession).id,
      );
      res.status(204).end();
    },
  );

  return router;
}
