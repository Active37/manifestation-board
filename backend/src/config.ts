import { isIP } from "node:net";
import { z } from "zod";

const trustedProxiesSchema = z.preprocess(
  (value) =>
    typeof value === "string"
      ? value.split(",").map((address) => address.trim()).filter(Boolean)
      : value,
  z.array(
    z.string().refine((value) => {
      const [address, prefix, ...extra] = value.split("/");
      const family = address ? isIP(address) : 0;
      if (!family || extra.length > 0) {
        return false;
      }
      if (prefix === undefined) {
        return true;
      }
      const bits = Number(prefix);
      return (
        /^\d+$/.test(prefix) &&
        Number.isInteger(bits) &&
        bits >= 0 &&
        bits <= (family === 4 ? 32 : 128)
      );
    }),
  ),
);

const originsSchema = z
  .preprocess(
    (value) =>
      typeof value === "string"
        ? value.split(",").map((origin) => origin.trim())
        : value,
    z.array(z.string().url()).min(1),
  )
  .refine(
    (origins) =>
      origins.every((origin) => {
        try {
          return new URL(origin).origin === origin;
        } catch {
          return false;
        }
      }),
    "CORS_ORIGINS must contain origins without paths",
  );

const databaseUrlSchema = z
  .string()
  .url()
  .refine((value) => /^(postgres|postgresql):\/\//i.test(value));
const hostnameSchema = z
  .string()
  .min(1)
  .max(253)
  .transform((value) => value.toLowerCase())
  .refine((value) => {
    try {
      return new URL(`https://${value}`).hostname === value;
    } catch {
      return false;
    }
  });

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  DATABASE_URL: databaseUrlSchema,
  CORS_ORIGINS: originsSchema,
  TRUSTED_PROXIES: trustedProxiesSchema.default([]),
  IP_HASH_SECRET: z.string().min(32),
  TURNSTILE_SECRET_KEY: z.string().min(1),
  POST_CAPTCHA_BYPASS: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  TURNSTILE_EXPECTED_HOSTNAME: hostnameSchema.optional(),
  TURNSTILE_EXPECTED_ACTION: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,32}$/)
    .optional(),
  POSTS_PER_HOUR: z.coerce.number().int().min(1).default(3),
  LIKES_PER_MINUTE: z.coerce.number().int().min(1).default(30),
  REPORTS_PER_HOUR: z.coerce.number().int().min(1).default(5),
  NAMES_PER_MINUTE: z.coerce.number().int().min(1).default(30),
  ADMIN_LOGIN_FAILURES: z.coerce.number().int().min(3).max(20).default(5),
  ADMIN_LOGIN_WINDOW_MS: z.coerce.number().int().min(60_000).max(3_600_000).default(900_000),
  ADMIN_LOGIN_INITIAL_LOCKOUT_MS: z.coerce.number().int().min(60_000).max(86_400_000).default(900_000),
  ADMIN_LOGIN_MAX_LOCKOUT_MS: z.coerce.number().int().min(60_000).max(604_800_000).default(86_400_000),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  DB_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(5_000),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(10_000),
  DB_QUERY_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(12_000),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(30_000),
});

export type AppConfig = {
  nodeEnv: "development" | "test" | "production";
  port: number;
  databaseUrl: string;
  corsOrigins: string[];
  trustedProxies: string[];
  ipHashSecret: string;
  turnstileSecretKey: string;
  postCaptchaBypass: boolean;
  turnstileExpectedHostname?: string;
  turnstileExpectedAction?: string;
  postsPerHour: number;
  likesPerMinute: number;
  reportsPerHour: number;
  namesPerMinute: number;
  adminLoginFailures: number;
  adminLoginWindowMs: number;
  adminLoginInitialLockoutMs: number;
  adminLoginMaxLockoutMs: number;
  dbPoolMax: number;
  dbConnectionTimeoutMs: number;
  dbStatementTimeoutMs: number;
  dbQueryTimeoutMs: number;
  requestTimeoutMs: number;
};

export type DatabaseConfig = {
  databaseUrl: string;
};

export function loadDatabaseConfig(
  env: Record<string, string | undefined> = process.env,
): DatabaseConfig {
  const parsed = databaseUrlSchema.safeParse(env.DATABASE_URL);
  if (!parsed.success) {
    throw new Error("Invalid environment variables: DATABASE_URL");
  }
  if (env.NODE_ENV === "production") {
    let sslMode: string | null = null;
    try {
      sslMode = new URL(parsed.data).searchParams.get("sslmode");
    } catch {
      throw new Error("Invalid environment variables: DATABASE_URL");
    }
    if (sslMode !== "verify-full") {
      throw new Error(
        "Invalid environment variables: production DATABASE_URL must use sslmode=verify-full",
      );
    }
  }

  return { databaseUrl: parsed.data };
}

