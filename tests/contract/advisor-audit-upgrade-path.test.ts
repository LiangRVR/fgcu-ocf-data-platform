/**
 * tests/contract/advisor-audit-upgrade-path.test.ts
 *
 * Upgrade-path + concurrency contract for migration
 * 20261013000001_advisor_admin_immutable_history (the advisor/admin immutable
 * history extension), mirroring the `audit-upgrade-path.test.ts` technique: the
 * REAL committed migration files are replayed VERBATIM against a throwaway
 * scratch database on the same isolated Docker-local instance, with legacy
 * pre-existing advisor rows present before the advisor migration applies.
 *
 * Proves:
 *
 *  - NO BASELINE FABRICATION: advisor rows that already exist when the advisor
 *    migration applies receive NO advisor audit events, and those legacy rows
 *    stay unchanged.
 *  - FINAL RPC SURFACE: the new `provision_advisor`,
 *    `set_advisor_role(integer,text,text,integer)` and
 *    `lifecycle_transition(text,text,integer,text)` exist, and the legacy
 *    2-arg/3-arg overloads are dropped.
 *  - FIRST EVENT AFTER UPGRADE: the first later advisor mutation writes the
 *    first event, with no request actor -> System/system origin and the exact
 *    4-field allowlist.
 *  - TRUSTED-ACTOR REVALIDATION AFTER LOCK SERIALIZATION (R5/R7/NFR2): a
 *    competing `set_advisor_role` transaction whose actor was demoted by the
 *    transaction that held the membership advisory lock must NOT succeed after
 *    the lock is released — the invariant holds because the operation
 *    re-validates against the committed durable state once serialized.
 *  - FINAL DURABLE-ADMIN DEMOTION: once the scratch database has exactly two
 *    durable active bound Admins, the second demotion is rejected.
 *
 * Safety: the scratch database exists only on the loopback instance, is named
 * uniquely per run, and is dropped in teardown. No migration file is modified
 * or re-ordered. Direct SQL / the service role are used strictly for this local
 * replay (never asserted as an access grant).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { Pool, type PoolClient } from "pg";
import { attachPoolErrorHandler, createDbPool, getContractEnv } from "./helpers/setup";
import { syntheticEmail, syntheticName } from "./helpers/fixtures";

const env = getContractEnv();

// The runner always launches tests with the repository root as cwd.
const MIGRATIONS_DIR = path.join(process.cwd(), "supabase", "migrations");
const ADVISOR_MIGRATION = "20261013000001_advisor_admin_immutable_history.sql";

/** Minimal auth-schema functions/table used by the pre-advisor migration chain. */
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

