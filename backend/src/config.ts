import { isIP } from "node:net";

export type AppConfig = {
  nodeEnv: "development" | "test" | "production";
  port: number;
  databaseUrl: string;
  corsOrigins: string[];
  trustedProxies: string[];
  ipHashSecret: string;
  turnstileSecretKey: string;
  turnstileExpectedHostname?: string;
  turnstileExpectedAction?: string;
  postsPerHour: number;
  likesPerMinute: number;
};

function positiveInteger(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const value = env[name] === undefined || env[name] === "" ? fallback : Number(env[name]);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Invalid environment variable: ${name}`);
  }
  return value;
}

function origins(value: string | undefined): string[] {
  const result = (value ?? "").split(",").map((origin) => origin.trim()).filter(Boolean);
  for (const origin of result) {
    try {
      if (new URL(origin).origin !== origin) {
        throw new Error();
      }
    } catch {
      throw new Error("CORS_ORIGINS must contain exact origins without paths");
    }
  }
  return result;
}

function parseDatabaseUrl(value: string | undefined, variable: string): URL {
  if (!value) {
    throw new Error(`${variable} is required`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${variable} must be a valid PostgreSQL URL`);
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error(`${variable} must use the PostgreSQL protocol`);
  }
  return url;
}

function isValidProxy(value: string): boolean {
  const [address, prefix, ...extra] = value.split("/");
  const family = address ? isIP(address) : 0;
  if (!family || extra.length > 0) {
    return false;
  }
  if (prefix === undefined) {
    return true;
  }
  const bits = Number(prefix);
  return /^\d+$/.test(prefix) && bits >= 0 && bits <= (family === 4 ? 32 : 128);
}

function parseHostname(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const hostname = value.toLowerCase();
  try {
    if (new URL(`https://${hostname}`).hostname === hostname) {
      return hostname;
    }
  } catch {
    // Report the same configuration error for malformed hostnames.
  }
  throw new Error("TURNSTILE_EXPECTED_HOSTNAME must be a hostname without a scheme or path");
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): AppConfig {
  const nodeEnv = env.NODE_ENV ?? "development";
  if (!(["development", "test", "production"] as const).includes(nodeEnv as AppConfig["nodeEnv"])) {
    throw new Error("Invalid environment variable: NODE_ENV");
  }
  const ipHashSecret = env.IP_HASH_SECRET ?? "";
  if (ipHashSecret.length < 32) {
    throw new Error("IP_HASH_SECRET must contain at least 32 characters");
  }
  const turnstileSecretKey = env.TURNSTILE_SECRET_KEY ?? "";
  if (!turnstileSecretKey) {
    throw new Error("TURNSTILE_SECRET_KEY is required");
  }
  const databaseUrl = env.DATABASE_URL;
  const runtimeDatabase = parseDatabaseUrl(databaseUrl, "DATABASE_URL");
  const trustedProxies = (env.TRUSTED_PROXIES ?? "")
    .split(",")
    .map((proxy) => proxy.trim())
    .filter(Boolean);
  if (!trustedProxies.every(isValidProxy)) {
    throw new Error("TRUSTED_PROXIES must contain valid IP addresses or CIDRs");
  }
  const corsOrigins = origins(env.CORS_ORIGINS);
  const turnstileExpectedHostname = parseHostname(env.TURNSTILE_EXPECTED_HOSTNAME);
  const turnstileExpectedAction = env.TURNSTILE_EXPECTED_ACTION;
  if (
    turnstileExpectedAction !== undefined &&
    !/^[A-Za-z0-9_-]{1,32}$/.test(turnstileExpectedAction)
  ) {
    throw new Error("TURNSTILE_EXPECTED_ACTION must be 1-32 letters, digits, underscores, or hyphens");
  }

  if (nodeEnv === "production") {
    if (runtimeDatabase.searchParams.get("sslmode") !== "verify-full") {
      throw new Error("Production DATABASE_URL must use sslmode=verify-full");
    }
    if (trustedProxies.length === 0) {
      throw new Error("Production requires explicit TRUSTED_PROXIES");
    }
    if (corsOrigins.length === 0 || corsOrigins.some((origin) => !origin.startsWith("https://"))) {
      throw new Error("Production CORS_ORIGINS must contain HTTPS origins");
    }
    if (!turnstileExpectedHostname || !turnstileExpectedAction) {
      throw new Error("Production requires TURNSTILE_EXPECTED_HOSTNAME and TURNSTILE_EXPECTED_ACTION");
    }
  }

  return {
    nodeEnv: nodeEnv as AppConfig["nodeEnv"],
    port: positiveInteger(env, "PORT", 3001),
    databaseUrl: runtimeDatabase.toString(),
    corsOrigins,
    trustedProxies,
    ipHashSecret,
    turnstileSecretKey,
    turnstileExpectedHostname,
    turnstileExpectedAction,
    postsPerHour: positiveInteger(env, "POSTS_PER_HOUR", 3),
    likesPerMinute: positiveInteger(env, "LIKES_PER_MINUTE", 30),
  };
}

export function loadMigrationDatabaseUrl(
  env: Record<string, string | undefined> = process.env,
): string {
  const runtime = parseDatabaseUrl(env.DATABASE_URL, "DATABASE_URL");
  const migration = parseDatabaseUrl(
    env.MIGRATION_DATABASE_URL ?? env.DATABASE_URL,
    "MIGRATION_DATABASE_URL",
  );
  if (env.NODE_ENV === "production") {
    if (!env.MIGRATION_DATABASE_URL) {
      throw new Error("Production requires a distinct MIGRATION_DATABASE_URL");
    }
    if (
      migration.username === runtime.username ||
      migration.searchParams.get("sslmode") !== "verify-full"
    ) {
      throw new Error("Production migrations require a distinct role and sslmode=verify-full");
    }
  }
  return migration.toString();
}