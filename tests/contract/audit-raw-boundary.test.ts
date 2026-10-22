/**
 * tests/contract/audit-raw-boundary.test.ts
 *
 * Database contract for migration 20261023000001_audit_event_raw_payload_boundary:
 * the DB-enforced raw audit JSON boundary.
 *
 * Proves, against the fresh isolated Docker-local contract lane:
 *   - `authenticated` holds NO table-level SELECT on `public.audit_event` (so an
 *     unqualified/`*` select can never reach the raw payload columns) and holds
 *     COLUMN-level SELECT on EXACTLY the non-raw columns the security_invoker
 *     `audit_activity` view references;
 *   - the raw payload columns `old_values`/`new_values`/`changes` stay present on
 *     the table but are unreadable by `authenticated` (and by `anon`);
 *   - the `security_invoker` `audit_activity` view still reads successfully under
 *     an active advisor's own privileges, and the active-advisor RLS still governs
 *     the rows (a session with no active advisor sees zero rows, not an error);
 *   - the browser-facing PostgREST path can select the safe `audit_event` columns
 *     but is DENIED the raw `changes` column (SQLSTATE 42501), while the
 *     server-only service-role path can still read the raw diff.
 *
 * Service role is used strictly for fixture seeding and the server-only raw-read
 * oracle; it is never asserted as a client access grant.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createDbPool, createServiceRoleClient, getContractEnv } from "./helpers/setup";
import { createAuthUser, signInWithPassword, syntheticEmail, syntheticName } from "./helpers/fixtures";

const env = getContractEnv();
const service = createServiceRoleClient(env);
let pool: Pool;

let seq = 0;
const nextUnique = (prefix: string): string => `${prefix}-${++seq}`;

/** Fresh anon-key client; sign-in upgrades it to the `authenticated` role. */
function freshClient(): SupabaseClient {
  return createClient(env.apiUrl, env.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

interface Actor {
  advisorId: number;
  client: SupabaseClient;
}

/** An ACTIVE advisor bound to a signed-in auth user (RLS-visible audit rows). */
async function createStaff(label: string): Promise<Actor> {
  const tag = nextUnique(label);
  const email = syntheticEmail(tag);
  const userId = await createAuthUser(service, email);
  const advisorId = (
    await service
      .from("advisor")
      .insert({ advisor_name: syntheticName(tag), email, is_active: true })
      .select("advisor_id")
      .single()
  ).data!.advisor_id as number;
  await service.from("advisor").update({ auth_user_id: userId }).eq("advisor_id", advisorId);
  const client = freshClient();
  await signInWithPassword(client, email);
  return { advisorId, client };
}

/** A signed-in auth user with NO advisor row (RLS-filtered to zero rows). */
async function createNoAdvisor(label: string): Promise<SupabaseClient> {
  const email = syntheticEmail(nextUnique(label));
  await createAuthUser(service, email);
  const client = freshClient();
  await signInWithPassword(client, email);
  return client;
}

/** The exact non-raw columns the `audit_activity` view reads from `audit_event`. */
const EXPECTED_AUTHENTICATED_COLUMNS = [
  "action",
  "actor_advisor_id",
  "actor_name_snapshot",
  "audit_id",
  "entity_id",
  "entity_type",
  "occurred_at",
  "origin",
  "reason",
  "subject_application_id",
  "subject_fellowship_id",
  "subject_student_id",
].sort();

const RAW_PAYLOAD_COLUMNS = ["old_values", "new_values", "changes"] as const;

let staff: Actor;
let noAdvisor: SupabaseClient;

beforeAll(async () => {
  pool = createDbPool(env);
  staff = await createStaff("raw-boundary-staff");
  noAdvisor = await createNoAdvisor("raw-boundary-no-advisor");
  // A real audited write so the lane has at least one event visible to the
  // active advisor (the fellowship INSERT audit trigger writes exactly one).
  const { error } = await staff.client
    .from("fellowship")
    .insert({ fellowship_name: syntheticName(nextUnique("raw-boundary-fellowship")) })
    .select("fellowship_id")
    .single();
  if (error) throw new Error(`seed audited fellowship: ${error.message}`);
}, 60_000);

afterAll(async () => {
  if (pool) await pool.end();
});

describe("audit_event raw-payload column boundary (migration 20261023000001)", () => {
  it("keeps the raw payload columns present but revokes table SELECT and grants only the safe columns", async () => {
    const { rows } = await pool.query<{
      all_cols: string[];
      auth_cols: string[];
      auth_table: boolean;
      anon_table: boolean;
      anon_id: boolean;
      sr_changes: boolean;
    }>(
      `SELECT
         (SELECT array_agg(column_name::text ORDER BY column_name)
            FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'audit_event') AS all_cols,
         (SELECT array_agg(column_name::text ORDER BY column_name)
            FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'audit_event'
             AND has_column_privilege('authenticated', 'public.audit_event', column_name, 'SELECT')) AS auth_cols,
         has_table_privilege('authenticated', 'public.audit_event', 'SELECT') AS auth_table,
         has_table_privilege('anon', 'public.audit_event', 'SELECT') AS anon_table,
         has_column_privilege('anon', 'public.audit_event', 'audit_id', 'SELECT') AS anon_id,
         has_column_privilege('service_role', 'public.audit_event', 'changes', 'SELECT') AS sr_changes`
    );
    const row = rows[0];

    // The raw payload columns still EXIST on the base table (this is a privilege
    // boundary, not a column removal).
    for (const raw of RAW_PAYLOAD_COLUMNS) {
      expect(row.all_cols, `audit_event keeps raw column ${raw}`).toContain(raw);
    }

    // Table-level SELECT is gone: an unqualified/`*` select (and therefore the
    // raw payloads) can never be resolved through a table-level grant.
    expect(row.auth_table, "authenticated table-level SELECT must be revoked").toBe(false);
    expect(row.anon_table, "anon table-level SELECT must be false").toBe(false);
    expect(row.anon_id, "anon column-level SELECT must be false").toBe(false);

    // Exactly the non-raw columns the security_invoker view reads are granted.
    expect(row.auth_cols, "authenticated column SELECT is exactly the safe columns").toEqual(
      EXPECTED_AUTHENTICATED_COLUMNS
    );
    for (const raw of RAW_PAYLOAD_COLUMNS) {
      expect(row.auth_cols, `authenticated must NOT hold SELECT on ${raw}`).not.toContain(raw);
    }

    // The server-only service-role client keeps the raw-diff read path.
    expect(row.sr_changes, "service_role keeps SELECT on changes").toBe(true);
  });
});

describe("PostgREST behavior under the raw-payload boundary", () => {
  it("lets an active advisor read the safe view and safe event columns", async () => {
    const viewRead = await staff.client.from("audit_activity").select("audit_id, action, entity_type").limit(1);
    expect(viewRead.error, "active advisor reads the security_invoker audit_activity view").toBeNull();
    expect(viewRead.data ?? [], "the safe view exposes rows to the active advisor").not.toHaveLength(0);

    const eventRead = await staff.client.from("audit_event").select("audit_id, entity_type, action").limit(1);
    expect(eventRead.error, "active advisor reads the granted audit_event columns").toBeNull();
    expect(eventRead.data ?? [], "at least one granted audit_event row is visible").not.toHaveLength(0);
  });

  it("DENIES the browser a raw payload column (changes) with permission denied", async () => {
    for (const raw of RAW_PAYLOAD_COLUMNS) {
      const { data, error } = await staff.client.from("audit_event").select(raw).limit(1);
      expect(data, `raw column ${raw} must not be returned`).toBeNull();
      expect(error, `selecting raw column ${raw} must fail`).not.toBeNull();
      expect(error?.code, `raw column ${raw} denial code`).toBe("42501");
    }
  });

  it("keeps the active-advisor RLS in force through the security_invoker view and granted columns", async () => {
    const viewRead = await noAdvisor.from("audit_activity").select("audit_id").limit(5);
    expect(viewRead.error, "a no-advisor read is RLS-filtered, not an error").toBeNull();
    expect(viewRead.data ?? [], "zero rows are visible to a session without an active advisor").toHaveLength(0);

    const eventRead = await noAdvisor.from("audit_event").select("audit_id").limit(5);
    expect(eventRead.error, "a no-advisor granted-column read is RLS-filtered, not an error").toBeNull();
    expect(eventRead.data ?? [], "zero audit_event rows are visible without an active advisor").toHaveLength(0);
  });

  it("round-trips the raw diff only through the server-only service-role client", async () => {
    const { data, error } = await service.from("audit_event").select("audit_id, changes").limit(1);
    expect(error, "service_role reads the raw diff (server-only path)").toBeNull();
    expect(data ?? [], "service_role can read the raw changes column").not.toHaveLength(0);
  });
});
