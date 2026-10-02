/**
 * tests/contract/advisor-role-reconciliation.test.ts
 *
 * Contract proof for migration 20261002000001 (review blocker 2): the
 * protected advisor display `role` must be persistently reconciled to the
 * trusted Auth claim. A bound advisor is `Admin` ONLY when their
 * `auth.users.raw_app_meta_data` carries the JSON BOOLEAN `ocf_admin = true`;
 * every other case (claim false, a string `"true"`, missing metadata, an
 * unbound row) resolves to the safe `Advisor` default — the same strict
 * boolean rule as `public.is_ocf_admin()`.
 *
 * The contract lane's main database applies the whole chain before any fixture
 * exists, so the reconciliation itself is exercised on a throwaway scratch
 * database on the same isolated Docker-local instance (mirrors
 * upgrade-path.test.ts):
 *
 *   1. CREATE DATABASE (postgres superuser; loopback-only, guarded by
 *      getContractEnv());
 *   2. scaffold the minimal `auth` schema the chain references
 *      (auth.uid()/auth.jwt()/auth.role() functions) PLUS the
 *      `auth.users` table (id + raw_app_meta_data) the reconciliation reads;
 *   3. apply the REAL committed migration files through
 *      `20261001000001_explicit_admin_advisor_permissions.sql` VERBATIM
 *      (every file exactly as committed, none modified);
 *   4. seed advisors whose display roles deliberately MISMATCH their bound
 *      auth metadata (and one unbound `Admin` row);
 *   5. apply the REAL `20261002000001_advisor_self_service_role_reconciliation.sql`
 *      file;
 *   6. prove the display roles were reconciled to the claim: boolean-true
 *      claim → `Admin`; claim false / string "true" / missing metadata /
 *      unbound → `Advisor`; and no value outside the vocabulary remains.
 *
 * Safety: the scratch database exists only on the loopback instance, is named
 * uniquely per run, and is dropped in teardown. No migration file is modified
 * or re-ordered. The service role / direct SQL are used strictly for this
 * local replay.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import { attachPoolErrorHandler, createDbPool, getContractEnv } from "./helpers/setup";

const env = getContractEnv();

const MIGRATIONS_DIR = path.join(process.cwd(), "supabase", "migrations");
const RECONCILIATION_MIGRATION = "20261002000001_advisor_self_service_role_reconciliation.sql";

/** Minimal auth-schema functions + the auth.users table the chain references. */
const AUTH_SCAFFOLD_SQL = `
CREATE SCHEMA IF NOT EXISTS auth;

CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql STABLE
AS $$
  SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION auth.jwt()
RETURNS jsonb
LANGUAGE sql STABLE
AS $$
  SELECT nullif(current_setting('request.jwt.claims', true), '')::jsonb
$$;

CREATE OR REPLACE FUNCTION auth.role()
RETURNS text
LANGUAGE sql STABLE
AS $$
  SELECT nullif(current_setting('request.jwt.claim.role', true), '')::text
$$;

CREATE TABLE auth.users (
  id uuid PRIMARY KEY,
  raw_app_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb
);
`;

let adminPool: Pool;
let scratchPool: Pool | null = null;
let scratchDbName = "";

async function applySql(pool: Pool, sql: string, label: string): Promise<void> {
  try {
    await pool.query(sql);
  } catch (caught) {
    throw new Error(`${label} failed on the scratch database: ${(caught as Error).message}`);
  }
}

