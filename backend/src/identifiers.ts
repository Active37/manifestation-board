import { createHmac } from "node:crypto";

export type IdentifierType = "device" | "ip";

export function hashIdentifier(
  secret: string,
  type: IdentifierType,
  value: string,
): string {
  return createHmac("sha256", secret).update(`${type}:${value}`).digest("hex");
}
