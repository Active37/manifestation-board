import assert from "node:assert/strict";
import type { Pool } from "pg";
import test from "node:test";
import {
  assertInteractionDeviceSchema,
  assertRuntimeRole,
} from "./permissions.js";

function fakePool(row: Record<string, boolean> | null): Pool {
  return {
    query: async () => ({ rows: row ? [row] : [], rowCount: row ? 1 : 0 }),
  } as unknown as Pool;
}

test("accepts a non-owner runtime role without database creation privileges", async () => {
  await assertRuntimeRole(
    fakePool({
      is_superuser: false,
      can_create_database: false,
      can_create_role: false,
      can_create_schema: false,
      can_create_objects: false,
      has_public_schema_usage: true,
      owns_database: false,
      owns_objects: false,
      has_role_memberships: false,
      has_unrelated_schema_access: false,
    }),
  );
});

test("rejects privileged or owning runtime database roles", async () => {
  for (const property of [
    "is_superuser",
    "can_create_database",
    "can_create_role",
    "can_create_schema",
    "can_create_objects",
    "owns_database",
    "owns_objects",
    "has_role_memberships",
    "has_unrelated_schema_access",
  ]) {
    const row = {
      is_superuser: false,
      can_create_database: false,
      can_create_role: false,
      can_create_schema: false,
      can_create_objects: false,
      has_public_schema_usage: true,
      owns_database: false,
      owns_objects: false,
      has_role_memberships: false,
      has_unrelated_schema_access: false,
      [property]: true,
    };
    await assert.rejects(assertRuntimeRole(fakePool(row)), {
      message: "Runtime database role is not least-privileged",
    });
  }
  await assert.rejects(
    assertRuntimeRole(
      fakePool({
        is_superuser: false,
        can_create_database: false,
        can_create_role: false,
        can_create_schema: false,
        can_create_objects: false,
        has_public_schema_usage: false,
        owns_database: false,
        owns_objects: false,
        has_role_memberships: false,
        has_unrelated_schema_access: false,
      }),
    ),
    /Runtime database role is not least-privileged/,
  );
  await assert.rejects(
    assertRuntimeRole(fakePool(null)),
    /Runtime database role is not least-privileged/,
  );
});

test("requires every interaction device hash constraint to be validated", async () => {
  const pool = {
    query: async () => ({ rows: [{ validated_count: 4 }], rowCount: 1 }),
  } as unknown as Pool;
  await assertInteractionDeviceSchema(pool);

  const incompletePool = {
    query: async () => ({ rows: [{ validated_count: 3 }], rowCount: 1 }),
  } as unknown as Pool;
  await assert.rejects(
    assertInteractionDeviceSchema(incompletePool),
    /Interaction device identifier migration is incomplete/,
  );
});
