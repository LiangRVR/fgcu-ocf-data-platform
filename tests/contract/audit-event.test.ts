/**
 * tests/contract/audit-event.test.ts
 *
 * Contract tests for migration 20261012000001_immutable_audit (approved
 * immutable-audit-trail design; Works 1–5).
 *
 * Proves, against the fresh isolated Docker-local contract lane:
 *
 *   - CREATED EVENTS: student/fellowship/application INSERTs emit exactly one
 *     `created` event with NULL old_values/changes, the whitelisted
 *     new_values snapshot, and correct origin/actor (user for authenticated
 *     active-advisor writes, System/system for technical service-role writes).
 *   - DIFF CONTRACT: meaningful updates emit exactly one `updated` event whose
 *     `changes` JSON has the `{field: {old, new}}` shape; only whitelisted
 *     fields that differ under `IS DISTINCT FROM` appear; old/new snapshots
 *     are retained. A no-op restatement creates no event.
 *   - APPLICATION STAGE + CONTEXT: stage updates show old/new and the event
 *     carries the immutable subject_student_id / subject_application_id /
 *     subject_fellowship_id context.
 *   - LIFECYCLE CLASSIFICATION: the lifecycle_transition RPC emits exactly ONE
 *     canonical `archived` (null→stamp) / `restored` (stamp→null) event — never
 *     a generic `updated` event — and an idempotent re-apply emits nothing.
 *   - ACTOR NAME SNAPSHOT: events copy the advisor_name AT EVENT TIME; a later
 *     advisor rename cannot rewrite a prior event and a subsequent event
 *     records the new name.
 *   - IMMUTABILITY / READ MODEL: anon cannot read; active advisors (including
 *     effective Admin) can read; authenticated and Admin direct
 *     INSERT/UPDATE/DELETE on audit_event are denied (42501).
 *   - SNAPSHOT/CHANGES EXCLUSIONS: snapshots contain exactly the documented
 *     whitelist keys and never technical/binding/PK columns.
 *   - ATOMIC ROLLBACK: an audit-write failure (unresolved authenticated actor)
 *     aborts and rolls back the source mutation in the same transaction.
 *   - SCHEMA/ACL/RLS/HARDENING: exact columns/CHECKs, no FKs, the six btree
 *     chronology indexes (no GIN), RLS+single active-advisor SELECT policy,
 *     SELECT-only authenticated grant, sequence/private-schema/helper-EXECUTE
 *     denial, SECURITY DEFINER helper with empty search_path, and the four
 *     AFTER INSERT OR UPDATE triggers (student/fellowship/application from
 *     migration 20261012000001 plus the advisor helper from migration
 *     20261013000001).
 *   - LEGACY BEHAVIOR INTACT: source-table writes, the lifecycle RPC, and the
 *     direct lifecycle-field guards keep working with the audit layer present.
 *
 * Service-role usage is restricted to seeding synthetic fixtures, creating
 * local auth users, the admin pre-bind, and re-reading audit rows as the
 * persisted-state oracle (service_role bypasses the audit RLS for reads only;
 * it is never asserted as an access grant). Every event assertion is scoped to
 * this suite's own synthetic entity ids, never global table totals.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  createAnonClient,
  createDbPool,
  createServiceRoleClient,
  getContractEnv,
} from "./helpers/setup";
import {
  createAuthUser,
  signInWithPassword,
  syntheticEmail,
  syntheticName,
} from "./helpers/fixtures";

const env = getContractEnv();
const service = createServiceRoleClient(env);
const anon = createAnonClient(env);
let pool: Pool;

// ---------------------------------------------------------------------------
// Fixture helpers (scoped to this file; no shared fixture changes required)
// ---------------------------------------------------------------------------

let fixtureSeq = 0;
function nextUnique(prefix: string): string {
  fixtureSeq += 1;
  return `${prefix}-${fixtureSeq}`;
}

function freshClient(): SupabaseClient {
  return createClient(env.apiUrl, env.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

interface AuditRow {
  audit_id: number;
  entity_type: string;
  entity_id: number;
  action: string;
  actor_advisor_id: number | null;
  actor_name_snapshot: string;
  occurred_at: string;
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
  changes: Record<string, { old: unknown; new: unknown }> | null;
  reason: string | null;
  subject_student_id: number | null;
  subject_application_id: number | null;
  subject_fellowship_id: number | null;
  origin: string;
}

interface Actor {
  userId: string;
  email: string;
  advisorName: string;
  client: SupabaseClient;
  advisorId: number;
}

async function insertAdvisor(advisorName: string, email: string, isActive = true): Promise<number> {
  const { data, error } = await service
    .from("advisor")
    .insert({ advisor_name: advisorName, email, is_active: isActive })
    .select("advisor_id")
    .single();
  if (error) throw new Error(`seed advisor ${advisorName}: ${error.message}`);
  return data.advisor_id as number;
}

/** ADMIN PRE-BINDING: the only legitimate way auth_user_id is ever written. */
async function bindAdvisor(advisorId: number, userId: string): Promise<void> {
  const { error } = await service
    .from("advisor")
    .update({ auth_user_id: userId })
    .eq("advisor_id", advisorId)
    .select("advisor_id");
  if (error) throw new Error(`admin pre-bind advisor ${advisorId}: ${error.message}`);
}

/**
 * Signed-in authenticated ACTIVE bound advisor. With `admin: true` the Auth
 * `app_metadata.ocf_admin = true` claim makes them an effective Admin.
 */
async function createBoundActor(label: string, admin = false): Promise<Actor> {
  const tag = nextUnique(label);
  const email = syntheticEmail(tag);
  const advisorName = syntheticName(tag);
  const userId = await createAuthUser(
    service,
    email,
    admin ? { appMetadata: { ocf_admin: true } } : {}
  );
  const advisorId = await insertAdvisor(advisorName, email, true);
  await bindAdvisor(advisorId, userId);
  const client = freshClient();
  const signed = await signInWithPassword(client, email);
  if (signed !== userId) throw new Error(`${label} sign-in returned a different user`);
  return { userId, email, advisorName, client, advisorId };
}

/** Signed-in authenticated user with NO advisor row at all. */
async function createNoAdvisorActor(label: string): Promise<Actor> {
  const tag = nextUnique(label);
  const email = syntheticEmail(tag);
  const userId = await createAuthUser(service, email);
  const client = freshClient();
  const signed = await signInWithPassword(client, email);
  if (signed !== userId) throw new Error(`${label} sign-in returned a different user`);
  return { userId, email, advisorName: "", client, advisorId: -1 };
}

/** Signed-in authenticated user bound to an INACTIVE advisor row. */
async function createInactiveBoundActor(label: string): Promise<Actor> {
  const tag = nextUnique(label);
  const email = syntheticEmail(tag);
  const advisorName = syntheticName(tag);
  const userId = await createAuthUser(service, email);
  const advisorId = await insertAdvisor(advisorName, email, false);
  await bindAdvisor(advisorId, userId);
  const client = freshClient();
  const signed = await signInWithPassword(client, email);
  if (signed !== userId) throw new Error(`${label} sign-in returned a different user`);
  return { userId, email, advisorName, client, advisorId };
}

async function seedStudent(label: string, extra: Record<string, unknown> = {}): Promise<number> {
  const tag = nextUnique(label);
  const { data, error } = await service
    .from("student")
    .insert({
      full_name: syntheticName(tag),
      email: syntheticEmail(tag),
      us_citizen: true,
      ...extra,
    })
    .select("student_id")
    .single();
  if (error) throw new Error(`seed student: ${error.message}`);
  return data.student_id as number;
}

async function seedFellowship(label: string): Promise<number> {
  const { data, error } = await service
    .from("fellowship")
    .insert({ fellowship_name: syntheticName(nextUnique(label)) })
    .select("fellowship_id")
    .single();
  if (error) throw new Error(`seed fellowship: ${error.message}`);
  return data.fellowship_id as number;
}

async function seedApplication(label: string, extra: Record<string, unknown> = {}): Promise<{
  applicationId: number;
  studentId: number;
  fellowshipId: number;
}> {
  const studentId = await seedStudent(`${label}-student`);
  const fellowshipId = await seedFellowship(`${label}-fellowship`);
  const { data, error } = await service
    .from("application")
    .insert({
      student_id: studentId,
      fellowship_id: fellowshipId,
      destination_country: "Testland",
      stage_of_application: "Submitted",
      ...extra,
    })
    .select("application_id")
    .single();
  if (error) throw new Error(`seed application: ${error.message}`);
  return { applicationId: data.application_id as number, studentId, fellowshipId };
}

