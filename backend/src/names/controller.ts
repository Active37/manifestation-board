import type { RequestHandler } from "express";
import { z } from "zod";
import { httpError } from "../errors.js";
import type { NamesService } from "./service.js";
import { sanitizeName } from "./service.js";

const checkQuery = z
  .object({
    name: z
      .string()
      .max(120)
      .transform(sanitizeName)
      .pipe(z.string().min(1).max(120)),
  })
  .strict();
const emptyQuery = z.object({}).strict();

export function createNamesController(
  service: NamesService,
  checkNameRateLimit: (ip: string) => Promise<void>,
): {
  random: RequestHandler;
  check: RequestHandler;
} {
  return {
    random: async (req, res) => {
      if (!emptyQuery.safeParse(req.query).success) {
        throw httpError(400, "Invalid random-name query");
      }
      res.json({ name: await service.randomName() });
    },
    check: async (req, res) => {
      const parsed = checkQuery.safeParse(req.query);
      if (!parsed.success) {
        throw httpError(400, "Invalid name query");
      }
      if (!req.ip) {
        throw httpError(400, "Invalid name query");
      }

      await checkNameRateLimit(req.ip);
      res.json({ available: await service.isAvailable(parsed.data.name) });
    },
  };
}