beforeAll(async () => {
  adminPool = createDbPool(env);

  // A scratch database unique to this run on the isolated lane instance.
  scratchDbName = `ocf_contract_role_reconcile_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  await adminPool.query(`CREATE DATABASE ${scratchDbName}`);

  const scratchUrl = new URL(env.dbUrl);
  scratchUrl.pathname = `/${scratchDbName}`;
  scratchPool = attachPoolErrorHandler(
    new Pool({
      connectionString: scratchUrl.toString(),
      max: 2,
      connectionTimeoutMillis: 10_000,
    }),
    "advisor-role-reconciliation scratch"
  );

  // Scaffold the auth schema the chain (and the reconciliation) references.
  await applySql(scratchPool, AUTH_SCAFFOLD_SQL, "auth scaffold");

  // Read the REAL committed migration files, preserving their order; apply
  // everything BEFORE the reconciliation migration.
  const migrationFiles = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  const reconciliationIndex = migrationFiles.indexOf(RECONCILIATION_MIGRATION);
  expect(reconciliationIndex, `${RECONCILIATION_MIGRATION} must exist in the migration directory`).toBeGreaterThan(0);
  const preReconciliationFiles = migrationFiles.slice(0, reconciliationIndex);
  for (const file of preReconciliationFiles) {
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
    await applySql(scratchPool, sql, `migration ${file}`);
  }

  // Seed auth identities with varied raw_app_meta_data, then advisor rows
  // whose display roles deliberately MISMATCH the claim.
  await applySql(
    scratchPool,
    `INSERT INTO auth.users (id, raw_app_meta_data) VALUES
       ('00000000-0000-4000-8000-000000000001', '{"ocf_admin": true}'::jsonb),
       ('00000000-0000-4000-8000-000000000002', '{"ocf_admin": false}'::jsonb),
       ('00000000-0000-4000-8000-000000000003', '{"ocf_admin": "true"}'::jsonb),
       ('00000000-0000-4000-8000-000000000004', '{}'::jsonb)`,
    "seed auth users",
  );
  await applySql(
    scratchPool,
    `INSERT INTO public.advisor (advisor_name, email, auth_user_id, is_active, role) VALUES
       ('Claim True',   'claim-true@example.com',   '00000000-0000-4000-8000-000000000001', true, 'Advisor'),
       ('Claim False',  'claim-false@example.com',  '00000000-0000-4000-8000-000000000002', true, 'Admin'),
       ('Claim String', 'claim-string@example.com', '00000000-0000-4000-8000-000000000003', true, 'Admin'),
       ('No Claim',     'no-claim@example.com',     '00000000-0000-4000-8000-000000000004', true, 'Admin'),
       ('Unbound',      'unbound@example.com',      NULL,                                     true, 'Admin')`,
    "seed mismatched advisors",
  );

  // Apply the REAL reconciliation migration file.
  const reconciliationSql = await readFile(path.join(MIGRATIONS_DIR, RECONCILIATION_MIGRATION), "utf8");
  await applySql(scratchPool, reconciliationSql, `migration ${RECONCILIATION_MIGRATION}`);
}, 120_000);

afterAll(async () => {
  if (scratchPool) {
    await scratchPool.end();
    scratchPool = null;
  }
  if (adminPool && scratchDbName) {
    try {
      await adminPool.query(`DROP DATABASE IF EXISTS ${scratchDbName} WITH (FORCE)`);
    } finally {
      await adminPool.end();
    }
  }
});

describe("advisor display-role reconciliation (migration 20261002000001)", () => {
  it("sets Admin ONLY for a bound advisor whose auth raw_app_meta_data has the JSON boolean ocf_admin=true", async () => {
    expect(scratchPool).not.toBeNull();

    const { rows } = await scratchPool!.query<{ email: string; role: string }>(
      `SELECT a.email, a.role
         FROM public.advisor a
        ORDER BY a.email`
    );
    const byEmail = new Map(rows.map((row) => [row.email, row.role]));
    expect(byEmail.get("claim-true@example.com"), "boolean true claim → Admin").toBe("Admin");
    expect(byEmail.get("claim-false@example.com"), "boolean false claim → Advisor").toBe("Advisor");
    expect(byEmail.get("claim-string@example.com"), "string \"true\" claim → Advisor").toBe("Advisor");
    expect(byEmail.get("no-claim@example.com"), "missing claim → Advisor").toBe("Advisor");
    expect(byEmail.get("unbound@example.com"), "unbound row → Advisor").toBe("Advisor");
  });

  it("leaves every reconciled role inside the exact Admin/Advisor vocabulary", async () => {
    expect(scratchPool).not.toBeNull();

    const { rows } = await scratchPool!.query<{ role: string }>(
      `SELECT DISTINCT role FROM public.advisor`
    );
    const roles = rows.map((row) => row.role).sort();
    expect(roles, "reconciled roles").toEqual(["Admin", "Advisor"]);
    for (const role of roles) {
      expect(["Admin", "Advisor"]).toContain(role);
    }
  });
});