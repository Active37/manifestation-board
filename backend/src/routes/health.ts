import { Router } from "express";
import { z } from "zod";
import { httpError } from "../errors.js";

const emptyQuery = z.object({}).strict();

export function healthRouter(checkDb: () => Promise<void>): Router {
  const router = Router();

  router.get("/health", async (req, res, next) => {
    if (!emptyQuery.safeParse(req.query).success) {
      next(httpError(400, "Invalid health query"));
      return;
    }
    try {
      await checkDb();
      res.json({ status: "ok" });
    } catch {
      next(httpError(503, "Service unavailable"));
    }
  });

  return router;
}