export function loadMigrationDatabaseConfig(
  env: Record<string, string | undefined> = process.env,
): DatabaseConfig {
  const migrationUrl = env.MIGRATION_DATABASE_URL ?? env.DATABASE_URL;
  const parsed = databaseUrlSchema.safeParse(migrationUrl);
  if (!parsed.success) {
    throw new Error("Invalid environment variables: MIGRATION_DATABASE_URL");
  }
  if (env.NODE_ENV === "production") {
    if (!env.MIGRATION_DATABASE_URL || !env.DATABASE_URL) {
      throw new Error(
        "Invalid environment variables: production requires MIGRATION_DATABASE_URL",
      );
    }

    let migration: URL;
    let runtime: URL;
    try {
      migration = new URL(parsed.data);
      runtime = new URL(env.DATABASE_URL);
    } catch {
      throw new Error("Invalid environment variables: database URLs");
    }
    if (
      migration.username === runtime.username ||
      migration.searchParams.get("sslmode") !== "verify-full"
    ) {
      throw new Error(
        "Invalid environment variables: use a distinct migration role and sslmode=verify-full",
      );
    }
  }

  return { databaseUrl: parsed.data };
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))];
    throw new Error(`Invalid environment variables: ${fields.join(", ")}`);
  }
  if (
    parsed.data.NODE_ENV === "production" &&
    new URL(parsed.data.DATABASE_URL).searchParams.get("sslmode") !== "verify-full"
  ) {
    throw new Error(
      "Invalid environment variables: production DATABASE_URL must use sslmode=verify-full",
    );
  }
  if (
    parsed.data.NODE_ENV === "production" &&
    parsed.data.TRUSTED_PROXIES.length === 0
  ) {
    throw new Error(
      "Invalid environment variables: production requires TRUSTED_PROXIES for HTTPS termination",
    );
  }
  if (
    parsed.data.NODE_ENV === "production" &&
    (!parsed.data.TURNSTILE_EXPECTED_HOSTNAME ||
      !parsed.data.TURNSTILE_EXPECTED_ACTION)
  ) {
    throw new Error(
      "Invalid environment variables: production requires TURNSTILE_EXPECTED_HOSTNAME and TURNSTILE_EXPECTED_ACTION",
    );
  }
  if (parsed.data.NODE_ENV === "production" && parsed.data.POST_CAPTCHA_BYPASS) {
    throw new Error(
      "Invalid environment variables: POST_CAPTCHA_BYPASS cannot be enabled in production",
    );
  }
  if (
    parsed.data.ADMIN_LOGIN_MAX_LOCKOUT_MS <
    parsed.data.ADMIN_LOGIN_INITIAL_LOCKOUT_MS
  ) {
    throw new Error(
      "Invalid environment variables: ADMIN_LOGIN_MAX_LOCKOUT_MS must be at least ADMIN_LOGIN_INITIAL_LOCKOUT_MS",
    );
  }

  return {
    nodeEnv: parsed.data.NODE_ENV,
    port: parsed.data.PORT,
    databaseUrl: parsed.data.DATABASE_URL,
    corsOrigins: parsed.data.CORS_ORIGINS,
    trustedProxies: parsed.data.TRUSTED_PROXIES,
    ipHashSecret: parsed.data.IP_HASH_SECRET,
    turnstileSecretKey: parsed.data.TURNSTILE_SECRET_KEY,
    postCaptchaBypass: parsed.data.POST_CAPTCHA_BYPASS,
    turnstileExpectedHostname: parsed.data.TURNSTILE_EXPECTED_HOSTNAME,
    turnstileExpectedAction: parsed.data.TURNSTILE_EXPECTED_ACTION,
    postsPerHour: parsed.data.POSTS_PER_HOUR,
    likesPerMinute: parsed.data.LIKES_PER_MINUTE,
    reportsPerHour: parsed.data.REPORTS_PER_HOUR,
    namesPerMinute: parsed.data.NAMES_PER_MINUTE,
    adminLoginFailures: parsed.data.ADMIN_LOGIN_FAILURES,
    adminLoginWindowMs: parsed.data.ADMIN_LOGIN_WINDOW_MS,
    adminLoginInitialLockoutMs: parsed.data.ADMIN_LOGIN_INITIAL_LOCKOUT_MS,
    adminLoginMaxLockoutMs: parsed.data.ADMIN_LOGIN_MAX_LOCKOUT_MS,
    dbPoolMax: parsed.data.DB_POOL_MAX,
    dbConnectionTimeoutMs: parsed.data.DB_CONNECTION_TIMEOUT_MS,
    dbStatementTimeoutMs: parsed.data.DB_STATEMENT_TIMEOUT_MS,
    dbQueryTimeoutMs: parsed.data.DB_QUERY_TIMEOUT_MS,
    requestTimeoutMs: parsed.data.REQUEST_TIMEOUT_MS,
  };
}
