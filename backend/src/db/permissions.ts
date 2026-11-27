import type { Pool } from "pg";

type RuntimeRoleRow = {
  is_superuser: boolean;
  can_create_database: boolean;
  can_create_role: boolean;
  can_create_schema: boolean;
  can_create_objects: boolean;
  owns_database: boolean;
  owns_objects: boolean;
  has_role_memberships: boolean;
  has_unrelated_schema_access: boolean;
};

export async function assertRuntimeRole(pool: Pool): Promise<void> {
  const result = await pool.query<RuntimeRoleRow>(`
    SELECT r.rolsuper AS is_superuser,
      r.rolcreatedb AS can_create_database,
      r.rolcreaterole AS can_create_role,
      has_database_privilege(r.oid, current_database(), 'CREATE') AS can_create_schema,
      has_schema_privilege(r.oid, 'public', 'CREATE') AS can_create_objects,
      d.datdba = r.oid AS owns_database,
      EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relowner = r.oid AND n.nspname = 'public'
      ) OR EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE p.proowner = r.oid AND n.nspname = 'public'
      ) AS owns_objects,
      EXISTS (
        SELECT 1 FROM pg_roles granted
        WHERE granted.oid <> r.oid
          AND pg_has_role(r.oid, granted.oid, 'MEMBER')
      ) AS has_role_memberships,
      EXISTS (
        SELECT 1 FROM pg_namespace n
        WHERE n.nspname <> 'public'
          AND n.nspname <> 'information_schema'
          AND n.nspname !~ '^pg_'
          AND (
            has_schema_privilege(r.oid, n.oid, 'USAGE')
            OR has_schema_privilege(r.oid, n.oid, 'CREATE')
          )
      ) AS has_unrelated_schema_access
    FROM pg_roles r
    JOIN pg_database d ON d.datname = current_database()
    WHERE r.rolname = current_user
  `);
  const role = result.rows[0];
  if (
    !role ||
    role.is_superuser ||
    role.can_create_database ||
    role.can_create_role ||
    role.can_create_schema ||
    role.can_create_objects ||
    role.owns_database ||
    role.owns_objects ||
    role.has_role_memberships ||
    role.has_unrelated_schema_access
  ) {
    throw new Error("Runtime PostgreSQL role is not least-privileged");
  }
}