-- The 20261002000001 migration's apply-time statement resolves
-- auth.users.raw_app_meta_data.ocf_admin for existing advisor rows; a minimal
-- stub (never populated by the chain, never asserted as a grant) satisfies that
-- resolution while the explorer/adjuster functions remain plpgsql (bodies are
-- not checked at CREATE time).
CREATE TABLE IF NOT EXISTS auth.users (
    id uuid PRIMARY KEY,
    raw_app_meta_data jsonb DEFAULT '{}'::jsonb
);
`;

const ADVISOR_KEYS_SORTED = ["advisor_name", "email", "is_active", "role"].sort();

let adminPool: Pool;
let scratchPool: Pool | null = null;
let scratchDbName = "";

interface LegacyAdvisor {
  advisorId: number;
  name: string;
  email: string;
}
let legacyBound: LegacyAdvisor;
let legacyUnbound: LegacyAdvisor;

async function applySql(pool: Pool, sql: string, label: string): Promise<void> {
  try {
    await pool.query(sql);
  } catch (caught) {
    throw new Error(`${label} failed on the scratch database: ${(caught as Error).message}`);
  }
}

beforeAll(async () => {
  adminPool = createDbPool(env);

  scratchDbName = `ocf_contract_advisor_upgrade_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  await adminPool.query(`CREATE DATABASE ${scratchDbName}`);

  const scratchUrl = new URL(env.dbUrl);
  scratchUrl.pathname = `/${scratchDbName}`;
  scratchPool = attachPoolErrorHandler(
    new Pool({
      connectionString: scratchUrl.toString(),
      max: 5,
      connectionTimeoutMillis: 10_000,
    }),
    "advisor-audit-upgrade scratch"
  );

  await applySql(scratchPool, AUTH_SCAFFOLD_SQL, "auth scaffold");

  const migrationFiles = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  const advisorIndex = migrationFiles.indexOf(ADVISOR_MIGRATION);
  expect(
    advisorIndex,
    `${ADVISOR_MIGRATION} must exist in the migration directory`
  ).toBeGreaterThan(0);

  // Apply the ENTIRE pre-advisor chain verbatim so the advisor migration runs
  // over the exact production schema.
  for (const file of migrationFiles.slice(0, advisorIndex)) {
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
    await applySql(scratchPool, sql, `migration ${file}`);
  }

  // Seed LEGACY advisor rows BEFORE the advisor migration applies.
  const boundUserId = randomUUID();
  await scratchPool.query(
    `INSERT INTO auth.users (id, raw_app_meta_data) VALUES ($1, '{}'::jsonb)`,
    [boundUserId]
  );
  const boundName = syntheticName("legacy-bound");
  const boundEmail = syntheticEmail("legacy-bound");
  const bound = await scratchPool.query<{ advisor_id: number }>(
    `INSERT INTO public.advisor (advisor_name, email, auth_user_id, is_active, role)
     VALUES ($1, $2, $3, true, 'Advisor')
     RETURNING advisor_id`,
    [boundName, boundEmail, boundUserId]
  );
  const unboundName = syntheticName("legacy-unbound");
  const unboundEmail = syntheticEmail("legacy-unbound");
  const unbound = await scratchPool.query<{ advisor_id: number }>(
    `INSERT INTO public.advisor (advisor_name, email, is_active, role)
     VALUES ($1, $2, true, 'Advisor')
     RETURNING advisor_id`,
    [unboundName, unboundEmail]
  );
  legacyBound = { advisorId: bound.rows[0].advisor_id, name: boundName, email: boundEmail };
  legacyUnbound = { advisorId: unbound.rows[0].advisor_id, name: unboundName, email: unboundEmail };

  // Apply the advisor migration ON TOP of the existing rows.
  const advisorSql = await readFile(path.join(MIGRATIONS_DIR, ADVISOR_MIGRATION), "utf8");
  await applySql(scratchPool, advisorSql, `migration ${ADVISOR_MIGRATION}`);
}, 180_000);

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

// ---------------------------------------------------------------------------
// Scratch-DB fixture helpers
// ---------------------------------------------------------------------------

async function seedBoundAdvisor(
  label: string,
  admin: boolean
): Promise<{ userId: string; advisorId: number }> {
  if (!scratchPool) throw new Error("scratch pool not initialized");
  const userId = randomUUID();
  await scratchPool.query(
    `INSERT INTO auth.users (id, raw_app_meta_data) VALUES ($1, $2::jsonb)`,
    [userId, JSON.stringify({ ocf_admin: admin })]
  );
  const result = await scratchPool.query<{ advisor_id: number }>(
    `INSERT INTO public.advisor (advisor_name, email, auth_user_id, is_active, role)
     VALUES ($1, $2, $3, true, $4)
     RETURNING advisor_id`,
    [syntheticName(label), syntheticEmail(label), userId, admin ? "Admin" : "Advisor"]
  );
  return { userId, advisorId: result.rows[0].advisor_id };
}

/** Direct positional call: set_advisor_role(p_advisor_id, p_role, p_reason, p_actor_id). */
async function setRole(
  client: Pool | PoolClient,
  advisorId: number,
  role: string,
  actorAdvisorId: number,
  reason: string
): Promise<void> {
  await client.query(`SELECT public.set_advisor_role($1, $2, $3, $4)`, [
    advisorId,
    role,
    reason,
    actorAdvisorId,
  ]);
}

