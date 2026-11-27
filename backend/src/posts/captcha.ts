import { z } from "zod";
import { ApiError } from "../errors.js";

const verifyUrl = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const responseSchema = z.object({
  success: z.boolean(),
  challenge_ts: z.string().datetime({ offset: true }).optional(),
  hostname: z.string().optional(),
  action: z.string().optional(),
});

export async function verifyTurnstile(
  token: string,
  secret: string,
  expected: { hostname?: string; action?: string } = {},
): Promise<boolean> {
  let response: Response;
  try {
    response = await fetch(verifyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret, response: token }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw new ApiError(503, "CAPTCHA verification is unavailable");
  }
  if (!response.ok) {
    throw new ApiError(503, "CAPTCHA verification is unavailable");
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError(503, "CAPTCHA verification is unavailable");
  }
  const parsed = responseSchema.safeParse(payload);
  if (!parsed.success || !parsed.data.success) {
    return false;
  }
  const challengeTime = parsed.data.challenge_ts
    ? Date.parse(parsed.data.challenge_ts)
    : Number.NaN;
  const age = Date.now() - challengeTime;
  if (!Number.isFinite(challengeTime) || age < -30_000 || age > 300_000) {
    return false;
  }
  if (
    (expected.hostname !== undefined &&
      parsed.data.hostname?.toLowerCase() !== expected.hostname.toLowerCase()) ||
    (expected.action !== undefined && parsed.data.action !== expected.action)
  ) {
    return false;
  }
  return true;
}