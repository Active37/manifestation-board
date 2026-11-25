import assert from "node:assert/strict";
import test from "node:test";
import {
  loadConfig,
  loadDatabaseConfig,
  loadMigrationDatabaseConfig,
} from "./config.js";

const validEnv = {
  DATABASE_URL: "postgresql://user:password@localhost:5432/board",
  CORS_ORIGINS: "https://board.example,https://admin.example",
  IP_HASH_SECRET: "a-random-secret-with-at-least-32-characters",
  TURNSTILE_SECRET_KEY: "turnstile-test-secret",
};

test("loads required configuration and defaults the port", () => {
  const config = loadConfig(validEnv);

  assert.equal(config.nodeEnv, "development");
  assert.equal(config.postCaptchaBypass, false);
  assert.equal(config.port, 3001);
  assert.equal(config.postsPerHour, 3);
  assert.equal(config.likesPerMinute, 30);
  assert.equal(config.reportsPerHour, 5);
  assert.equal(config.namesPerMinute, 30);
  assert.equal(config.adminLoginFailures, 5);
  assert.equal(config.adminLoginWindowMs, 900_000);
  assert.equal(config.adminLoginInitialLockoutMs, 900_000);
  assert.equal(config.adminLoginMaxLockoutMs, 86_400_000);
  assert.equal(config.dbPoolMax, 10);
  assert.equal(config.dbStatementTimeoutMs, 10_000);
  assert.equal(config.requestTimeoutMs, 30_000);
  assert.deepEqual(config.trustedProxies, []);
  assert.deepEqual(config.corsOrigins, [
    "https://board.example",
    "https://admin.example",
  ]);
});

test("reads post rate limits from configuration", () => {
  const config = loadConfig({
    ...validEnv,
    POSTS_PER_HOUR: "7",
    LIKES_PER_MINUTE: "18",
    REPORTS_PER_HOUR: "4",
    NAMES_PER_MINUTE: "12",
  });

  assert.equal(config.postsPerHour, 7);
  assert.equal(config.likesPerMinute, 18);
  assert.equal(config.reportsPerHour, 4);
  assert.equal(config.namesPerMinute, 12);
});

test("reads admin login lockout policy and rejects inconsistent bounds", () => {
  const config = loadConfig({
    ...validEnv,
    ADMIN_LOGIN_FAILURES: "7",
    ADMIN_LOGIN_WINDOW_MS: "600000",
    ADMIN_LOGIN_INITIAL_LOCKOUT_MS: "120000",
    ADMIN_LOGIN_MAX_LOCKOUT_MS: "3600000",
  });
  assert.equal(config.adminLoginFailures, 7);
  assert.equal(config.adminLoginWindowMs, 600_000);
  assert.equal(config.adminLoginInitialLockoutMs, 120_000);
  assert.equal(config.adminLoginMaxLockoutMs, 3_600_000);
  assert.throws(
    () =>
      loadConfig({
        ...validEnv,
        ADMIN_LOGIN_INITIAL_LOCKOUT_MS: "600000",
        ADMIN_LOGIN_MAX_LOCKOUT_MS: "300000",
      }),
    /ADMIN_LOGIN_MAX_LOCKOUT_MS must be at least/,
  );
});

test("validates optional Turnstile host and action binding", () => {
  const config = loadConfig({
    ...validEnv,
    TURNSTILE_EXPECTED_HOSTNAME: "Board.Example",
    TURNSTILE_EXPECTED_ACTION: "create_post",
  });
  assert.equal(config.turnstileExpectedHostname, "board.example");
  assert.equal(config.turnstileExpectedAction, "create_post");
  assert.throws(
    () => loadConfig({ ...validEnv, TURNSTILE_EXPECTED_HOSTNAME: "https://board.example" }),
    /TURNSTILE_EXPECTED_HOSTNAME/,
  );
  assert.throws(
    () => loadConfig({ ...validEnv, TURNSTILE_EXPECTED_ACTION: "create post" }),
    /TURNSTILE_EXPECTED_ACTION/,
  );
});

test("allows CAPTCHA bypass only when explicitly enabled outside production", () => {
  assert.equal(
    loadConfig({ ...validEnv, POST_CAPTCHA_BYPASS: "true" }).postCaptchaBypass,
    true,
  );
  assert.throws(
    () => loadConfig({ ...validEnv, POST_CAPTCHA_BYPASS: "yes" }),
    /POST_CAPTCHA_BYPASS/,
  );
  assert.throws(
    () =>
      loadConfig({
        ...validEnv,
        NODE_ENV: "production",
        DATABASE_URL: `${validEnv.DATABASE_URL}?sslmode=verify-full`,
        TRUSTED_PROXIES: "127.0.0.1",
        TURNSTILE_EXPECTED_HOSTNAME: "board.example",
        TURNSTILE_EXPECTED_ACTION: "create_post",
        POST_CAPTCHA_BYPASS: "true",
      }),
    /POST_CAPTCHA_BYPASS cannot be enabled in production/,
  );
});

