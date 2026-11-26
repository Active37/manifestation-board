export type AppConfig = {
  nodeEnv: "development" | "test" | "production";
  port: number;
  corsOrigins: string[];
  trustedProxies: string[];
  ipHashSecret: string;
  turnstileSecretKey: string;
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

  return {
    nodeEnv: nodeEnv as AppConfig["nodeEnv"],
    port: positiveInteger(env, "PORT", 3001),
    corsOrigins: origins(env.CORS_ORIGINS),
    trustedProxies: (env.TRUSTED_PROXIES ?? "")
      .split(",")
      .map((proxy) => proxy.trim())
      .filter(Boolean),
    ipHashSecret,
    turnstileSecretKey,
    postsPerHour: positiveInteger(env, "POSTS_PER_HOUR", 3),
    likesPerMinute: positiveInteger(env, "LIKES_PER_MINUTE", 30),
  };
}