/** Oracle read of the audit rows for one (entity_type, entity_id). */
async function readAudit(entityType: string, entityId: number): Promise<AuditRow[]> {
  const { rows } = await pool.query<AuditRow>(
    `SELECT audit_id, entity_type, entity_id, action, actor_advisor_id,
            actor_name_snapshot, occurred_at, old_values, new_values, changes,
            reason, subject_student_id, subject_application_id,
            subject_fellowship_id, origin
       FROM public.audit_event
      WHERE entity_type = $1 AND entity_id = $2
      ORDER BY audit_id`,
    [entityType, entityId]
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Release-hardening oracles: authenticated-role TRUNCATE, database-authored
// timestamps, and reserved-baseline evidence.
// ---------------------------------------------------------------------------

/** Current database wall-clock time as epoch milliseconds (bracket oracle). */
async function dbNowMs(): Promise<number> {
  const { rows } = await pool.query<{ now_ms: string }>(
    "SELECT (extract(epoch from clock_timestamp()) * 1000)::bigint::text AS now_ms"
  );
  return Number(rows[0].now_ms);
}

/**
 * Epoch milliseconds for an audit timestamp. node-postgres returns
 * `timestamptz` as a `Date` whose `toString()` DROPS milliseconds, so
 * `new Date(String(value))` would silently truncate the precision needed for a
 * sub-second window check. Always take `Date#getTime()` directly.
 */
function auditEpochMs(value: string | Date): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

/**
 * Assert an audit `occurred_at` is DATABASE-authored: it must fall inside the
 * [before, after] wall-clock window captured around the mutation, so it cannot
 * be a client-supplied or fabricated value.
 */
function expectDbAuthoredTimestamp(
  occurredAt: string | Date,
  beforeMs: number,
  afterMs: number,
  label: string
): number {
  const value = auditEpochMs(occurredAt);
  expect(Number.isFinite(value), `${label}: occurred_at parses`).toBe(true);
  expect(value, `${label}: not before the pre-write database clock`).toBeGreaterThanOrEqual(beforeMs);
  expect(value, `${label}: not after the post-write database clock`).toBeLessThanOrEqual(afterMs);
  return value;
}

/**
 * REAL authenticated TRUNCATE attempt. `SET LOCAL ROLE authenticated` mirrors
 * the exact PostgREST request role, and the attempt runs inside a transaction
 * that is ALWAYS rolled back — so even an unexpected TRUNCATE grant could never
 * destroy history. Returns the rejection SQLSTATE (undefined when it was NOT
 * denied, which is a failure the assertion surfaces).
 */
async function authenticatedTruncateCode(table: string): Promise<string | undefined> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE authenticated");
    const { rows } = await client.query<{ role: string }>("SELECT current_user AS role");
    if (rows[0]?.role !== "authenticated") {
      throw new Error(`could not assume the authenticated role (current_user=${rows[0]?.role})`);
    }
    try {
      await client.query(`TRUNCATE TABLE public.${table}`);
      return undefined;
    } catch (error) {
      return (error as { code?: string }).code;
    }
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

/** Read `row_version` and the raw `updated_at` epoch for one current-state row. */
async function readVersionTimestamp(
  table: "student" | "fellowship" | "application",
  idColumn: string,
  id: number
): Promise<{ row_version: number; updated_at_epoch: number }> {
  const { rows } = await pool.query<{ row_version: number; updated_at_epoch: number }>(
    `SELECT row_version, extract(epoch from updated_at)::double precision AS updated_at_epoch
       FROM public.${table} WHERE ${idColumn} = $1`,
    [id]
  );
  if (rows.length !== 1) throw new Error(`no ${table} row ${id} for version/timestamp read`);
  return { row_version: rows[0].row_version, updated_at_epoch: Number(rows[0].updated_at_epoch) };
}

/** Direct positional SQL call to the pinned `update_application` writer. */
async function directUpdateApplicationViaSql(
  client: PoolClient,
  applicationId: number,
  expectedVersion: number,
  row: {
    student_id: number;
    fellowship_id: number;
    application_year: number | null;
    destination_country: string | null;
    stage_of_application: string;
    is_semi_finalist: boolean;
    is_finalist: boolean;
  }
): Promise<void> {
  await client.query(
    `SELECT public.update_application($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      applicationId,
      expectedVersion,
      row.student_id,
      row.fellowship_id,
      row.application_year,
      row.destination_country,
      row.stage_of_application,
      row.is_semi_finalist,
      row.is_finalist,
    ]
  );
}

// Whitelists asserted verbatim (sorted).
const STUDENT_KEYS = [
  "age",
  "archived_at",
  "class_standing",
  "email",
  "first_gen",
  "full_name",
  "gender",
  "gpa",
  "honors_college",
  "is_ch_student",
  "languages",
  "major",
  "minor",
  "pronouns",
  "race_ethnicity",
  "us_citizen",
].sort();
const FELLOWSHIP_KEYS = ["archived_at", "fellowship_name"].sort();
const APPLICATION_KEYS = [
  "application_year",
  "destination_country",
  "fellowship_id",
  "is_finalist",
  "is_semi_finalist",
  "stage_of_application",
  "student_id",
].sort();

// ---------------------------------------------------------------------------
// Versioned protected-writer helpers (migration 20261015000001)
//
// Migration 20261015000001 revokes direct authenticated UPDATE on the four
// current-state tables; every normal mutation now flows through the narrow
// expected-version SECURITY DEFINER writers (`update_student_profile`,
// `update_fellowship`, `update_application`) and the versioned
// `lifecycle_transition`. These helpers read the live `row_version` and write
// through the RPCs so the audit-diff contract asserted below is exercised on
// the PRODUCTION path, not a revoked table API.
// ---------------------------------------------------------------------------

/** Read the live `row_version` of a current-state row. */
async function currentRowVersion(
  table: "student" | "fellowship" | "application",
  id: number
): Promise<number> {
  const idColumn =
    table === "student" ? "student_id" : table === "fellowship" ? "fellowship_id" : "application_id";
  const { rows } = await pool.query<{ row_version: number }>(
    `SELECT row_version FROM public.${table} WHERE ${idColumn} = $1`,
    [id]
  );
  if (rows.length !== 1) throw new Error(`no ${table} row ${id} for version read`);
  return rows[0].row_version;
}

/** Full-replacement student writer: keeps every current field, applies `changes`. */
async function updateStudentViaWriter(
  actor: Actor,
  studentId: number,
  changes: Record<string, unknown>,
  expectedVersion?: number
): Promise<{ error: { code?: string; message?: string } | null }> {
  const version = expectedVersion ?? (await currentRowVersion("student", studentId));
  const { rows } = await pool.query<Record<string, unknown>>(
    `SELECT full_name, email, is_ch_student, major, minor, gpa::float8 AS gpa,
            class_standing, us_citizen, age, gender, pronouns, race_ethnicity,
            languages, first_gen, honors_college
       FROM public.student WHERE student_id = $1`,
    [studentId]
  );
  const row = rows[0];
  const { data, error } = await actor.client.rpc("update_student_profile", {
    p_student_id: studentId,
    p_expected_version: version,
    p_full_name: row.full_name,
    p_email: row.email,
    p_is_ch_student: row.is_ch_student,
    p_major: row.major,
    p_minor: row.minor,
    p_gpa: row.gpa,
    p_class_standing: row.class_standing,
    p_us_citizen: row.us_citizen,
    p_age: row.age,
    p_gender: row.gender,
    p_pronouns: row.pronouns,
    p_race_ethnicity: row.race_ethnicity,
    p_languages: row.languages,
    p_first_gen: row.first_gen,
    p_honors_college: row.honors_college,
    ...changes,
  });
  return { error: (error as { code?: string; message?: string } | null) ?? null };
}

/** Fellowship-name writer. */
async function updateFellowshipViaWriter(
  actor: Actor,
  fellowshipId: number,
  fellowshipName: string,
  expectedVersion?: number
): Promise<{ error: { code?: string; message?: string } | null }> {
  const version = expectedVersion ?? (await currentRowVersion("fellowship", fellowshipId));
  const { data, error } = await actor.client.rpc("update_fellowship", {
    p_fellowship_id: fellowshipId,
    p_expected_version: version,
    p_fellowship_name: fellowshipName,
  });
  return { error: (error as { code?: string; message?: string } | null) ?? null };
}

/** Full-replacement application writer: keeps every current field, applies `changes`. */
async function updateApplicationViaWriter(
  actor: Actor,
  applicationId: number,
  changes: Record<string, unknown>,
  expectedVersion?: number
): Promise<{ error: { code?: string; message?: string } | null }> {
  const version = expectedVersion ?? (await currentRowVersion("application", applicationId));
  const { rows } = await pool.query<Record<string, unknown>>(
    `SELECT student_id, fellowship_id, application_year,
            destination_country, stage_of_application,
            is_semi_finalist, is_finalist
       FROM public.application WHERE application_id = $1`,
    [applicationId]
  );
  const row = rows[0];
  const { data, error } = await actor.client.rpc("update_application", {
    p_application_id: applicationId,
    p_expected_version: version,
    p_student_id: row.student_id,
    p_fellowship_id: row.fellowship_id,
    p_application_year: row.application_year,
    p_destination_country: row.destination_country,
    p_stage_of_application: row.stage_of_application,
    p_is_semi_finalist: row.is_semi_finalist,
    p_is_finalist: row.is_finalist,
    ...changes,
  });
  return { error: (error as { code?: string; message?: string } | null) ?? null };
}

/** Versioned lifecycle RPC wrapper (auto-reads the target's current version). */
async function lifecycleRpc(
  client: SupabaseClient,
  entity: "student" | "fellowship",
  action: string,
  entityId: number,
  reason: string
): Promise<{ data: unknown; error: { code?: string; message?: string } | null }> {
  const version = await currentRowVersion(entity, entityId);
  const { data, error } = await client.rpc("lifecycle_transition", {
    p_entity: entity,
    p_action: action,
    p_entity_id: entityId,
    p_reason: reason,
    p_expected_version: version,
  });
  return { data, error: (error as { code?: string; message?: string } | null) ?? null };
}

// ---------------------------------------------------------------------------
// Suite state
// ---------------------------------------------------------------------------

let staff: Actor; // active bound advisor (no claim)
let admin: Actor; // active bound advisor + ocf_admin claim (effective Admin)
let noAdvisor: Actor; // authenticated user with no advisor row
let inactiveBound: Actor; // authenticated user bound to an INACTIVE advisor

beforeAll(async () => {
  pool = createDbPool(env);
  staff = await createBoundActor("staff");
  admin = await createBoundActor("admin", true);
  noAdvisor = await createNoAdvisorActor("no-advisor");
  inactiveBound = await createInactiveBoundActor("inactive-bound");
});

afterAll(async () => {
  if (pool) await pool.end();
});

// ---------------------------------------------------------------------------
// Created events
// ---------------------------------------------------------------------------

describe("audit created events (R3/R4)", () => {
  it("authenticated student INSERT emits exactly one created event with user origin, actor, and the whitelisted snapshot", async () => {
    const tag = nextUnique("created-student");
    const { data, error } = await staff.client
      .from("student")
      .insert({
        full_name: syntheticName(tag),
        email: syntheticEmail(tag),
        us_citizen: true,
        first_gen: false,
        honors_college: true,
        class_standing: "Junior",
        gpa: 2.5,
      })
      .select("student_id")
      .single();
    expect(error, "authenticated student INSERT").toBeNull();
    const studentId = data!.student_id as number;

    const events = await readAudit("student", studentId);
    expect(events, "one created event only").toHaveLength(1);
    const event = events[0];
    expect(event.action).toBe("created");
    expect(event.origin).toBe("user");
    expect(event.actor_advisor_id).toBe(staff.advisorId);
    expect(event.actor_name_snapshot).toBe(staff.advisorName);
    expect(event.old_values, "created events have NULL old_values").toBeNull();
    expect(event.changes, "created events have NULL changes").toBeNull();
    expect(event.subject_student_id).toBe(studentId);
    expect(event.subject_application_id).toBeNull();
    expect(event.subject_fellowship_id).toBeNull();

    const snapshot = event.new_values;
    expect(Object.keys(snapshot ?? {}).sort(), "student whitelist exactly").toEqual(STUDENT_KEYS);
    expect(snapshot).toMatchObject({
      full_name: expect.any(String),
      email: expect.any(String),
      gpa: 2.5,
      class_standing: "Junior",
      honors_college: true,
      us_citizen: true,
      archived_at: null,
    });
    expect(snapshot, "PK/technical fields never enter a student snapshot").not.toHaveProperty("student_id");
    expect(snapshot, "no technical column in a student snapshot").not.toHaveProperty("created_at");
  });

  it("service-role student INSERT emits exactly one created event with System system origin", async () => {
    const studentId = await seedStudent("system-student", { gpa: 3.0 });
    const events = await readAudit("student", studentId);
    expect(events, "one created event only").toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "created",
      origin: "system",
      actor_advisor_id: null,
      actor_name_snapshot: "System",
      old_values: null,
      changes: null,
    });
    expect(events[0].new_values).toMatchObject({ gpa: 3.0 });
  });

  it("authenticated fellowship INSERT emits exactly one created event", async () => {
    const name = syntheticName(nextUnique("created-fellowship"));
    const { data, error } = await staff.client
      .from("fellowship")
      .insert({ fellowship_name: name })
      .select("fellowship_id")
      .single();
    expect(error).toBeNull();
    const fellowshipId = data!.fellowship_id as number;

    const events = await readAudit("fellowship", fellowshipId);
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event.action).toBe("created");
    expect(event.origin).toBe("user");
    expect(event.actor_advisor_id).toBe(staff.advisorId);
    expect(Object.keys(event.new_values ?? {}).sort()).toEqual(FELLOWSHIP_KEYS);
    expect(event.new_values).toMatchObject({ fellowship_name: name, archived_at: null });
    expect(event.subject_fellowship_id).toBe(fellowshipId);
  });

  it("authenticated application INSERT emits exactly one created event with full subject context", async () => {
    const { studentId, fellowshipId } = await seedApplication("created-app-parents");
    const { data, error } = await staff.client
      .from("application")
      .insert({
        student_id: studentId,
        fellowship_id: fellowshipId,
        destination_country: "Testland",
        stage_of_application: "Submitted",
        application_year: 2026,
      })
      .select("application_id")
      .single();
    expect(error).toBeNull();
    const applicationId = data!.application_id as number;

    const events = await readAudit("application", applicationId);
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event.action).toBe("created");
    expect(event.origin).toBe("user");
    expect(event.actor_advisor_id).toBe(staff.advisorId);
    expect(Object.keys(event.new_values ?? {}).sort()).toEqual(APPLICATION_KEYS);
    expect(event.new_values).toMatchObject({
      student_id: studentId,
      fellowship_id: fellowshipId,
      stage_of_application: "Submitted",
      application_year: 2026,
    });
    // Immutable subject context on the event row.
    expect(event.subject_student_id).toBe(studentId);
    expect(event.subject_application_id).toBe(applicationId);
    expect(event.subject_fellowship_id).toBe(fellowshipId);
  });
});

// ---------------------------------------------------------------------------
// Diff contract: GPA + two-field diffs, no-op suppression
// ---------------------------------------------------------------------------

describe("audit update diffs (R6/R7)", () => {
  it("emits one updated event with {field:{old,new}} diffs for a GPA + class-standing change", async () => {
    const tag = nextUnique("diff-student");
    const { data, error } = await staff.client
      .from("student")
      .insert({
        full_name: syntheticName(tag),
        email: syntheticEmail(tag),
        us_citizen: true,
        gpa: 2.5,
        class_standing: "Freshman",
        major: "Physics",
      })
      .select("student_id")
      .single();
    expect(error).toBeNull();
    const studentId = data!.student_id as number;

    const result = await updateStudentViaWriter(staff, studentId, {
      p_gpa: 3.85,
      p_class_standing: "Senior",
    });
    expect(result.error, "two-field student update through the protected writer").toBeNull();

    const events = await readAudit("student", studentId);
    expect(events.filter((e) => e.action === "created")).toHaveLength(1);
    const updates = events.filter((e) => e.action === "updated");
    expect(updates, "exactly one updated event for the two-field change").toHaveLength(1);

    const event = updates[0];
    expect(event.origin).toBe("user");
    expect(event.actor_advisor_id).toBe(staff.advisorId);
    // The diff format contract: `{field: {old, new}}`.
    expect(event.changes).toEqual({
      gpa: { old: 2.5, new: 3.85 },
      class_standing: { old: "Freshman", new: "Senior" },
    });
    // Full old/new snapshots are populated and unchanged fields are retained
    // (so a relink-style change is never ambiguous).
    expect(event.old_values).toMatchObject({ gpa: 2.5, class_standing: "Freshman", major: "Physics" });
    expect(event.new_values).toMatchObject({ gpa: 3.85, class_standing: "Senior", major: "Physics" });
    expect(event.subject_student_id).toBe(studentId);
  });

  it("suppresses a no-op update (restating the same whitelisted values) entirely", async () => {
    const tag = nextUnique("noop-student");
    const { data, error } = await staff.client
      .from("student")
      .insert({
        full_name: syntheticName(tag),
        email: syntheticEmail(tag),
        us_citizen: true,
        gpa: 3.1,
        class_standing: "Sophomore",
      })
      .select("student_id")
      .single();
    expect(error).toBeNull();
    const studentId = data!.student_id as number;

    const noop = await updateStudentViaWriter(staff, studentId, {
      p_gpa: 3.1,
      p_class_standing: "Sophomore",
    });
    expect(noop.error, "no-op UPDATE through the protected writer succeeds").toBeNull();

    const events = await readAudit("student", studentId);
    expect(events.filter((e) => e.action === "created")).toHaveLength(1);
    expect(events.filter((e) => e.action === "updated"), "no-op update creates no event").toHaveLength(0);
  });

  it("records a single-field change with the {old,new} shape", async () => {
    const studentId = await seedStudent("single-field", { gpa: 3.0 });
    const single = await updateStudentViaWriter(staff, studentId, {
      p_major: "Chemistry",
    });
    expect(single.error).toBeNull();

    const events = await readAudit("student", studentId);
    const update = events.find((e) => e.action === "updated");
    expect(update, "one updated event").toBeDefined();
    expect(update?.changes).toEqual({ major: { old: null, new: "Chemistry" } });
  });

  it("records a fellowship name change as a single updated event", async () => {
    const name = syntheticName(nextUnique("fellowship-rename"));
    const { data, error } = await staff.client
      .from("fellowship")
      .insert({ fellowship_name: name })
      .select("fellowship_id")
      .single();
    expect(error).toBeNull();
    const fellowshipId = data!.fellowship_id as number;

    const renamed = `${name} II`;
    const rename = await updateFellowshipViaWriter(staff, fellowshipId, renamed);
    expect(rename.error).toBeNull();

    const events = await readAudit("fellowship", fellowshipId);
    const update = events.find((e) => e.action === "updated");
    expect(events.filter((e) => e.action === "updated"), "one fellowship update only").toHaveLength(1);
    expect(update?.changes).toEqual({ fellowship_name: { old: name, new: renamed } });
    expect(update?.subject_fellowship_id).toBe(fellowshipId);
  });
});

// ---------------------------------------------------------------------------
// Application stage history + subject context
// ---------------------------------------------------------------------------

describe("audit application stage history and subject context (R4/R8)", () => {
  it("records a stage transition with old/new values and full immutable context", async () => {
    const { applicationId, studentId, fellowshipId } = await seedApplication("stage-context");
    const stage = await updateApplicationViaWriter(staff, applicationId, {
      p_stage_of_application: "Finalist",
      p_is_semi_finalist: true,
      p_is_finalist: true,
    });
    expect(stage.error).toBeNull();

    const events = await readAudit("application", applicationId);
    const update = events.find((e) => e.action === "updated");
    expect(events.filter((e) => e.action === "updated"), "one application update only").toHaveLength(1);
    expect(update).toBeDefined();
    expect(update?.changes).toEqual({
      stage_of_application: { old: "Submitted", new: "Finalist" },
      is_semi_finalist: { old: false, new: true },
      is_finalist: { old: false, new: true },
    });
    expect(update?.old_values).toMatchObject({ stage_of_application: "Submitted" });
    expect(update?.new_values).toMatchObject({ stage_of_application: "Finalist" });
    // The context is the mutation-time subject, independent of any relink.
    expect(update?.entity_id).toBe(applicationId);
    expect(update?.subject_student_id).toBe(studentId);
    expect(update?.subject_application_id).toBe(applicationId);
    expect(update?.subject_fellowship_id).toBe(fellowshipId);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle archive/restore classification
// ---------------------------------------------------------------------------

describe("audit lifecycle classification: one canonical archive/restore event (R7)", () => {
  it("emits exactly one archived and one restored event for a student via the lifecycle RPC, and none for idempotent repeats", async () => {
    const studentId = await seedStudent("lifecycle-student");
    const archived = await lifecycleRpc(
      admin.client,
      "student",
      "archive",
      studentId,
      "contract lifecycle archive"
    );
    expect(archived.error).toBeNull();
    expect(archived.data).toMatchObject([{ applied: true, action: "archive" }]);

    let events = await readAudit("student", studentId);
    expect(events.filter((e) => e.action === "created"), "the original created event remains").toHaveLength(1);
    expect(events.filter((e) => e.action === "archived"), "exactly one archived event").toHaveLength(1);
    expect(events.filter((e) => e.action === "updated"), "no generic updated event for a lifecycle transition").toHaveLength(0);
    const archivedEvent = events.find((e) => e.action === "archived")!;
    expect(archivedEvent.origin, "lifecycle RPC still attributes the authenticated admin").toBe("user");
    expect(archivedEvent.actor_advisor_id).toBe(admin.advisorId);
    expect(archivedEvent.changes, "archive diff exposes the archived_at transition").toEqual({
      archived_at: { old: null, new: expect.any(String) },
    });
    expect(archivedEvent.new_values).toMatchObject({ archived_at: expect.any(String) });

    // Idempotent re-application: applied=false means no row write, no event.
    const idempotent = await lifecycleRpc(
      admin.client,
      "student",
      "archive",
      studentId,
      "contract lifecycle archive"
    );
    expect(idempotent.error).toBeNull();
    expect(idempotent.data).toMatchObject([{ applied: false }]);
    events = await readAudit("student", studentId);
    expect(events.filter((e) => e.action === "archived"), "idempotent archive adds no event").toHaveLength(1);

    // Restore: one canonical restored event.
    const restored = await lifecycleRpc(
      admin.client,
      "student",
      "restore",
      studentId,
      "contract lifecycle restore"
    );
    expect(restored.error).toBeNull();
    expect(restored.data).toMatchObject([{ applied: true, action: "restore" }]);
    events = await readAudit("student", studentId);
    expect(events.filter((e) => e.action === "restored"), "exactly one restored event").toHaveLength(1);
    const restoredEvent = events.find((e) => e.action === "restored")!;
    expect(restoredEvent.changes).toEqual({ archived_at: { old: expect.any(String), new: null } });
    expect(events.filter((e) => e.action === "updated"), "no generic updated event from the restore").toHaveLength(0);
  });

  it("emits exactly one archived and one restored event for a fellowship via the lifecycle RPC", async () => {
    const fellowshipId = await seedFellowship("lifecycle-fellowship");
    const archived = await lifecycleRpc(
      admin.client,
      "fellowship",
      "archive",
      fellowshipId,
      "contract lifecycle archive"
    );
    expect(archived.error).toBeNull();
    expect(archived.data).toMatchObject([{ applied: true, action: "archive" }]);

    let events = await readAudit("fellowship", fellowshipId);
    expect(events.filter((e) => e.action === "archived"), "exactly one fellowship archived event").toHaveLength(1);
    expect(events.filter((e) => e.action === "updated"), "no generic updated event").toHaveLength(0);

    const restored = await lifecycleRpc(
      admin.client,
      "fellowship",
      "restore",
      fellowshipId,
      "contract lifecycle restore"
    );
    expect(restored.error).toBeNull();
    expect(restored.data).toMatchObject([{ applied: true, action: "restore" }]);
    events = await readAudit("fellowship", fellowshipId);
    expect(events.filter((e) => e.action === "restored"), "exactly one fellowship restored event").toHaveLength(1);
    expect(events.filter((e) => e.action === "updated"), "no generic updated event from the restore").toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Actor ID + name snapshot after rename
// ---------------------------------------------------------------------------

describe("audit actor id and name snapshot retention after rename (R5)", () => {
  it("keeps the original advisor name on prior events and records the new name on later events", async () => {
    const actor = await createBoundActor("rename-actor");
    const originalName = actor.advisorName;
    const renamedName = `${originalName} (Renamed)`;

    const { data, error } = await actor.client
      .from("student")
      .insert({
        full_name: syntheticName(nextUnique("rename-student")),
        email: syntheticEmail(nextUnique("rename-student")),
        us_citizen: true,
      })
      .select("student_id")
      .single();
    expect(error).toBeNull();
    const studentId = data!.student_id as number;

    const firstWrite = await updateStudentViaWriter(actor, studentId, { p_gpa: 3.5 });
    expect(firstWrite.error, "first student write through the protected writer").toBeNull();

    // A later advisor display-name change must not rewrite prior events.
    const { error: renameError } = await service
      .from("advisor")
      .update({ advisor_name: renamedName })
      .eq("advisor_id", actor.advisorId)
      .select("advisor_id");
    expect(renameError).toBeNull();

    const secondWrite = await updateStudentViaWriter(actor, studentId, { p_major: "Biochemistry" });
    expect(secondWrite.error, "second student write through the protected writer").toBeNull();

    const events = await readAudit("student", studentId);
    const updates = events.filter((e) => e.action === "updated");
    expect(updates, "two updated events").toHaveLength(2);
    // Every event retains the actor id regardless of name changes.
    for (const event of updates) {
      expect(event.actor_advisor_id).toBe(actor.advisorId);
      expect(event.origin).toBe("user");
    }
    expect(updates[0].actor_name_snapshot, "prior event keeps the original name").toBe(originalName);
    expect(updates[1].actor_name_snapshot, "later event records the current name").toBe(renamedName);
  });
});

// ---------------------------------------------------------------------------
// Snapshot / changes whitelist exclusions
// ---------------------------------------------------------------------------

describe("audit snapshot and changes whitelist exclusions (R6)", () => {
  it("exposes only the whitelisted application fields and never the technical/binding keys", async () => {
    const { applicationId, studentId, fellowshipId } = await seedApplication("whitelist-app");
    const whitelistWrite = await updateApplicationViaWriter(staff, applicationId, {
      p_destination_country: "Ukraine",
      p_stage_of_application: "Under Review",
    });
    expect(whitelistWrite.error, "application update through the protected writer").toBeNull();

    const events = await readAudit("application", applicationId);
    for (const event of events) {
      expect(Object.keys(event.new_values ?? {}).sort(), "application whitelist exactly").toEqual(
        APPLICATION_KEYS
      );
      // PK and relational ids ARE context (whitelisted), but the application PK
      // and any future/technical column never enter the snapshot.
      expect(event.new_values).not.toHaveProperty("application_id");
    }
    // The diff is bounded to the whitelist only.
    const update = events.find((e) => e.action === "updated");
    expect(update?.changes).toEqual({
      destination_country: { old: "Testland", new: "Ukraine" },
      stage_of_application: { old: "Submitted", new: "Under Review" },
    });
    // Subject context remains available even though the snapshot does not carry
    // them as event columns.
    expect(update?.subject_student_id).toBe(studentId);
    expect(update?.subject_application_id).toBe(applicationId);
    expect(update?.subject_fellowship_id).toBe(fellowshipId);
  });
});

// ---------------------------------------------------------------------------
// RLS / immutability boundary (R2)
// ---------------------------------------------------------------------------

describe("audit RLS and immutability boundary (R2)", () => {
  it("denies anon reads of audit_event", async () => {
    const { data, error } = await anon.from("audit_event").select("audit_id");
    expect(data, "anon audit read must return no rows").toBeNull();
    expect(error, "anon audit read must be denied").not.toBeNull();
    expect(error?.code, "anon audit read denial code").toBe("42501");
  });

  it("lets active advisors and effective Admin read audit_event", async () => {
    const read = [staff.client, admin.client];
    for (const client of read) {
      const { data, error } = await client.from("audit_event").select("audit_id").limit(1);
      expect(error, "active advisor audit read").toBeNull();
      expect(data ?? [], "an active advisor can see audit rows").not.toHaveLength(0);
    }
  });

  it("hides audit history from an authenticated user with NO advisor binding (RLS-filtered to zero rows)", async () => {
    const { data, error } = await noAdvisor.client.from("audit_event").select("audit_id");
    expect(error, "a no-advisor audit read is RLS-filtered, not an error").toBeNull();
    expect(data ?? [], "zero audit rows are visible to a session without an active advisor").toHaveLength(0);
  });

  it("hides audit history from an authenticated user bound to an INACTIVE advisor (RLS-filtered to zero rows)", async () => {
    const { data, error } = await inactiveBound.client.from("audit_event").select("audit_id");
    expect(error, "an inactive-bound audit read is RLS-filtered, not an error").toBeNull();
    expect(data ?? [], "zero audit rows are visible to an inactive advisor").toHaveLength(0);
  });

  it("denies authenticated INSERT/UPDATE/DELETE on audit_event for an active advisor", async () => {
    const { rows } = await pool.query<{ audit_id: number }>(
      "SELECT audit_id FROM public.audit_event ORDER BY audit_id LIMIT 1"
    );
    expect(rows.length, "the suite has produced at least one audit row").toBeGreaterThan(0);
    const targetId = rows[0].audit_id;

    const forged = {
      entity_type: "student",
      entity_id: 1,
      action: "created",
      actor_name_snapshot: "Forged",
      origin: "user",
    };
    const insertResult = await staff.client.from("audit_event").insert(forged);
    expect(insertResult.error, "authenticated audit INSERT must be denied").not.toBeNull();
    expect(insertResult.error?.code, "authenticated audit INSERT denial code").toBe("42501");

    const updateResult = await staff.client
      .from("audit_event")
      .update({ reason: "tampered" })
      .eq("audit_id", targetId);
    expect(updateResult.error, "authenticated audit UPDATE must be denied").not.toBeNull();
    expect(updateResult.error?.code, "authenticated audit UPDATE denial code").toBe("42501");

    const deleteResult = await staff.client.from("audit_event").delete().eq("audit_id", targetId);
    expect(deleteResult.error, "authenticated audit DELETE must be denied").not.toBeNull();
    expect(deleteResult.error?.code, "authenticated audit DELETE denial code").toBe("42501");

    // The oracle proves the row was not modified or removed.
    const { rows: after } = await pool.query(
      "SELECT count(*)::int AS n, max(reason)::text AS reason FROM public.audit_event WHERE audit_id = $1",
      [targetId]
    );
    expect(after[0].n).toBe(1);
    expect(after[0].reason).toBeNull();
  });

  it("denies effective-Admin (claim) direct audit_table writes as well", async () => {
    const forged = {
      entity_type: "student",
      entity_id: 1,
      action: "created",
      actor_name_snapshot: "Admin Forged",
      origin: "user",
    };
    const insertResult = await admin.client.from("audit_event").insert(forged);
    expect(insertResult.error, "Admin audit INSERT must be denied").not.toBeNull();
    expect(insertResult.error?.code, "Admin audit INSERT denial code").toBe("42501");
  });

  it("denies effective-Admin direct UPDATE and DELETE on audit_event as well", async () => {
    const { rows } = await pool.query<{ audit_id: number }>(
      "SELECT audit_id FROM public.audit_event ORDER BY audit_id LIMIT 1"
    );
    expect(rows.length, "the suite has produced at least one audit row").toBeGreaterThan(0);
    const targetId = rows[0].audit_id;

    const updateResult = await admin.client
      .from("audit_event")
      .update({ reason: "admin tampered" })
      .eq("audit_id", targetId);
    expect(updateResult.error, "Admin audit UPDATE must be denied").not.toBeNull();
    expect(updateResult.error?.code, "Admin audit UPDATE denial code").toBe("42501");

    const deleteResult = await admin.client.from("audit_event").delete().eq("audit_id", targetId);
    expect(deleteResult.error, "Admin audit DELETE must be denied").not.toBeNull();
    expect(deleteResult.error?.code, "Admin audit DELETE denial code").toBe("42501");

    // Oracle: the row is unchanged and present.
    const { rows: after } = await pool.query(
      "SELECT count(*)::int AS n, max(reason)::text AS reason FROM public.audit_event WHERE audit_id = $1",
      [targetId]
    );
    expect(after[0].n).toBe(1);
    expect(after[0].reason).toBeNull();
  });

  it("denies a REAL authenticated TRUNCATE of audit history and preserves every row (R3)", async () => {
    // A catalog grant check is necessary but not sufficient release evidence:
    // execute the attempt as the exact `authenticated` request role.
    const { rows: before } = await pool.query<{ n: number; min_id: number | null }>(
      "SELECT count(*)::int AS n, min(audit_id) AS min_id FROM public.audit_event"
    );
    expect(before[0].n, "the suite has produced audit history to protect").toBeGreaterThan(0);

    const code = await authenticatedTruncateCode("audit_event");
    expect(code, "authenticated TRUNCATE of audit_event must be denied with 42501").toBe("42501");

    // The rolled-back attempt removed nothing: history only grew (or held).
    const { rows: after } = await pool.query<{ n: number; distinct_min: number | null }>(
      "SELECT count(*)::int AS n, min(audit_id) AS distinct_min FROM public.audit_event"
    );
    expect(after[0].n, "no audit row was removed by the denied TRUNCATE").toBeGreaterThanOrEqual(
      before[0].n
    );
    expect(after[0].distinct_min, "the first audit row still exists").toBe(before[0].min_id);
  });
});

// ---------------------------------------------------------------------------
// Atomic rollback
// ---------------------------------------------------------------------------

describe("audit writes are transaction-atomic with the source mutation (R3)", () => {
  it("rolls back the source UPDATE when the audit write fails (unresolved authenticated actor)", async () => {
    const studentId = await seedStudent("rollback-student", { gpa: 3.2 });

    const client = await pool.connect();
    try {
      // Simulate an authenticated session whose auth.uid() resolves to NO
      // active bound advisor: the audit helper must fail closed...
      await client.query("SELECT set_config('request.jwt.claim.sub', $1::text, false)", [
        randomUUID(),
      ]);
      await expect(
        client.query("UPDATE public.student SET gpa = 4.0 WHERE student_id = $1", [studentId])
      ).rejects.toMatchObject({ code: "42501" });

      // ...and the source mutation must not have committed.
      const { rows } = await client.query(
        "SELECT gpa::float8 AS gpa FROM public.student WHERE student_id = $1",
        [studentId]
      );
      expect(rows[0].gpa).toBe(3.2);
    } finally {
      await client.query("RESET request.jwt.claim.sub");
      client.release();
    }

    // No updated event was ever written for the failed mutation.
    const events = await readAudit("student", studentId);
    expect(events.filter((e) => e.action === "updated"), "failed mutation records nothing").toHaveLength(0);
  });

  it("rolls back the application row, version, timestamp, and event when the audit write fails (R5)", async () => {
    const { applicationId, studentId, fellowshipId } = await seedApplication("atomic-app", {
      stage_of_application: "Submitted",
      destination_country: "Testland",
    });
    const before = await readVersionTimestamp("application", "application_id", applicationId);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Transaction-local forced audit failure: the BEFORE INSERT trigger and
      // the row/version writes it aborts are all confined to this transaction.
      await client.query(
        `CREATE OR REPLACE FUNCTION public._test_audit_application_fail()
           RETURNS trigger LANGUAGE plpgsql AS $fn$
           BEGIN
             RAISE EXCEPTION 'forced audit failure' USING ERRCODE = 'P0001';
           END;
         $fn$`
      );
      await client.query(
        `CREATE TRIGGER _test_audit_application_fail
           BEFORE INSERT ON public.audit_event
           FOR EACH ROW EXECUTE FUNCTION public._test_audit_application_fail()`
      );
      await client.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [staff.userId]);
      await client.query("SELECT set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ email: staff.email }),
      ]);

      await expect(
        directUpdateApplicationViaSql(client, applicationId, before.row_version, {
          student_id: studentId,
          fellowship_id: fellowshipId,
          application_year: null,
          destination_country: "Ukraine",
          stage_of_application: "Under Review",
          is_semi_finalist: false,
          is_finalist: false,
        })
      ).rejects.toMatchObject({ code: "P0001" });
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }

    // The business row, its version, and its timestamp are all untouched.
    const after = await readVersionTimestamp("application", "application_id", applicationId);
    expect(after.row_version, "application version rolled back").toBe(before.row_version);
    expect(after.updated_at_epoch, "application timestamp rolled back").toBe(before.updated_at_epoch);
    const { rows } = await pool.query<{ stage_of_application: string; destination_country: string | null }>(
      "SELECT stage_of_application, destination_country FROM public.application WHERE application_id = $1",
      [applicationId]
    );
    expect(rows[0].stage_of_application, "application stage rolled back").toBe("Submitted");
    expect(rows[0].destination_country, "application destination rolled back").toBe("Testland");

    // Neither an updated event nor a created event was committed by the failed write.
    const events = await readAudit("application", applicationId);
    expect(events.filter((e) => e.action === "updated"), "failed application write records nothing").toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// R4: database-authored event timestamps across the mutation matrix
// ---------------------------------------------------------------------------

describe("audit event timestamps are database-authored across the mutation matrix (R4)", () => {
  interface TimestampCase {
    label: string;
    entityType: "student" | "fellowship" | "application";
    action: string;
    /** Performs the mutation and returns the audited entity id. */
    run: () => Promise<number>;
    /** Current-state table whose `updated_at` shares the write transaction. */
    rowTable: "student" | "fellowship" | "application";
    rowIdColumn: string;
  }

  const cases: TimestampCase[] = [
    {
      label: "student/created",
      entityType: "student",
      action: "created",
      run: () => seedStudent("ts-student-created", { gpa: 3.1 }),
      rowTable: "student",
      rowIdColumn: "student_id",
    },
    {
      label: "student/updated",
      entityType: "student",
      action: "updated",
      run: async () => {
        const id = await seedStudent("ts-student-updated", { gpa: 3.1 });
        const result = await updateStudentViaWriter(staff, id, { p_gpa: 3.85 });
        expect(result.error, "student timestamp write").toBeNull();
        return id;
      },
      rowTable: "student",
      rowIdColumn: "student_id",
    },
    {
      label: "student/archived",
      entityType: "student",
      action: "archived",
      run: async () => {
        const id = await seedStudent("ts-student-archived");
        const result = await lifecycleRpc(admin.client, "student", "archive", id, "timestamp matrix archive");
        expect(result.error, "student archive for timestamp matrix").toBeNull();
        return id;
      },
      rowTable: "student",
      rowIdColumn: "student_id",
    },
    {
      label: "student/restored",
      entityType: "student",
      action: "restored",
      run: async () => {
        const id = await seedStudent("ts-student-restored");
        const archived = await lifecycleRpc(admin.client, "student", "archive", id, "timestamp matrix pre-archive");
        expect(archived.error, "student pre-archive for timestamp matrix").toBeNull();
        const restored = await lifecycleRpc(admin.client, "student", "restore", id, "timestamp matrix restore");
        expect(restored.error, "student restore for timestamp matrix").toBeNull();
        return id;
      },
      rowTable: "student",
      rowIdColumn: "student_id",
    },
    {
      label: "fellowship/created",
      entityType: "fellowship",
      action: "created",
      run: () => seedFellowship("ts-fellowship-created"),
      rowTable: "fellowship",
      rowIdColumn: "fellowship_id",
    },
    {
      label: "fellowship/updated",
      entityType: "fellowship",
      action: "updated",
      run: async () => {
        const id = await seedFellowship("ts-fellowship-updated");
        const result = await updateFellowshipViaWriter(
          staff,
          id,
          syntheticName(nextUnique("ts-fellowship-renamed"))
        );
        expect(result.error, "fellowship timestamp write").toBeNull();
        return id;
      },
      rowTable: "fellowship",
      rowIdColumn: "fellowship_id",
    },
    {
      label: "fellowship/archived",
      entityType: "fellowship",
      action: "archived",
      run: async () => {
        const id = await seedFellowship("ts-fellowship-archived");
        const result = await lifecycleRpc(admin.client, "fellowship", "archive", id, "timestamp matrix archive");
        expect(result.error, "fellowship archive for timestamp matrix").toBeNull();
        return id;
      },
      rowTable: "fellowship",
      rowIdColumn: "fellowship_id",
    },
    {
      label: "fellowship/restored",
      entityType: "fellowship",
      action: "restored",
      run: async () => {
        const id = await seedFellowship("ts-fellowship-restored");
        const archived = await lifecycleRpc(admin.client, "fellowship", "archive", id, "timestamp matrix pre-archive");
        expect(archived.error, "fellowship pre-archive for timestamp matrix").toBeNull();
        const restored = await lifecycleRpc(admin.client, "fellowship", "restore", id, "timestamp matrix restore");
        expect(restored.error, "fellowship restore for timestamp matrix").toBeNull();
        return id;
      },
      rowTable: "fellowship",
      rowIdColumn: "fellowship_id",
    },
    {
      label: "application/created",
      entityType: "application",
      action: "created",
      run: async () => (await seedApplication("ts-application-created")).applicationId,
      rowTable: "application",
      rowIdColumn: "application_id",
    },
    {
      label: "application/updated",
      entityType: "application",
      action: "updated",
      run: async () => {
        const { applicationId } = await seedApplication("ts-application-updated");
        const result = await updateApplicationViaWriter(staff, applicationId, {
          p_destination_country: "Ukraine",
          p_stage_of_application: "Under Review",
        });
        expect(result.error, "application timestamp write").toBeNull();
        return applicationId;
      },
      rowTable: "application",
      rowIdColumn: "application_id",
    },
  ];

  for (const testCase of cases) {
    it(`stamps ${testCase.label} with the database transaction time and exactly one event`, async () => {
      const beforeMs = await dbNowMs();
      const entityId = await testCase.run();
      const afterMs = await dbNowMs();

      const events = await readAudit(testCase.entityType, entityId);
      const matching = events.filter((e) => e.action === testCase.action);
      expect(matching, `exactly one ${testCase.action} event`).toHaveLength(1);
      const occurredAtMs = expectDbAuthoredTimestamp(
        matching[0].occurred_at,
        beforeMs,
        afterMs,
        testCase.label
      );

      // The event and the business row share ONE database transaction clock
      // (both default/stamp `now()`), proving the timestamp is database-authored
      // and the audit write is atomic with the row write.
      const { rows } = await pool.query<{ same: boolean; seconds: number }>(
        `SELECT extract(epoch from a.occurred_at) = extract(epoch from r.updated_at) AS same,
                extract(epoch from a.occurred_at)::double precision AS seconds
           FROM public.audit_event a
           JOIN public.${testCase.rowTable} r ON r.${testCase.rowIdColumn} = a.entity_id
          WHERE a.audit_id = $1`,
        [matching[0].audit_id]
      );
      expect(rows[0].same, `${testCase.label}: event and row share one transaction timestamp`).toBe(true);
      expect(
        Math.abs(Number(rows[0].seconds) * 1000 - occurredAtMs),
        `${testCase.label}: the bracketed timestamp is the shared transaction timestamp`
      ).toBeLessThanOrEqual(1);
    });
  }
});

// ---------------------------------------------------------------------------
// R9: trusted, transaction-local baseline import and no fabricated history
// ---------------------------------------------------------------------------

describe("baseline_captured semantics: trusted and never fabricated (R9)", () => {
  it("reserves baseline vocabulary for the transaction-local trusted import path", async () => {
    const { rows: defs } = await pool.query<{ conname: string; def: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE conrelid = 'public.audit_event'::regclass AND contype = 'c'`
    );
    const actionDef = String(defs.find((r) => r.conname === "audit_event_action_check")?.def ?? "");
    const originDef = String(defs.find((r) => r.conname === "audit_event_origin_check")?.def ?? "");
    expect(actionDef, "action vocabulary reserves baseline_captured").toContain("'baseline_captured'");
    expect(originDef, "origin vocabulary reserves migration").toContain("'migration'");

    const { rows: fns } = await pool.query<{ nspname: string; proname: string; prosrc: string }>(
      `SELECT n.nspname, p.proname, p.prosrc
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname IN ('public', 'private') AND p.proname LIKE '%audit%'`
    );
    const normalizer = fns.find(
      (fn) => fn.nspname === "private" && fn.proname === "normalize_baseline_audit_event"
    );
    expect(normalizer?.prosrc, "baseline normalizer exists").toContain("baseline_captured");
    expect(normalizer?.prosrc, "baseline normalizer fixes the trusted origin").toContain("'migration'");
    expect(normalizer?.prosrc, "baseline normalizer requires transaction-local context").toContain(
      "ocf.legacy_baseline_import"
    );
  });

  it("denies a client impersonation attempt and writes no forged baseline row", async () => {
    // The immutable-history suite now INTENTIONALLY exercises the trusted,
    // transaction-local baseline import (creating real
    // `baseline_captured`/`migration` events), so the former GLOBAL
    // "no baseline event exists" table total is cross-suite-polluted and is no
    // longer a valid oracle. The anti-forgery proof is scoped to a unique
    // marker this suite controls: the denied impersonation must leave no row
    // carrying that marker. (The baseline vocabulary itself is proven reserved
    // for the trusted path above and in the upgrade-path suite.)
    const marker = syntheticName(nextUnique("forged-baseline"));
    const forgedCount = async (): Promise<number> => {
      const { rows } = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM public.audit_event
          WHERE action = 'baseline_captured' AND origin = 'migration' AND actor_name_snapshot = $1`,
        [marker]
      );
      return rows[0].n;
    };
    expect(await forgedCount(), "no forged baseline row exists before the attempt").toBe(0);

    // A client cannot fabricate a baseline row: the CHECK vocabulary exists but
    // there is no product-role writer path.
    const forged = await staff.client.from("audit_event").insert({
      entity_type: "student",
      entity_id: 1,
      action: "baseline_captured",
      actor_name_snapshot: marker,
      origin: "migration",
    });
    expect(forged.error, "authenticated baseline impersonation must be denied").not.toBeNull();
    expect(forged.error?.code).toBe("42501");
    expect(await forgedCount(), "the denied impersonation wrote nothing").toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Schema / ACL / RLS / helper hardening / indexes
// ---------------------------------------------------------------------------

describe("audit schema, ACL, RLS, and helper hardening (migration 20261012000001)", () => {
  it("creates audit_event with the exact columns, types, nullability, and PK", async () => {
    const { rows } = await pool.query(
      `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'audit_event'
        ORDER BY ordinal_position`
    );
    expect(rows).toEqual([
      { column_name: "audit_id", data_type: "bigint", is_nullable: "NO", column_default: expect.stringMatching(/^nextval/) },
      { column_name: "entity_type", data_type: "text", is_nullable: "NO", column_default: null },
      { column_name: "entity_id", data_type: "integer", is_nullable: "NO", column_default: null },
      { column_name: "action", data_type: "text", is_nullable: "NO", column_default: null },
      { column_name: "actor_advisor_id", data_type: "integer", is_nullable: "YES", column_default: null },
      { column_name: "actor_name_snapshot", data_type: "text", is_nullable: "NO", column_default: null },
      { column_name: "occurred_at", data_type: "timestamp with time zone", is_nullable: "NO", column_default: "now()" },
      { column_name: "old_values", data_type: "jsonb", is_nullable: "YES", column_default: null },
      { column_name: "new_values", data_type: "jsonb", is_nullable: "YES", column_default: null },
      { column_name: "changes", data_type: "jsonb", is_nullable: "YES", column_default: null },
      { column_name: "reason", data_type: "text", is_nullable: "YES", column_default: null },
      { column_name: "subject_student_id", data_type: "integer", is_nullable: "YES", column_default: null },
      { column_name: "subject_application_id", data_type: "integer", is_nullable: "YES", column_default: null },
      { column_name: "subject_fellowship_id", data_type: "integer", is_nullable: "YES", column_default: null },
      { column_name: "origin", data_type: "text", is_nullable: "NO", column_default: null },
    ]);

    const pk = await pool.query(
      `SELECT a.attname
         FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
        WHERE i.indrelid = 'public.audit_event'::regclass AND i.indisprimary`
    );
    expect(pk.rows.map((r) => r.attname)).toEqual(["audit_id"]);
  });

  it("defines exactly the three vocabulary CHECK constraints and no foreign keys", async () => {
    const checks = await pool.query(
      `SELECT conname
         FROM pg_constraint
        WHERE conrelid = 'public.audit_event'::regclass AND contype = 'c'
        ORDER BY conname`
    );
    expect(checks.rows.map((r) => r.conname)).toEqual([
      "audit_event_action_check",
      "audit_event_entity_type_check",
      "audit_event_origin_check",
    ]);

    const origin = await pool.query(
      `SELECT pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE conrelid = 'public.audit_event'::regclass AND conname = 'audit_event_origin_check'`
    );
    expect(String(origin.rows[0].def)).toContain("'user'");
    expect(String(origin.rows[0].def)).toContain("'system'");
    expect(String(origin.rows[0].def)).toContain("'migration'");

    const fks = await pool.query(
      `SELECT count(*)::int AS n
         FROM pg_constraint
        WHERE conrelid = 'public.audit_event'::regclass AND contype = 'f'`
    );
    expect(fks.rows[0].n, "immutable context has no foreign keys").toBe(0);
  });

  it("creates the six btree chronology indexes and no JSONB GIN index", async () => {
    const indexes = await pool.query(
      `SELECT indexname, indexdef
         FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'audit_event'
        ORDER BY indexname`
    );
    const byName = new Map(indexes.rows.map((r) => [r.indexname as string, String(r.indexdef)]));

    for (const name of [
      "idx_audit_event_entity_chronology",
      "idx_audit_event_actor_chronology",
      "idx_audit_event_subject_student_chronology",
      "idx_audit_event_subject_application_chronology",
      "idx_audit_event_subject_fellowship_chronology",
      "idx_audit_event_occurred_at_chronology",
    ]) {
      const def = byName.get(name);
      expect(def, `index ${name} exists`).toBeDefined();
      expect(def, `index ${name} is btree`).toContain("USING btree");
    }

    const gin = await pool.query(
      `SELECT count(*)::int AS n
         FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'audit_event'
          AND indexdef ILIKE '%using gin%'`
    );
    expect(gin.rows[0].n, "no JSONB GIN index by design").toBe(0);
  });

  it("enables RLS with exactly one active-advisor SELECT policy", async () => {
    const rls = await pool.query(
      `SELECT relrowsecurity FROM pg_class WHERE oid = 'public.audit_event'::regclass`
    );
    expect(rls.rows[0].relrowsecurity, "RLS enabled").toBe(true);

    const policies = await pool.query(
      `SELECT policyname, cmd, roles::text[] AS roles, qual::text AS qual
         FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'audit_event'
        ORDER BY policyname`
    );
    expect(policies.rows).toHaveLength(1);
    expect(policies.rows[0]).toMatchObject({
      policyname: "audit_event_select_active_advisor",
      cmd: "SELECT",
      roles: ["authenticated"],
    });
    expect(String(policies.rows[0].qual)).toContain("is_active_advisor");
  });

  it("grants authenticated SELECT only and denies INSERT/UPDATE/DELETE/TRUNCATE, sequence usage, and all anon access", async () => {
    const { rows } = await pool.query(
      `SELECT
         has_table_privilege('authenticated', 'public.audit_event', 'SELECT')  AS auth_select,
         has_table_privilege('authenticated', 'public.audit_event', 'INSERT')  AS auth_insert,
         has_table_privilege('authenticated', 'public.audit_event', 'UPDATE')  AS auth_update,
         has_table_privilege('authenticated', 'public.audit_event', 'DELETE')  AS auth_delete,
         has_table_privilege('authenticated', 'public.audit_event', 'TRUNCATE') AS auth_truncate,
         has_sequence_privilege('authenticated', 'public.audit_event_audit_id_seq', 'USAGE') AS auth_seq_usage,
         has_sequence_privilege('authenticated', 'public.audit_event_audit_id_seq', 'SELECT') AS auth_seq_select,
         has_table_privilege('anon', 'public.audit_event', 'SELECT') AS anon_select,
         has_table_privilege('anon', 'public.audit_event', 'INSERT') AS anon_insert
      `
    );
    expect(rows[0].auth_select, "authenticated SELECT on audit_event").toBe(true);
    for (const denied of ["auth_insert", "auth_update", "auth_delete", "auth_truncate"] as const) {
      expect(rows[0][denied], `authenticated ${denied} must be false`).toBe(false);
    }
    expect(rows[0].auth_seq_usage, "authenticated sequence USAGE must be false").toBe(false);
    expect(rows[0].auth_seq_select, "authenticated sequence SELECT must be false").toBe(false);
    expect(rows[0].anon_select, "anon SELECT must be false").toBe(false);
    expect(rows[0].anon_insert, "anon INSERT must be false").toBe(false);
  });

  it("hardens the private helper: SECURITY DEFINER, empty search_path, no client USAGE/EXECUTE", async () => {
    const fn = await pool.query(
      `SELECT p.prosecdef, p.proconfig,
              has_schema_privilege('authenticated', 'private', 'USAGE') AS auth_schema_usage,
              has_schema_privilege('anon', 'private', 'USAGE') AS anon_schema_usage,
              has_function_privilege('authenticated', 'private.audit_current_state_change()', 'EXECUTE') AS auth_exec,
              has_function_privilege('anon', 'private.audit_current_state_change()', 'EXECUTE') AS anon_exec
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'private' AND p.proname = 'audit_current_state_change'`
    );
    expect(fn.rows).toHaveLength(1);
    expect(fn.rows[0].prosecdef, "helper must be SECURITY DEFINER").toBe(true);
    expect(fn.rows[0].proconfig, "helper must set an empty search_path").toEqual(["search_path=\"\""]);
    expect(fn.rows[0].auth_schema_usage, "no authenticated USAGE on private").toBe(false);
    expect(fn.rows[0].anon_schema_usage, "no anon USAGE on private").toBe(false);
    expect(fn.rows[0].auth_exec, "no authenticated EXECUTE on the helper").toBe(false);
    expect(fn.rows[0].anon_exec, "no anon EXECUTE on the helper").toBe(false);
  });

  it("attaches AFTER INSERT OR UPDATE ROW triggers to the four current-state tables", async () => {
    const triggers = await pool.query(
      `SELECT c.relname AS table_name, t.tgname, t.tgtype
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname = ANY(ARRAY['student', 'fellowship', 'application', 'advisor'])
          AND t.tgname LIKE 'trg_audit_%'
          AND NOT t.tgisinternal
        ORDER BY c.relname`
    );
    // student/fellowship/application from migration 20261012000001 and the
    // advisor-only helper (migration 20261013000001) all use the same AFTER
    // ROW INSERT OR UPDATE shape. (Migration 20261015000002 adds separate
    // INSERT-only `trg_audit_*_created` triggers on the historical base/
    // amendment tables, proven in historical-audit-activity.test.ts.)
    expect(triggers.rows.map((r) => r.table_name)).toEqual([
      "advisor",
      "application",
      "fellowship",
      "student",
    ]);
    for (const row of triggers.rows) {
      // tgtype: 1 (ROW) + 4 (INSERT) + 16 (UPDATE) = 21 for AFTER ROW INSERT OR UPDATE.
      expect(row.tgtype, `${row.tgname} must be AFTER ROW INSERT OR UPDATE`).toBe(21);
    }
  });
});

// ---------------------------------------------------------------------------
// Legacy / current behavior intact
// ---------------------------------------------------------------------------

describe("legacy behavior remains intact with the audit layer present", () => {
  it("keeps ordinary active-advisor source writes and reads working", async () => {
    const { data, error } = await staff.client.from("student").select("student_id").limit(1);
    expect(error, "active advisor source read").toBeNull();
    expect((data ?? []).length, "staff can still read the student roster").toBeGreaterThan(0);

    const { data: name, error: insertError } = await staff.client
      .from("fellowship")
      .insert({ fellowship_name: syntheticName(nextUnique("legacy-fellowship")) })
      .select("fellowship_id")
      .single();
    expect(insertError, "staff can still create a fellowship").toBeNull();
    expect(name!.fellowship_id).toBeTypeOf("number");
  });

  it("keeps the lifecycle RPC working and records no duplicate event", async () => {
    const studentId = await seedStudent("legacy-lifecycle");
    const archived = await lifecycleRpc(
      admin.client,
      "student",
      "archive",
      studentId,
      "contract lifecycle archive"
    );
    expect(archived.error, "lifecycle RPC still works").toBeNull();
    expect(archived.data).toMatchObject([{ entity: "student", action: "archive", applied: true }]);

    const events = await readAudit("student", studentId);
    expect(events.filter((e) => e.action === "archived")).toHaveLength(1);
    expect(events.filter((e) => e.action === "updated")).toHaveLength(0);
  });

  it("keeps the direct lifecycle-field guard rejecting forged writes without creating an audit event", async () => {
    const studentId = await seedStudent("legacy-forged");
    const { data, error } = await staff.client
      .from("student")
      .update({ archived_at: "2026-01-01T00:00:00.000Z" })
      .eq("student_id", studentId)
      .select("student_id");
    expect(error, "direct archived_at write must still be denied").not.toBeNull();
    expect(error?.code, "direct archived_at denial code").toBe("42501");
    expect(data ?? [], "denied update returns no row").toHaveLength(0);

    const events = await readAudit("student", studentId);
    expect(events.filter((e) => e.action === "archived"), "denied write records no archived event").toHaveLength(0);
    expect(events.filter((e) => e.action === "updated"), "denied write records no updated event").toHaveLength(0);
  });
});
