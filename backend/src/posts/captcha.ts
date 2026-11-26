import { z } from "zod";
import { ApiError } from "../errors.js";

const verifyUrl = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const responseSchema = z.object({ success: z.boolean() });

export async function verifyTurnstile(
  token: string,
  secret: string,
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
  return parsed.success && parsed.data.success;
}