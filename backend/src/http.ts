import { createServer, type Server } from "node:http";
import type { Express } from "express";
import type { AppConfig } from "./config.js";

const maxHeaderSize = 16 * 1024;
const keepAliveTimeoutMs = 5_000;

export function createApiServer(
  app: Express,
  config: Pick<AppConfig, "requestTimeoutMs">,
): Server {
  const server = createServer({ maxHeaderSize }, app);
  server.requestTimeout = config.requestTimeoutMs;
  server.headersTimeout = Math.min(config.requestTimeoutMs, 10_000);
  server.timeout = config.requestTimeoutMs + 1_000;
  server.keepAliveTimeout = keepAliveTimeoutMs;
  server.maxHeadersCount = 100;
  return server;
}