test("validates trusted proxy IPs and CIDR ranges", () => {
  const config = loadConfig({
    ...validEnv,
    TRUSTED_PROXIES: "127.0.0.1,10.0.0.0/8",
  });
  assert.deepEqual(config.trustedProxies, ["127.0.0.1", "10.0.0.0/8"]);
  assert.throws(
    () => loadConfig({ ...validEnv, TRUSTED_PROXIES: "10.0.0.0/99" }),
    /TRUSTED_PROXIES/,
  );
});

test("requires verified PostgreSQL TLS in production configuration", () => {
  assert.throws(
    () => loadConfig({ ...validEnv, NODE_ENV: "production" }),
    /sslmode=verify-full/,
  );
  assert.equal(
    loadConfig({
      ...validEnv,
      NODE_ENV: "production",
      DATABASE_URL: `${validEnv.DATABASE_URL}?sslmode=verify-full`,
      TRUSTED_PROXIES: "127.0.0.1",
      TURNSTILE_EXPECTED_HOSTNAME: "board.example",
      TURNSTILE_EXPECTED_ACTION: "create_post",
    }).databaseUrl,
    `${validEnv.DATABASE_URL}?sslmode=verify-full`,
  );
});

test("requires CAPTCHA hostname and action binding in production", () => {
  assert.throws(
    () =>
      loadConfig({
        ...validEnv,
        NODE_ENV: "production",
        DATABASE_URL: `${validEnv.DATABASE_URL}?sslmode=verify-full`,
        TRUSTED_PROXIES: "127.0.0.1",
      }),
    /TURNSTILE_EXPECTED_HOSTNAME and TURNSTILE_EXPECTED_ACTION/,
  );
  assert.equal(
    loadConfig({
      ...validEnv,
      NODE_ENV: "production",
      DATABASE_URL: `${validEnv.DATABASE_URL}?sslmode=verify-full`,
      TRUSTED_PROXIES: "127.0.0.1",
      TURNSTILE_EXPECTED_HOSTNAME: "board.example",
      TURNSTILE_EXPECTED_ACTION: "create_post",
    }).turnstileExpectedAction,
    "create_post",
  );
});

test("requires explicit trusted proxies in production", () => {
  assert.throws(
    () =>
      loadConfig({
        ...validEnv,
        NODE_ENV: "production",
        DATABASE_URL: `${validEnv.DATABASE_URL}?sslmode=verify-full`,
        TURNSTILE_EXPECTED_HOSTNAME: "board.example",
        TURNSTILE_EXPECTED_ACTION: "create_post",
      }),
    /production requires TRUSTED_PROXIES/,
  );
});

test("loads database config without requiring API-only secrets", () => {
  assert.deepEqual(
    loadDatabaseConfig({ DATABASE_URL: validEnv.DATABASE_URL }),
    { databaseUrl: validEnv.DATABASE_URL },
  );
});

test("requires verified PostgreSQL TLS for production migrations too", () => {
  assert.throws(
    () =>
      loadDatabaseConfig({
        DATABASE_URL: validEnv.DATABASE_URL,
        NODE_ENV: "production",
      }),
    /sslmode=verify-full/,
  );
});

test("supports a separate migration URL and requires a distinct production role", () => {
  const migrationUrl =
    "postgresql://migrator:secret@db.example/board?sslmode=verify-full";
  assert.deepEqual(
    loadMigrationDatabaseConfig({
      DATABASE_URL: validEnv.DATABASE_URL,
      MIGRATION_DATABASE_URL: migrationUrl,
    }),
    { databaseUrl: migrationUrl },
  );
  assert.throws(
    () =>
      loadMigrationDatabaseConfig({
        DATABASE_URL: `${validEnv.DATABASE_URL}?sslmode=verify-full`,
        NODE_ENV: "production",
      }),
    /requires MIGRATION_DATABASE_URL/,
  );
  assert.throws(
    () =>
      loadMigrationDatabaseConfig({
        DATABASE_URL: `${validEnv.DATABASE_URL}?sslmode=verify-full`,
        MIGRATION_DATABASE_URL:
          "postgresql://user:other@db.example/board?sslmode=verify-full",
        NODE_ENV: "production",
      }),
    /distinct migration role/,
  );
});

test("fails with safe field names when required configuration is missing", () => {
  assert.throws(
    () => loadConfig({}),
    /DATABASE_URL, CORS_ORIGINS, IP_HASH_SECRET, TURNSTILE_SECRET_KEY/,
  );
});

test("rejects CORS entries that are not bare origins", () => {
  assert.throws(
    () => loadConfig({ ...validEnv, CORS_ORIGINS: "https://board.example/path" }),
    /CORS_ORIGINS/,
  );
});
