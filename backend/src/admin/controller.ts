import { createHash, timingSafeEqual } from "node:crypto";
import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { ApiError } from "../errors.js";
import type { createAdminService } from "./service.js";

const sessionCookie = "__Host-admin_session";
const sessionDurationMs = 8 * 60 * 60 * 1000;
const passwordSchema = z.string().min(12).max(128).refine((value) => Buffer.byteLength(value, "utf8") <= 72);
const loginSchema = z.object({
  email: z.string().trim().email().max(320),
  password: passwordSchema,
}).strict();
const moderatorSchema = z.object({
  email: z.string().trim().email().max(320),
  password: passwordSchema,
  role: z.enum(["admin", "moderator"]),
}).strict();
const moderatorParamsSchema = z.object({ id: z.string().uuid() }).strict();
const postParamsSchema = z.object({ id: z.string().uuid() }).strict();
const bannedTermSchema = z.object({
  term: z.string().trim().min(1),
  type: z.string().trim().min(1),
}).strict();
const bannedTermsSchema = z.object({
  terms: z.array(bannedTermSchema).max(500),
}).strict();
const emptyQuerySchema = z.object({}).strict();
const emptyBodySchema = z.object({}).strict();

type AdminService = ReturnType<typeof createAdminService>;
type AdminSession = NonNullable<Awaited<ReturnType<AdminService["getSession"]>>>;

function normalizedEmail(email: string): string {
  return email.normalize("NFKC").trim().toLowerCase();
}

function readSessionCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) {
    return null;
  }
  const matches = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${sessionCookie}=`));
  if (matches.length !== 1) {
    return null;
  }
  const token = matches[0]?.slice(sessionCookie.length + 1);
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

function matchesCsrfHash(expectedHash: string, value: string | undefined): boolean {
  if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value) || !/^[a-f0-9]{64}$/.test(expectedHash)) {
    return false;
  }
  return timingSafeEqual(
    Buffer.from(expectedHash, "hex"),
    createHash("sha256").update(value).digest(),
  );
}

export function adminRouter(api: AdminService, allowedOrigins: string[]): Router {
  const router = Router();
  const requireOrigin: RequestHandler = (req, _res, next) => {
    const origin = req.get("Origin");
    if (!origin || !allowedOrigins.includes(origin)) {
      next(new ApiError(403, "Request origin not allowed"));
      return;
    }
    next();
  };

  const requireSession: RequestHandler = async (req, res, next) => {
    const token = readSessionCookie(req.get("Cookie"));
    if (!token) {
      throw new ApiError(401, "Authentication required");
    }
    const session = await api.getSession(token);
    if (!session) {
      throw new ApiError(401, "Authentication required");
    }
    res.locals.admin = session;
    next();
  };

  const requireStaff: RequestHandler = (_req, res, next) => {
    const session = res.locals.admin as AdminSession | undefined;
    if (!session || (session.role !== "admin" && session.role !== "moderator")) {
      next(new ApiError(403, "Staff access required"));
      return;
    }
    next();
  };

  const requireAdmin: RequestHandler = async (_req, res, next) => {
    const session = res.locals.admin as AdminSession | undefined;
    if (!session) {
      next(new ApiError(401, "Authentication required"));
      return;
    }
    if (session.role !== "admin") {
      next(new ApiError(403, "Admin access required"));
      return;
    }
    next();
  };

  const requireCsrf: RequestHandler = (req, res, next) => {
    const session = res.locals.admin as AdminSession | undefined;
    if (!session || !matchesCsrfHash(session.csrfHash, req.get("X-CSRF-Token"))) {
      next(new ApiError(403, "Invalid CSRF token"));
      return;
    }
    next();
  };

  router.post("/login", requireOrigin, async (req, res) => {
    if (!emptyQuerySchema.safeParse(req.query).success) {
      throw new ApiError(400, "Invalid login request");
    }
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError(400, "Invalid login request");
    }
    const tokens = await api.login(normalizedEmail(parsed.data.email), parsed.data.password);
    res.cookie(sessionCookie, tokens.sessionToken, {
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      path: "/",
      maxAge: sessionDurationMs,
    });
    res.json({ csrf_token: tokens.csrfToken });
  });

  router.post("/logout", requireOrigin, async (req, res) => {
    const token = readSessionCookie(req.get("Cookie"));
    if (token) {
      const session = await api.getSession(token);
      if (session && !matchesCsrfHash(session.csrfHash, req.get("X-CSRF-Token"))) {
        throw new ApiError(403, "Invalid CSRF token");
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

  router.get("/queue", requireSession, requireStaff, async (req, res) => {
    if (!emptyQuerySchema.safeParse(req.query).success) {
      throw new ApiError(400, "Invalid moderation query");
    }
    res.json({ posts: await api.moderationQueue() });
  });

  router.get("/rejected", requireSession, requireStaff, async (_req, res) => {
    res.json({ posts: await api.rejectedPosts() });
  });

  router.get("/moderators", requireSession, requireAdmin, async (_req, res) => {
    res.json({ moderators: await api.listModerators() });
  });

  router.post(
    "/moderators",
    requireOrigin,
    requireSession,
    requireAdmin,
    requireCsrf,
    async (req, res) => {
      const parsed = moderatorSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ApiError(400, "Invalid moderator request");
      }
      const moderator = await api.createModerator(
        normalizedEmail(parsed.data.email),
        parsed.data.password,
        parsed.data.role,
      );
      res.status(201).json({ moderator });
    },
  );

  router.delete(
    "/moderators/:id",
    requireOrigin,
    requireSession,
    requireAdmin,
    requireCsrf,
    async (req, res) => {
      const params = moderatorParamsSchema.safeParse(req.params);
      if (!params.success || !emptyQuerySchema.safeParse(req.query).success) {
        throw new ApiError(400, "Invalid moderator request");
      }
      await api.deactivateModerator(params.data.id);
      res.status(204).end();
    },
  );

  router.get("/banned-terms", requireSession, requireAdmin, async (_req, res) => {
    res.json({ terms: await api.listBannedTerms() });
  });

  router.put(
    "/banned-terms",
    requireOrigin,
    requireSession,
    requireAdmin,
    requireCsrf,
    async (req, res) => {
      const parsed = bannedTermsSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ApiError(400, "Invalid banned-terms request");
      }
      const keys = parsed.data.terms.map(
        ({ term, type }) => `${type.toLowerCase()}\0${term.normalize("NFKC").toLowerCase()}`,
      );
      if (new Set(keys).size !== keys.length) {
        throw new ApiError(400, "Duplicate banned terms");
      }
      const terms = parsed.data.terms.map(({ term, type }) => ({
        term: term.normalize("NFKC"),
        type: type.normalize("NFKC"),
      }));
      await api.replaceBannedTerms(terms);
      res.json({ terms });
    },
  );

  const moderationAction = (
    path: string,
    action: (id: string, moderatorId: string) => Promise<void>,
  ) => router.post(
    path,
    requireOrigin,
    requireSession,
    requireStaff,
    requireCsrf,
    async (req, res) => {
      const params = postParamsSchema.safeParse(req.params);
      if (!params.success || !emptyBodySchema.safeParse(req.body ?? {}).success) {
        throw new ApiError(400, "Invalid moderation request");
      }
      const session = res.locals.admin as AdminSession;
      await action(params.data.id, session.id);
      res.status(204).end();
    },
  );

  moderationAction("/posts/:id/approve", api.approvePost);
  moderationAction("/posts/:id/reject", api.rejectPost);
  moderationAction("/posts/:id/undo", api.undoModeration);
  moderationAction("/posts/:id/restore", api.restoreRejectedPost);

  return router;
}