import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig, loadMigrationDatabaseUrl } from "./config.js";

const validProductionEnvironment = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://runtime:secret@db.example.org/board?sslmode=verify-full",
  MIGRATION_DATABASE_URL: "postgresql://migrator:secret@db.example.org/board?sslmode=verify-full",
  CORS_ORIGINS: "https://board.example.org",
  TRUSTED_PROXIES: "192.0.2.10/32,2001:db8::1",
  IP_HASH_SECRET: "a-production-test-secret-longer-than-32-characters",
  TURNSTILE_SECRET_KEY: "test-turnstile-secret",
  TURNSTILE_EXPECTED_HOSTNAME: "board.example.org",
  TURNSTILE_EXPECTED_ACTION: "create_goal",
};

test("production config requires verified TLS, trusted proxies, HTTPS origins, and Turnstile expectations", () => {
  const config = loadConfig(validProductionEnvironment);
  assert.equal(config.nodeEnv, "production");
  assert.equal(config.turnstileExpectedHostname, "board.example.org");
  assert.equal(config.turnstileExpectedAction, "create_goal");

  assert.throws(() => loadConfig({
    ...validProductionEnvironment,
    DATABASE_URL: "postgresql://runtime:secret@db.example.org/board",
  }), /sslmode=verify-full/);
  assert.throws(() => loadConfig({
    ...validProductionEnvironment,
    TRUSTED_PROXIES: "not-an-ip",
  }), /valid IP addresses or CIDRs/);
  assert.throws(() => loadConfig({
    ...validProductionEnvironment,
    CORS_ORIGINS: "http://board.example.org",
  }), /HTTPS origins/);
  assert.throws(() => loadConfig({
    ...validProductionEnvironment,
    TURNSTILE_EXPECTED_ACTION: undefined,
  }), /TURNSTILE_EXPECTED_HOSTNAME and TURNSTILE_EXPECTED_ACTION/);
});

test("production migrations require a distinct TLS-verified database role", () => {
  assert.equal(
    loadMigrationDatabaseUrl(validProductionEnvironment),
    validProductionEnvironment.MIGRATION_DATABASE_URL,
  );
  assert.throws(() => loadMigrationDatabaseUrl({
    ...validProductionEnvironment,
    MIGRATION_DATABASE_URL: validProductionEnvironment.DATABASE_URL,
  }), /distinct role/);
  assert.throws(() => loadMigrationDatabaseUrl({
    ...validProductionEnvironment,
    MIGRATION_DATABASE_URL: "postgresql://migrator:secret@db.example.org/board",
  }), /sslmode=verify-full/);
});

test("non-production config keeps local database URLs and optional Turnstile expectations", () => {
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/board",
    IP_HASH_SECRET: "a-test-secret-longer-than-32-characters",
    TURNSTILE_SECRET_KEY: "test-secret",
  });
  assert.deepEqual(config.trustedProxies, []);
  assert.equal(config.turnstileExpectedHostname, undefined);
  assert.equal(config.postsPerHour, 3);
  assert.equal(config.likesPerMinute, 30);
});