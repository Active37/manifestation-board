import { Router } from "express";
import { z } from "zod";
import { ApiError } from "../errors.js";
import type { createNamesService } from "./service.js";

const checkQuerySchema = z.object({ name: z.string().trim().min(1) }).strict();
const emptyQuerySchema = z.object({}).strict();

type NamesService = ReturnType<typeof createNamesService>;

export function namesRouter(service: NamesService): Router {
  const router = Router();

  router.get("/random", async (req, res) => {
    if (!emptyQuerySchema.safeParse(req.query).success) {
      throw new ApiError(400, "Invalid name request");
    }
    res.json({ name: await service.randomName() });
  });

  router.get("/check", async (req, res) => {
    const parsed = checkQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ApiError(400, "Invalid name request");
    }
    res.json({
      name: parsed.data.name,
      available: await service.isAvailable(parsed.data.name),
    });
  });

  return router;
}