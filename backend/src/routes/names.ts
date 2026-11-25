import { Router } from "express";
import type { NamesService } from "../names/service.js";
import { createNamesController } from "../names/controller.js";

export function namesRouter(
  service: NamesService,
  checkNameRateLimit: (ip: string) => Promise<void>,
): Router {
  const router = Router();
  const controller = createNamesController(service, checkNameRateLimit);

  router.get("/random", controller.random);
  router.get("/check", controller.check);

  return router;
}