async function durableAdminCount(client: Pool | PoolClient): Promise<number> {
  const { rows } = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM public.advisor a JOIN auth.users u ON u.id = a.auth_user_id
      WHERE a.is_active = true
        AND u.raw_app_meta_data -> 'ocf_admin' = 'true'::jsonb`
  );
  return rows[0].n;
}

async function readAdvisorAudit(advisorId: number): Promise<
  Array<{
    action: string;
    actor_advisor_id: number | null;
    actor_name_snapshot: string;
    origin: string;
    old_values: Record<string, unknown> | null;
    new_values: Record<string, unknown> | null;
    changes: Record<string, unknown> | null;
  }>
> {
  if (!scratchPool) throw new Error("scratch pool not initialized");
  const { rows } = await scratchPool.query(
    `SELECT action, actor_advisor_id, actor_name_snapshot, origin,
            old_values, new_values, changes
       FROM public.audit_event
      WHERE entity_type = 'advisor' AND entity_id = $1
      ORDER BY audit_id`,
    [advisorId]
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Upgrade path
// ---------------------------------------------------------------------------

describe("advisor_admin_immutable_history upgrade path", () => {
  it("applies over existing advisor rows without fabricating history and installs the final RPC surface", async () => {
    expect(scratchPool).not.toBeNull();

    // No baseline events for the pre-existing advisor rows.
    expect((await readAdvisorAudit(legacyBound.advisorId)).length, "bound legacy advisor baseline").toBe(0);
    expect((await readAdvisorAudit(legacyUnbound.advisorId)).length, "unbound legacy advisor baseline").toBe(0);

    // Legacy rows are unchanged by the migration.
    const { rows } = await scratchPool!.query<{
      advisor_name: string;
      email: string;
      is_active: boolean;
      role: string;
    }>(
      `SELECT advisor_name, email, is_active, role FROM public.advisor WHERE advisor_id = $1`,
      [legacyBound.advisorId]
    );
    expect(rows[0]).toEqual({
      advisor_name: legacyBound.name,
      email: legacyBound.email,
      is_active: true,
      role: "Advisor",
    });

    // New surface present; legacy overloads gone.
    const surface = await scratchPool!.query<{
      provision: string | null;
      set_role: string | null;
      set_role_legacy: string | null;
      lifecycle: string | null;
      lifecycle_legacy: string | null;
      actor_validator: string | null;
      actor_setter: string | null;
      lock_actor_validator: string | null;
      email_guard: string | null;
    }>(
      `SELECT
         to_regprocedure('public.provision_advisor(integer,text,text,uuid,text)')::text AS provision,
         to_regprocedure('public.set_advisor_role(integer,text,text,integer)')::text AS set_role,
         to_regprocedure('public.set_advisor_role(integer,text)')::text AS set_role_legacy,
         to_regprocedure('public.lifecycle_transition(text,text,integer,text)')::text AS lifecycle,
         to_regprocedure('public.lifecycle_transition(text,text,integer)')::text AS lifecycle_legacy,
         to_regprocedure('private.assert_durable_effective_admin(integer)')::text AS actor_validator,
         to_regprocedure('private.set_audit_actor(integer)')::text AS actor_setter,
         to_regprocedure('private.lock_and_assert_durable_effective_admin(integer)')::text AS lock_actor_validator,
         to_regprocedure('public.guard_advisor_email_direct_write()')::text AS email_guard`
    );
    expect(surface.rows[0].provision).not.toBeNull();
    expect(surface.rows[0].set_role).not.toBeNull();
    expect(surface.rows[0].set_role_legacy, "the 2-arg set_advisor_role must be dropped").toBeNull();
    expect(surface.rows[0].lifecycle).not.toBeNull();
    expect(surface.rows[0].lifecycle_legacy, "the 3-arg lifecycle_transition must be dropped").toBeNull();
    expect(surface.rows[0].actor_validator).not.toBeNull();
    expect(surface.rows[0].actor_setter).not.toBeNull();
    expect(
      surface.rows[0].lock_actor_validator,
      "the actor must be re-validated under the membership lock"
    ).not.toBeNull();
    expect(surface.rows[0].email_guard, "the advisor.email direct-write guard exists").not.toBeNull();
  });

  it("emits the first System event for the first post-upgrade advisor mutation with the allowlist", async () => {
    const rename = `${legacyBound.name} (post-upgrade)`;
    await scratchPool!.query(`UPDATE public.advisor SET advisor_name = $1 WHERE advisor_id = $2`, [
      rename,
      legacyBound.advisorId,
    ]);

    const events = await readAdvisorAudit(legacyBound.advisorId);
    expect(events, "exactly the first event").toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "updated",
      actor_advisor_id: null,
      actor_name_snapshot: "System",
      origin: "system",
    });
    expect(Object.keys(events[0].new_values ?? {}).sort(), "advisor allowlist exactly").toEqual(
      ADVISOR_KEYS_SORTED
    );
    expect(events[0].changes).toMatchObject({ advisor_name: { old: legacyBound.name, new: rename } });
  });
});

// ---------------------------------------------------------------------------
// Lock serialization / trusted-actor revalidation / last-Admin
// ---------------------------------------------------------------------------

describe("advisor role change concurrency and last-Admin invariant", () => {
  it("does not let a transaction whose actor was demoted while it waited on the lock succeed", async () => {
    if (!scratchPool) throw new Error("scratch pool not initialized");

    const actorA = await seedBoundAdvisor("lock-actor-a", true);
    const actorB = await seedBoundAdvisor("lock-actor-b", true);
    const targetC = await seedBoundAdvisor("lock-target-c", false);

    const c1 = await scratchPool.connect();
    const c2 = await scratchPool.connect();
    try {
      // T1 takes the membership lock and demotes actor B, but does not commit
      // yet.
      await c1.query("BEGIN");
      await setRole(c1, actorB.advisorId, "Advisor", actorA.advisorId, "demote actor B");

      // T2's actor B is still a durable Admin at the moment T2 validates it
      // (T1 is uncommitted), so it proceeds to the lock and blocks.
      await c2.query("BEGIN");
      const t2 = setRole(c2, targetC.advisorId, "Admin", actorB.advisorId, "promote C using actor B");
      const settled = await Promise.race([
        t2.then(
          () => "settled",
          () => "settled"
        ),
        new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 400)),
      ]);
      expect(settled, "the competing role change must wait on the membership lock").toBe("blocked");

      // Commit T1: actor B is now durably demoted. A correct implementation
      // re-validates the trusted actor against the post-serialization state,
      // so T2 must fail rather than mutate C under a stale actor.
      await c1.query("COMMIT");
      await expect(t2).rejects.toMatchObject({ code: "42501" });

      const { rows } = await scratchPool.query<{ role: string; ocf_admin: boolean | null }>(
        `SELECT a.role, (u.raw_app_meta_data -> 'ocf_admin')::boolean AS ocf_admin
           FROM public.advisor a JOIN auth.users u ON u.id = a.auth_user_id
          WHERE a.advisor_id = $1`,
        [targetC.advisorId]
      );
      expect(rows[0].role, "the stale-actor mutation left the target unchanged").toBe("Advisor");
      expect(rows[0].ocf_admin, "the stale actor did not grant a claim").toBe(false);
    } finally {
      try {
        await c1.query("ROLLBACK");
      } catch {
        /* already committed */
      }
      try {
        await c2.query("ROLLBACK");
      } catch {
        /* already rolled back */
      }
      c1.release();
      c2.release();
    }
  });

  it("rejects the demotion that would leave zero durable Admins", async () => {
    if (!scratchPool) throw new Error("scratch pool not initialized");

    const adminOne = await seedBoundAdvisor("last-one", true);
    const adminTwo = await seedBoundAdvisor("last-two", true);

    // Deterministic membership: only these two remain durable Admins.
    await scratchPool.query(
      `UPDATE auth.users u
          SET raw_app_meta_data = jsonb_set(
                coalesce(u.raw_app_meta_data, '{}'::jsonb), '{ocf_admin}', 'false'::jsonb)
        WHERE u.id IN (
                SELECT a.auth_user_id FROM public.advisor a
                 WHERE a.is_active = true AND a.auth_user_id IS NOT NULL)
          AND u.id <> ALL($1::uuid[])`,
      [[adminOne.userId, adminTwo.userId]]
    );
    expect(await durableAdminCount(scratchPool), "two durable Admins seeded").toBe(2);

    // Non-final reduction succeeds...
    await setRole(scratchPool, adminTwo.advisorId, "Advisor", adminOne.advisorId, "reduce one");
    expect(await durableAdminCount(scratchPool), "one durable Admin remains").toBe(1);

    // ...the final reduction is rejected and the last Admin survives.
    await expect(
      setRole(scratchPool, adminOne.advisorId, "Advisor", adminOne.advisorId, "final reduction")
    ).rejects.toMatchObject({ code: "42501" });
    expect(await durableAdminCount(scratchPool), "the last Admin is preserved").toBe(1);
  });
});
