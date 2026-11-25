import { randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import { httpError } from "../errors.js";

export const deviceCookieName = "__Host-board_device";

const deviceCookieMaxAge = 90 * 24 * 60 * 60 * 1000;
const deviceTokenPattern = /^[A-Za-z0-9_-]{43}$/;

function readDeviceToken(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) {
    return null;
  }
  const prefix = `${deviceCookieName}=`;
  const matches = cookieHeader
    .split(";")
    .map((cookie) => cookie.trim())
    .filter((cookie) => cookie.startsWith(prefix));
  if (matches.length !== 1) {
    return null;
  }
  const token = matches[0].slice(prefix.length);
  return deviceTokenPattern.test(token) ? token : null;
}

export function getDeviceIdentity(
  req: Request,
  res: Response,
  allowedOrigins: string[],
): { deviceId: string; ip: string } {
  const origin = req.get("Origin");
  if (!origin || !allowedOrigins.includes(origin)) {
    throw httpError(403, "Origin not allowed");
  }
  if (!req.ip) {
    throw httpError(400, "Invalid interaction request");
  }

  const existingToken = readDeviceToken(req.get("Cookie"));
  if (existingToken) {
    return { deviceId: existingToken, ip: req.ip };
  }

  const deviceId = randomBytes(32).toString("base64url");
  res.cookie(deviceCookieName, deviceId, {
    httpOnly: true,
    secure: true,
    sameSite: "none",
    path: "/",
    maxAge: deviceCookieMaxAge,
  });
  return { deviceId, ip: req.ip };
}
