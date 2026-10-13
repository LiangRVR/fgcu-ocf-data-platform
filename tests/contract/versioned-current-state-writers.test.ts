/**
 * tests/contract/versioned-current-state-writers.test.ts
 *
 * Database contract coverage for migration
 * 20261015000001_protected_current_state_writers (historical-audit-timeline
 * Plan Work 1): database-enforced optimistic concurrency for the four mutable
 * current-state entities.
 *
 * Proves, against the fresh isolated Docker-local contract lane:
 *
 *   - R1  VERSION/TIMESTAMP METADATA: student/fellowship/application/advisor
 *        all expose NON-NULL `row_version integer NOT NULL DEFAULT 1` and
 *        `updated_at timestamptz NOT NULL DEFAULT now()`; fresh rows (trusted
 *        provisioning and service seeding) start at version 1 with a
 *        non-null database-authored timestamp.
 *   - R2  EXACTLY ONE INCREMENT: a meaningful business/lifecycle UPDATE bumps
 *        `row_version` by exactly one and the trigger stamps `updated_at`
 *        (proving even a manual clobber of either technical column is
 *        overwritten on a semantic change). A multi-field semantic change
 *        still increments once — never once per column. A no-op restatement
 *        or a technical-only write (e.g. `last_login_at`) preserves BOTH the
 *        version and the timestamp, and a manual clobber with no semantic
 *        change is restored to the preserved values.
 *   - R3  STALE EXPECTED-VERSION REJECTION: every expected-version writer
 *        (`update_student_profile`, `update_fellowship`, `update_application`,
 *        `update_my_advisor_profile`, `update_advisor_profile_name`,
 *        `set_advisor_role`, `lifecycle_transition`) rejects a stale
 *        `p_expected_version` with SQLSTATE PT409 and performs NO business
 *        mutation, NO version increment, NO timestamp update, and NO audit
 *        event — tested with two independently authenticated editor sessions
 *        for the primary roster writer AND through the admin lifecycle/role
 *        and self-service/peer profile writers. Malformed (NULL) expected
 *        versions fail closed with 22023.
 *   - R6  TECHNICAL FIELDS ARE NEVER AUDITED: audit snippets/diffs for the
 *        four entities contain exactly the documented business allowlists and
 *        never `row_version`, `updated_at`, `created_at`, `auth_user_id`,
 *        `last_login_at`, or any PK/technical column; a version bump never
 *        produces a second/duplicate audit event.
 *   - R3  REVOKED DIRECT AUTHENTICATED UPDATE: `authenticated` holds no
 *        UPDATE table privilege on the four current-state tables (the four
 *        direct UPDATE policies are dropped), and an authenticated client
 *        UPDATE attempt on each table is denied with 42501 leaving the row,
 *        version, timestamp, and audit history untouched.
 *   - CONCURRENCY (migration 20261018000001): a barrier-controlled
 *        archive-vs-relink race proves the prospective parent lock serializes a
 *        re-link against a concurrent archive (the re-link blocks, then
 *        observes the archived parent and is rejected with 42501, never
 *        committing a link to an archived parent); and a barrier-controlled
 *        same-expected-version race on the application and student writers —
 *        the winner's writer row lock is held open in one transaction while the
 *        second attempt is proven (via pg_blocking_pids) to be waiting on that
 *        exact lock before it is released — proves the two attempts genuinely
 *        overlap and yields exactly one commit (one version bump, one audit
 *        event) and one PT409 rejection.
 *
 * Service role is used strictly for local fixture seeding, auth-user creation,
 * the admin pre-bind, and unchanged-row/persisted-state oracle re-reads (never
 * asserted as an access grant). Direct Postgres writes in the trigger-behavior
 * tests run as the lane's local superuser to exercise the BEFORE-UPDATE
 * trigger deterministically (the trigger is SECURITY INVOKER and fires for
 * every session).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, type Pool } from "pg";
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
// Fixture helpers (file-local; no shared fixture changes required)
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

interface Actor {
  userId: string;
  email: string;
  advisorName: string;
  client: SupabaseClient;
  advisorId: number;
}

async function insertAdvisor(advisorName: string, email: string, isActive = true): Promise<number> {
  // `role` is intentionally omitted: the trusted default is 'Advisor' and the
  // column-scoped role guard never fires on a trusted INSERT without a role.
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

async function createBoundActor(label: string, admin = false, isActive = true): Promise<Actor> {
  const tag = nextUnique(label);
  const email = syntheticEmail(tag);
  const advisorName = syntheticName(tag);
  const userId = await createAuthUser(
    service,
    email,
    admin ? { appMetadata: { ocf_admin: true } } : {}
  );
  const advisorId = await insertAdvisor(advisorName, email, isActive);
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

async function seedApplication(label: string): Promise<{
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
      is_semi_finalist: false,
      is_finalist: false,
      application_year: 2026,
    })
    .select("application_id")
    .single();
  if (error) throw new Error(`seed application: ${error.message}`);
  return { applicationId: data.application_id as number, studentId, fellowshipId };
}

// ---------------------------------------------------------------------------
// Persisted-state oracle reads
// ---------------------------------------------------------------------------

interface CurrentStateRow {
  row_version: number;
  /** `extract(epoch from updated_at)` — a plain number so Date-object
   * semantics cannot leak into equality/ordering assertions. */
  updated_at: number;
  [column: string]: unknown;
}

async function readRowState(table: string, idColumn: string, id: number): Promise<CurrentStateRow> {
  const { rows } = await pool.query<CurrentStateRow>(
    `SELECT row_version,
            extract(epoch from updated_at)::double precision AS updated_at
       FROM public.${table} WHERE ${idColumn} = $1`,
    [id]
  );
  if (rows.length !== 1) throw new Error(`expected one ${table} row for oracle read`);
  // `extract` always returns a numeric row; keep the typed contract honest.
  rows[0].updated_at = Number(rows[0].updated_at);
  return rows[0];
}

interface AuditRow {
  audit_id: number;
  action: string;
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
  changes: Record<string, { old: unknown; new: unknown }> | null;
  occurred_at: string;
}

async function readAudit(entityType: string, entityId: number): Promise<AuditRow[]> {
  const { rows } = await pool.query<AuditRow>(
    `SELECT audit_id, action, old_values, new_values, changes, occurred_at
       FROM public.audit_event
      WHERE entity_type = $1 AND entity_id = $2
      ORDER BY audit_id`,
    [entityType, entityId]
  );
  return rows;
}

/** Technical/private columns that must NEVER appear in any event payload. */
const TECHNICAL_KEYS = [
  "row_version",
  "updated_at",
  "created_at",
  "auth_user_id",
  "last_login_at",
];

function assertNoTechnicalKeys(
  values: Record<string, unknown> | null | undefined,
  label: string
): void {
  if (values === null || values === undefined) return;
  for (const key of TECHNICAL_KEYS) {
    expect(values, `${label} must never contain ${key}`).not.toHaveProperty(key);
  }
}

async function assertSingleSemanticAudit(
  entityType: string,
  entityId: number,
  action: string
): Promise<AuditRow> {
  const events = await readAudit(entityType, entityId);
  const semantic = events.filter((e) => e.action === action);
  expect(semantic, `exactly one ${action} event`).toHaveLength(1);
  // A version bump must never create a second/duplicate event.
  expect(events.length, `no duplicated event for the single write`).toBe(
    events.filter((e) => e.action === "created").length + 1
  );
  return semantic[0];
}

// ---------------------------------------------------------------------------
// RPC signature resolution (dynamic by semantics, exactly-one-overload)
// ---------------------------------------------------------------------------

const rpcArgsCache = new Map<string, string[]>();

async function rpcInputArgNames(fnName: string): Promise<string[]> {
  const cached = rpcArgsCache.get(fnName);
  if (cached) return cached;
  const { rows } = await pool.query<{ names: string[] | null }>(
    `SELECT p.proargnames[1:p.pronargs] AS names
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = $1 AND p.prokind = 'f'`,
    [fnName]
  );
  if (rows.length !== 1) {
    throw new Error(
      `contract requires exactly one public.${fnName} overload, found ${rows.length}`
    );
  }
  const names = (rows[0].names ?? []).filter(
    (name): name is string => typeof name === "string" && name.length > 0
  );
  rpcArgsCache.set(fnName, names);
  return names;
}

interface LifecycleSpec {
  entity: string;
  action: string;
  entityId: number;
  reason: string;
  expectedVersion: number | null;
}

function mapLifecycleArgs(names: string[], spec: LifecycleSpec): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of names) {
    const n = name.toLowerCase();
    if (n.includes("expected") || n.includes("version")) out[name] = spec.expectedVersion;
    else if (n.includes("reason")) out[name] = spec.reason;
    else if (n.includes("entity") && n.includes("id")) out[name] = spec.entityId;
    else if (n.includes("entity")) out[name] = spec.entity;
    else if (n.includes("action")) out[name] = spec.action;
    else throw new Error(`unmapped lifecycle_transition parameter "${name}"`);
  }
  return out;
}

interface SetRoleSpec {
  advisorId: number;
  role: string;
  actorAdvisorId: number;
  reason: string;
  expectedVersion: number | null;
}

function mapSetRoleArgs(names: string[], spec: SetRoleSpec): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of names) {
    const n = name.toLowerCase();
    if (n.includes("expected") || n.includes("version")) out[name] = spec.expectedVersion;
    else if (n.includes("reason")) out[name] = spec.reason;
    else if (n.includes("actor")) out[name] = spec.actorAdvisorId;
    else if (n.includes("role")) out[name] = spec.role;
    else if (n.includes("advisor") || n.endsWith("_id")) out[name] = spec.advisorId;
    else throw new Error(`unmapped set_advisor_role parameter "${name}"`);
  }
  return out;
}

async function callLifecycle(
  client: SupabaseClient,
  spec: LifecycleSpec
): Promise<{ data: unknown; error: { code?: string; message?: string } | null }> {
  const names = await rpcInputArgNames("lifecycle_transition");
  const { data, error } = await client.rpc("lifecycle_transition", mapLifecycleArgs(names, spec));
  return { data, error: (error as { code?: string; message?: string } | null) ?? null };
}

async function callSetRole(
  spec: SetRoleSpec
): Promise<{ data: unknown; error: { code?: string; message?: string } | null }> {
  const names = await rpcInputArgNames("set_advisor_role");
  const { data, error } = await service.rpc("set_advisor_role", mapSetRoleArgs(names, spec));
  return { data, error: (error as { code?: string; message?: string } | null) ?? null };
}

// ---------------------------------------------------------------------------
// RPC writer callers (parameter identifiers pinned by migration 20261015000001)
// ---------------------------------------------------------------------------

interface StudentProfilePayload {
  full_name: string;
  email: string;
  is_ch_student: boolean;
  major: string | null;
  minor: string | null;
  gpa: number | null;
  class_standing: string | null;
  us_citizen: boolean;
  age: number | null;
  gender: string | null;
  pronouns: string | null;
  race_ethnicity: string | null;
  languages: string | null;
  first_gen: boolean;
  honors_college: boolean;
}

function baseStudentPayload(): StudentProfilePayload {
  return {
    full_name: syntheticName(nextUnique("profile")),
    email: syntheticEmail(nextUnique("profile")),
    is_ch_student: false,
    major: "Physics",
    minor: null,
    gpa: 3.4,
    class_standing: "Sophomore",
    us_citizen: true,
    age: null,
    gender: null,
    pronouns: null,
    race_ethnicity: null,
    languages: null,
    first_gen: false,
    honors_college: false,
  };
}

interface RpcResult {
  data: Array<Record<string, unknown>> | null;
  error: { code?: string; message?: string } | null;
}

async function callUpdateStudent(
  actor: Actor,
  studentId: number,
  expectedVersion: number | null,
  payload: StudentProfilePayload
): Promise<RpcResult> {
  const { data, error } = await actor.client.rpc("update_student_profile", {
    p_student_id: studentId,
    p_expected_version: expectedVersion,
    p_full_name: payload.full_name,
    p_email: payload.email,
    p_is_ch_student: payload.is_ch_student,
    p_major: payload.major,
    p_minor: payload.minor,
    p_gpa: payload.gpa,
    p_class_standing: payload.class_standing,
    p_us_citizen: payload.us_citizen,
    p_age: payload.age,
    p_gender: payload.gender,
    p_pronouns: payload.pronouns,
    p_race_ethnicity: payload.race_ethnicity,
    p_languages: payload.languages,
    p_first_gen: payload.first_gen,
    p_honors_college: payload.honors_college,
  });
  return {
    data: (data as Array<Record<string, unknown>> | null) ?? null,
    error: (error as { code?: string; message?: string } | null) ?? null,
  };
}

async function callUpdateFellowship(
  actor: Actor,
  fellowshipId: number,
  expectedVersion: number | null,
  fellowshipName: string
): Promise<RpcResult> {
  const { data, error } = await actor.client.rpc("update_fellowship", {
    p_fellowship_id: fellowshipId,
    p_expected_version: expectedVersion,
    p_fellowship_name: fellowshipName,
  });
  return {
    data: (data as Array<Record<string, unknown>> | null) ?? null,
    error: (error as { code?: string; message?: string } | null) ?? null,
  };
}

interface ApplicationPayload {
  student_id: number;
  fellowship_id: number;
  application_year: number | null;
  destination_country: string | null;
  stage_of_application: string;
  is_semi_finalist: boolean;
  is_finalist: boolean;
}

async function callUpdateApplication(
  actor: Actor,
  applicationId: number,
  expectedVersion: number | null,
  payload: ApplicationPayload
): Promise<RpcResult> {
  const { data, error } = await actor.client.rpc("update_application", {
    p_application_id: applicationId,
    p_expected_version: expectedVersion,
    p_student_id: payload.student_id,
    p_fellowship_id: payload.fellowship_id,
    p_application_year: payload.application_year,
    p_destination_country: payload.destination_country,
    p_stage_of_application: payload.stage_of_application,
    p_is_semi_finalist: payload.is_semi_finalist,
    p_is_finalist: payload.is_finalist,
  });
  return {
    data: (data as Array<Record<string, unknown>> | null) ?? null,
    error: (error as { code?: string; message?: string } | null) ?? null,
  };
}

async function callUpdateMyProfile(
  actor: Actor,
  expectedVersion: number | null,
  advisorName: string
): Promise<RpcResult> {
  const { data, error } = await actor.client.rpc("update_my_advisor_profile", {
    p_expected_version: expectedVersion,
    p_advisor_name: advisorName,
  });
  return {
    data: (data as Array<Record<string, unknown>> | null) ?? null,
    error: (error as { code?: string; message?: string } | null) ?? null,
  };
}

async function callAdminProfileRename(
  admin: Actor,
  targetAdvisorId: number,
  expectedVersion: number | null,
  advisorName: string
): Promise<RpcResult> {
  const { data, error } = await admin.client.rpc("update_advisor_profile_name", {
    p_advisor_id: targetAdvisorId,
    p_advisor_name: advisorName,
    p_expected_version: expectedVersion,
  });
  return {
    data: (data as Array<Record<string, unknown>> | null) ?? null,
    error: (error as { code?: string; message?: string } | null) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Suite state
// ---------------------------------------------------------------------------

let staffA: Actor; // active bound advisor (no claim) — first editor
let staffB: Actor; // active bound advisor (no claim) — second editor
let adminActor: Actor; // active bound advisor + durable ocf_admin claim

beforeAll(async () => {
  pool = createDbPool(env);
  staffA = await createBoundActor("writer-staff-a");
  staffB = await createBoundActor("writer-staff-b");
  adminActor = await createBoundActor("writer-admin", true);
});

afterAll(async () => {
  if (pool) await pool.end();
});

// ---------------------------------------------------------------------------
// R1: version/timestamp metadata
// ---------------------------------------------------------------------------

describe("optimistic-concurrency metadata columns (R1)", () => {
  it("adds NON-NULL row_version DEFAULT 1 and updated_at DEFAULT now() to all four current-state tables", async () => {
    for (const table of ["student", "fellowship", "application", "advisor"]) {
      const { rows } = await pool.query(
        `SELECT column_name, data_type, is_nullable, column_default
           FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1
            AND column_name IN ('row_version', 'updated_at')
          ORDER BY column_name`,
        [table]
      );
      expect(rows, `${table} metadata columns`).toHaveLength(2);
      const byName = new Map(rows.map((r) => [r.column_name as string, r]));
      expect(byName.get("row_version")).toMatchObject({
        data_type: "integer",
        is_nullable: "NO",
        column_default: "1",
      });
      expect(byName.get("updated_at")).toMatchObject({
        data_type: "timestamp with time zone",
        is_nullable: "NO",
        column_default: "now()",
      });
    }
  });

  it("starts every fresh advisor row at row_version 1 with a non-null timestamp (provisioning path)", async () => {
    const tag = nextUnique("provision-v1");
    const email = syntheticEmail(tag);
    const authUserId = await createAuthUser(service, email);
    const { data, error } = await service.rpc("provision_advisor", {
      p_actor_id: adminActor.advisorId,
      p_advisor_name: syntheticName(tag),
      p_auth_user_id: authUserId,
      p_email: email,
      p_role: "Advisor",
    });
    expect(error, "provision_advisor success").toBeNull();
    const row = (data as Array<{ advisor_id: number; row_version: number }> | null)?.[0];
    expect(row, "provision_advisor returns the created row").toBeDefined();
    expect(row!.row_version, "a freshly created advisor starts at version 1").toBe(1);

    const state = await readRowState("advisor", "advisor_id", row!.advisor_id);
    expect(state.row_version).toBe(1);
    expect(state.updated_at, "a fresh row carries a non-null timestamp").not.toBeNull();
  });

  it("starts every service-seeded current-state row at version 1 with a non-null timestamp", async () => {
    const studentId = await seedStudent("metadata-student");
    const fellowshipId = await seedFellowship("metadata-fellowship");
    const { applicationId } = await seedApplication("metadata-application");

    for (const [table, idColumn, id] of [
      ["student", "student_id", studentId],
      ["fellowship", "fellowship_id", fellowshipId],
      ["application", "application_id", applicationId],
    ] as const) {
      const state = await readRowState(table as string, idColumn as string, id as number);
      expect(state.row_version, `${table} initial version`).toBe(1);
      expect(state.updated_at, `${table} initial timestamp`).not.toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// R2: exactly one increment + timestamp stamp, no-op/technical preservation
// (direct trigger behavior, exercised through the lane's local superuser)
// ---------------------------------------------------------------------------

describe("row-version trigger: exactly one increment and timestamp stamp (R2)", () => {
  it("increments exactly once and stamps updated_at on a single-field semantic change (clobber-proof)", async () => {
    const fellowshipId = await seedFellowship("trigger-semantic");
    const before = await readRowState("fellowship", "fellowship_id", fellowshipId);

    // Single statement: rename the fellowship AND attempt to clobber both
    // technical columns. The trigger must overwrite the clobber with its own
    // stamp and increment exactly once.
    await pool.query(
      `UPDATE public.fellowship
          SET fellowship_name = $1, row_version = 99, updated_at = '2000-01-01T00:00:00Z'
        WHERE fellowship_id = $2`,
      [syntheticName(nextUnique("trigger-semantic-new")), fellowshipId]
    );

    const after = await readRowState("fellowship", "fellowship_id", fellowshipId);
    expect(after.row_version, "exactly one increment").toBe(before.row_version + 1);
    expect(after.updated_at, "the clobbered timestamp is overwritten by the trigger stamp").not.toBe(
      "2000-01-01T00:00:00.000Z"
    );
    expect(after.updated_at, "updated_at advances on a semantic change").toBeGreaterThan(
      before.updated_at
    );
  });

  it("increments exactly once for a multi-field semantic change (never once per column)", async () => {
    const studentId = await seedStudent("trigger-multifield", {
      major: "A",
      minor: "B",
      class_standing: "Freshman",
    });
    const before = await readRowState("student", "student_id", studentId);

    await pool.query(
      `UPDATE public.student
          SET major = $1, minor = $2, class_standing = $3, gpa = $4
        WHERE student_id = $5`,
      ["X", "Y", "Senior", 3.9, studentId]
    );

    const after = await readRowState("student", "student_id", studentId);
    expect(after.row_version, "one increment for a three-field change").toBe(before.row_version + 1);
  });

  it("preserves version and timestamp for a no-op restatement, even under a manual clobber", async () => {
    const fellowshipId = await seedFellowship("trigger-noop");
    const { rows } = await pool.query<{ fellowship_name: string }>(
      "SELECT fellowship_name FROM public.fellowship WHERE fellowship_id = $1",
      [fellowshipId]
    );
    const before = await readRowState("fellowship", "fellowship_id", fellowshipId);

    // Restate the SAME business value while clobbering both technical columns:
    // the trigger must preserve the version and timestamp exactly.
    await pool.query(
      `UPDATE public.fellowship
          SET fellowship_name = $1, row_version = 99, updated_at = '2000-01-01T00:00:00Z'
        WHERE fellowship_id = $2`,
      [rows[0].fellowship_name, fellowshipId]
    );

    const after = await readRowState("fellowship", "fellowship_id", fellowshipId);
    expect(after.row_version, "no-op preserves the version").toBe(before.row_version);
    expect(after.updated_at, "no-op preserves the timestamp").toBe(before.updated_at);
  });

  it("preserves version and timestamp for a technical-only write (last_login_at on advisor)", async () => {
    const { data } = await service
      .from("advisor")
      .insert({ advisor_name: syntheticName(nextUnique("tech-only")), email: syntheticEmail(nextUnique("tech-only")), is_active: true, role: "Advisor" })
      .select("advisor_id")
      .single();
    const advisorId = data!.advisor_id as number;
    const before = await readRowState("advisor", "advisor_id", advisorId);

    await pool.query(
      `UPDATE public.advisor SET last_login_at = now() WHERE advisor_id = $1`,
      [advisorId]
    );

    const after = await readRowState("advisor", "advisor_id", advisorId);
    expect(after.row_version, "technical-only write keeps the version").toBe(before.row_version);
    expect(after.updated_at, "technical-only write keeps the timestamp").toBe(before.updated_at);
  });

  it("increments exactly once and returns the new version/timestamp through the self-service RPC", async () => {
    const actor = await createBoundActor("rpc-version-self");
    const before = await readRowState("advisor", "advisor_id", actor.advisorId);
    const next = `${actor.advisorName} (Versioned)`;

    const result = await callUpdateMyProfile(actor, before.row_version, next);
    expect(result.error, "self rename succeeds").toBeNull();
    const returned = (result.data ?? [])[0] as
      | { advisor_id: number; advisor_name: string; row_version: number; updated_at: string }
      | undefined;
    expect(returned?.row_version, "RPC returns the incremented version").toBe(
      before.row_version + 1
    );
    expect(returned?.advisor_name).toBe(next);

    const after = await readRowState("advisor", "advisor_id", actor.advisorId);
    expect(after.row_version).toBe(before.row_version + 1);
    expect(after.updated_at, "timestamp advanced by the semantic RPC write").toBeGreaterThan(
      before.updated_at
    );
  });
});

// ---------------------------------------------------------------------------
// R3: stale expected-version rejection with two independently authenticated
// editor sessions (no overwrite, no version/timestamp/audit change)
// ---------------------------------------------------------------------------

describe("stale expected-version rejection (R3): concurrent sessions never overwrite", () => {
  it("rejects a stale student-profile write from a second editor: no overwrite, no bump, no event", async () => {
    const studentId = await seedStudent("stale-student");
    const firstPayload = baseStudentPayload();
    const secondPayload = baseStudentPayload();

    // Editor A writes with the current version (1).
    const first = await callUpdateStudent(staffA, studentId, 1, firstPayload);
    expect(first.error, "editor A current-version write").toBeNull();
    const afterA = await readRowState("student", "student_id", studentId);
    expect(afterA.row_version).toBe(2);
    const auditAfterA = await readAudit("student", studentId);
    const updatesAfterA = auditAfterA.filter((e) => e.action === "updated").length;

    // Editor B still holds the ORIGINAL version (1): its write must be
    // rejected BEFORE any mutation.
    const stale = await callUpdateStudent(staffB, studentId, 1, secondPayload);
    expect(stale.error, "stale write must be rejected").not.toBeNull();
    expect(stale.error?.code, "stale rejection uses PT409").toBe("PT409");

    // No overwrite: editor A's values are intact.
    const afterStale = await readRowState("student", "student_id", studentId);
    expect(afterStale.row_version, "stale rejection bumps nothing").toBe(afterA.row_version);
    expect(afterStale.updated_at, "stale rejection does not touch the timestamp").toBe(
      afterA.updated_at
    );
    const { rows } = await pool.query<{ full_name: string; gpa: number | null }>(
      "SELECT full_name, gpa::float8 AS gpa FROM public.student WHERE student_id = $1",
      [studentId]
    );
    expect(rows[0].full_name, "editor A's value is preserved").toBe(firstPayload.full_name);
    expect(rows[0].gpa, "editor A's other field is preserved too").toBe(firstPayload.gpa);

    // No audit event from the rejected stale write.
    const auditAfterStale = await readAudit("student", studentId);
    expect(
      auditAfterStale.filter((e) => e.action === "updated").length,
      "a rejected stale write records no audit event"
    ).toBe(updatesAfterA);

    // A retried write with the FRESH version succeeds (the conflict is a
    // tri-state signal, never a lockout).
    const retry = await callUpdateStudent(staffB, studentId, afterA.row_version, secondPayload);
    expect(retry.error, "fresh-version retry succeeds").toBeNull();
    expect((await readRowState("student", "student_id", studentId)).row_version).toBe(
      afterA.row_version + 1
    );
  });

  it("rejects a stale fellowship-name write: the row is untouched and only one event exists", async () => {
    const fellowshipId = await seedFellowship("stale-fellowship");
    const first = await callUpdateFellowship(staffA, fellowshipId, 1, syntheticName(nextUnique("stale-f1")));
    expect(first.error).toBeNull();
    const afterA = await readRowState("fellowship", "fellowship_id", fellowshipId);

    const stale = await callUpdateFellowship(staffB, fellowshipId, 1, syntheticName(nextUnique("stale-f2")));
    expect(stale.error?.code, "stale fellowship rejection code").toBe("PT409");

    const current = await readRowState("fellowship", "fellowship_id", fellowshipId);
    expect(current.row_version, "stale fellowship write bumps nothing").toBe(afterA.row_version);
    expect(current.updated_at, "stale fellowship write does not touch timestamp").toBe(
      afterA.updated_at
    );
    expect(
      (await readAudit("fellowship", fellowshipId)).filter((e) => e.action === "updated"),
      "stale fellowship write records no event"
    ).toHaveLength(1);
  });

  it("rejects a stale application write: no overwrite, no version/timestamp/audit change", async () => {
    const { applicationId, studentId, fellowshipId } = await seedApplication("stale-app");

    const first = await callUpdateApplication(staffA, applicationId, 1, {
      student_id: studentId,
      fellowship_id: fellowshipId,
      application_year: 2026,
      destination_country: "Newland",
      stage_of_application: "Under Review",
      is_semi_finalist: false,
      is_finalist: false,
    });
    expect(first.error).toBeNull();
    const afterA = await readRowState("application", "application_id", applicationId);

    const stale = await callUpdateApplication(staffB, applicationId, 1, {
      student_id: studentId,
      fellowship_id: fellowshipId,
      application_year: 2026,
      destination_country: "Overwritten",
      stage_of_application: "Awarded",
      is_semi_finalist: true,
      is_finalist: true,
    });
    expect(stale.error?.code, "stale application rejection code").toBe("PT409");

    const current = await readRowState("application", "application_id", applicationId);
    expect(current.row_version).toBe(afterA.row_version);
    expect(current.updated_at).toBe(afterA.updated_at);
    const { rows } = await pool.query<{ destination_country: string | null; stage_of_application: string }>(
      "SELECT destination_country, stage_of_application FROM public.application WHERE application_id = $1",
      [applicationId]
    );
    expect(rows[0].destination_country, "editor A's country is preserved").toBe("Newland");
    expect(rows[0].stage_of_application).toBe("Under Review");
    expect(
      (await readAudit("application", applicationId)).filter((e) => e.action === "updated"),
      "stale application write records no event"
    ).toHaveLength(1);
  });

  it("rejects a stale self-service advisor-profile write (PT409) and leaves the row untouched", async () => {
    const actor = await createBoundActor("stale-self");
    const renamed = `${actor.advisorName} (First)`;
    const first = await callUpdateMyProfile(actor, 1, renamed);
    expect(first.error).toBeNull();
    const afterFirst = await readRowState("advisor", "advisor_id", actor.advisorId);

    const stale = await callUpdateMyProfile(actor, 1, `${actor.advisorName} (Stale)`);
    expect(stale.error, "stale self-profile write must be rejected").not.toBeNull();
    expect(stale.error?.code).toBe("PT409");

    const current = await readRowState("advisor", "advisor_id", actor.advisorId);
    expect(current.row_version).toBe(afterFirst.row_version);
    expect(current.updated_at).toBe(afterFirst.updated_at);
    const { rows } = await pool.query<{ advisor_name: string }>(
      "SELECT advisor_name FROM public.advisor WHERE advisor_id = $1",
      [actor.advisorId]
    );
    expect(rows[0].advisor_name).toBe(renamed);
  });

  it("rejects a stale effective-Admin peer rename with no event and no change (PT409)", async () => {
    const target = await createBoundActor("stale-peer-target");
    const first = await callAdminProfileRename(
      adminActor,
      target.advisorId,
      1,
      syntheticName(nextUnique("peer-first"))
    );
    expect(first.error, "effective-Admin peer rename with current version").toBeNull();
    const afterFirst = await readRowState("advisor", "advisor_id", target.advisorId);

    const stale = await callAdminProfileRename(
      adminActor,
      target.advisorId,
      1,
      syntheticName(nextUnique("peer-stale"))
    );
    expect(stale.error, "stale peer rename must be rejected").not.toBeNull();
    expect(stale.error?.code).toBe("PT409");

    const current = await readRowState("advisor", "advisor_id", target.advisorId);
    expect(current.row_version).toBe(afterFirst.row_version);
    expect(current.updated_at).toBe(afterFirst.updated_at);
    // Exactly one updated event (from the first, successful rename).
    const updates = (await readAudit("advisor", target.advisorId)).filter(
      (e) => e.action === "updated"
    );
    expect(updates, "stale peer rename records no event").toHaveLength(1);
  });

  it("rejects a stale lifecycle archive with PT409 and performs no state or audit change", async () => {
    const studentId = await seedStudent("stale-lifecycle");

    const first = await callLifecycle(adminActor.client, {
      entity: "student",
      action: "archive",
      entityId: studentId,
      reason: "contract stale lifecycle archive",
      expectedVersion: 1,
    });
    expect(first.error, "current-version archive").toBeNull();
    const firstData = (first.data as Array<{ applied: boolean; row_version: number }> | null)?.[0];
    expect(firstData?.applied).toBe(true);
    const afterFirst = await readRowState("student", "student_id", studentId);

    // STALE version: rejected before any change even though the action itself
    // would now be a no-op.
    const stale = await callLifecycle(adminActor.client, {
      entity: "student",
      action: "archive",
      entityId: studentId,
      reason: "contract stale lifecycle archive",
      expectedVersion: 1,
    });
    expect(stale.error, "stale lifecycle must be rejected").not.toBeNull();
    expect(stale.error?.code).toBe("PT409");

    const current = await readRowState("student", "student_id", studentId);
    expect(current.row_version).toBe(afterFirst.row_version);
    expect(current.updated_at).toBe(afterFirst.updated_at);
    expect(
      (await readAudit("student", studentId)).filter((e) => e.action === "archived"),
      "stale lifecycle records no event"
    ).toHaveLength(1);

    // The CURRENT version turns the repeated transition into a clean no-op:
    // applied=false, version unchanged, no event.
    const noop = await callLifecycle(adminActor.client, {
      entity: "student",
      action: "archive",
      entityId: studentId,
      reason: "contract no-op lifecycle archive",
      expectedVersion: current.row_version,
    });
    expect(noop.error, "current-version idempotent archive").toBeNull();
    const noopData = (noop.data as Array<{ applied: boolean; row_version: number }> | null)?.[0];
    expect(noopData?.applied, "an already archived student is a no-op").toBe(false);
    expect(noopData?.row_version, "a no-op transition returns the unchanged version").toBe(
      current.row_version
    );
    expect((await readRowState("student", "student_id", studentId)).row_version).toBe(
      current.row_version
    );
  });

  it("rejects a stale set_advisor_role demotion with PT409 and changes neither claim nor display role", async () => {
    const target = await createBoundActor("stale-role-target");

    const promote = await callSetRole({
      advisorId: target.advisorId,
      role: "Admin",
      actorAdvisorId: adminActor.advisorId,
      reason: "contract promote for stale demotion",
      expectedVersion: 1,
    });
    expect(promote.error, "promote with current version").toBeNull();

    const staleDemote = await callSetRole({
      advisorId: target.advisorId,
      role: "Advisor",
      actorAdvisorId: adminActor.advisorId,
      reason: "contract stale demotion",
      expectedVersion: 1,
    });
    expect(staleDemote.error, "stale demotion must be rejected").not.toBeNull();
    expect(staleDemote.error?.code).toBe("PT409");

    const { rows } = await pool.query<{ role: string; row_version: number; ocf_admin: boolean | null }>(
      `SELECT a.role, a.row_version,
              (u.raw_app_meta_data -> 'ocf_admin')::boolean AS ocf_admin
         FROM public.advisor a
         JOIN auth.users u ON u.id = a.auth_user_id
        WHERE a.advisor_id = $1`,
      [target.advisorId]
    );
    expect(rows[0].role, "stale demotion leaves the display role").toBe("Admin");
    expect(rows[0].ocf_admin, "stale demotion leaves the durable claim").toBe(true);
    expect(
      (await readAudit("advisor", target.advisorId)).filter((e) => e.action === "role_changed"),
      "stale demotion records no event"
    ).toHaveLength(1);
  });

  it("rejects a NULL expected version fail-closed with 22023 (malformed input, distinct from a conflict)", async () => {
    const fellowshipId = await seedFellowship("malformed-version");

    const malformed = await callUpdateFellowship(
      staffA,
      fellowshipId,
      null,
      syntheticName(nextUnique("malformed-f"))
    );
    expect(malformed.error, "NULL expected version must be rejected").not.toBeNull();
    expect(malformed.error?.code, "malformed version uses 22023, not PT409").toBe("22023");

    const current = await readRowState("fellowship", "fellowship_id", fellowshipId);
    expect(current.row_version, "malformed call changes nothing").toBe(1);
    expect(
      (await readAudit("fellowship", fellowshipId)).filter((e) => e.action === "updated"),
      "malformed call records no event"
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// R2/R4: the writer row timestamp and its audit event share ONE transaction clock
// ---------------------------------------------------------------------------

/**
 * Assert the single `action` event for the entity carries the SAME database
 * transaction timestamp as the row's `updated_at` (both `now()` in one write
 * transaction) — direct evidence the timestamp is database-authored and the
 * event is atomic with the business write.
 */
async function assertEventSharesRowTimestamp(
  table: "student" | "fellowship" | "application" | "advisor",
  idColumn: string,
  entityType: string,
  entityId: number,
  action: string
): Promise<void> {
  const { rows } = await pool.query<{ same: boolean }>(
    `SELECT extract(epoch from a.occurred_at) = extract(epoch from r.updated_at) AS same
       FROM public.audit_event a
       JOIN public.${table} r ON r.${idColumn} = a.entity_id
      WHERE a.entity_type = $1 AND a.entity_id = $2 AND a.action = $3`,
    [entityType, entityId, action]
  );
  expect(rows, `exactly one ${action} event for ${entityType}/${entityId}`).toHaveLength(1);
  expect(rows[0].same, `the ${action} event shares the row transaction timestamp`).toBe(true);
}

describe("writer row timestamp and audit event share one database transaction clock (R2/R4)", () => {
  it("shares the transaction timestamp for the advisor self/peer/role/lifecycle writers", async () => {
    // Self-service profile-name writer.
    const selfActor = await createBoundActor("ts-self");
    const selfResult = await callUpdateMyProfile(
      selfActor,
      1,
      syntheticName(nextUnique("ts-self-renamed"))
    );
    expect(selfResult.error, "self profile timestamp write").toBeNull();
    expect((await readRowState("advisor", "advisor_id", selfActor.advisorId)).row_version).toBe(2);
    await assertEventSharesRowTimestamp("advisor", "advisor_id", "advisor", selfActor.advisorId, "updated");

    // Effective-Admin peer rename writer.
    const peer = await createBoundActor("ts-peer");
    const peerResult = await callAdminProfileRename(
      adminActor,
      peer.advisorId,
      1,
      syntheticName(nextUnique("ts-peer-renamed"))
    );
    expect(peerResult.error, "peer rename timestamp write").toBeNull();
    expect((await readRowState("advisor", "advisor_id", peer.advisorId)).row_version).toBe(2);
    await assertEventSharesRowTimestamp("advisor", "advisor_id", "advisor", peer.advisorId, "updated");

    // Trusted atomic role-change writer.
    const roleTarget = await createBoundActor("ts-role");
    const roleResult = await callSetRole({
      advisorId: roleTarget.advisorId,
      role: "Admin",
      actorAdvisorId: adminActor.advisorId,
      reason: "timestamp matrix role change",
      expectedVersion: 1,
    });
    expect(roleResult.error, "role change timestamp write").toBeNull();
    expect((await readRowState("advisor", "advisor_id", roleTarget.advisorId)).row_version).toBe(2);
    await assertEventSharesRowTimestamp("advisor", "advisor_id", "advisor", roleTarget.advisorId, "role_changed");

    // Lifecycle deactivation writer (non-Admin target keeps the invariant safe).
    const lifecycleTarget = await createBoundActor("ts-lifecycle");
    const lifecycleResult = await callLifecycle(adminActor.client, {
      entity: "advisor",
      action: "deactivate",
      entityId: lifecycleTarget.advisorId,
      reason: "timestamp matrix lifecycle deactivate",
      expectedVersion: 1,
    });
    expect(lifecycleResult.error, "advisor lifecycle timestamp write").toBeNull();
    await assertEventSharesRowTimestamp(
      "advisor",
      "advisor_id",
      "advisor",
      lifecycleTarget.advisorId,
      "deactivated"
    );
  });
});

// ---------------------------------------------------------------------------
// R6: technical columns never enter an audit diff/snapshot
// ---------------------------------------------------------------------------

describe("technical version/timestamp fields are absent from audit diffs (R6)", () => {
  it("never exposes row_version/updated_at in student audit snapshots or diffs, and emits one event for one semantic write", async () => {
    const studentId = await seedStudent("tech-exclusion-student");
    const payload = baseStudentPayload();
    const result = await callUpdateStudent(staffA, studentId, 1, payload);
    expect(result.error).toBeNull();

    const event = await assertSingleSemanticAudit("student", studentId, "updated");
    assertNoTechnicalKeys(event.new_values, "student new_values");
    assertNoTechnicalKeys(event.old_values, "student old_values");
    assertNoTechnicalKeys(event.changes, "student changes");
    expect(event.changes).toMatchObject({
      full_name: { old: expect.any(String), new: payload.full_name },
      // The seeded student carries no gpa; the payload introduces one.
      gpa: { old: null, new: payload.gpa },
    });
    // The diff is bounded to business fields; the version fields are absent.
    const diffKeys = Object.keys(event.changes ?? {});
    expect(diffKeys).not.toContain("row_version");
    expect(diffKeys).not.toContain("updated_at");
  });

  it("never exposes row_version/updated_at in fellowship or application audit payloads", async () => {
    const fellowshipId = await seedFellowship("tech-exclusion-fellowship");
    const fellowshipResult = await callUpdateFellowship(
      staffA,
      fellowshipId,
      1,
      syntheticName(nextUnique("tech-exclusion-f"))
    );
    expect(fellowshipResult.error).toBeNull();
    const fellowshipEvent = await assertSingleSemanticAudit("fellowship", fellowshipId, "updated");
    assertNoTechnicalKeys(fellowshipEvent.new_values, "fellowship new_values");
    assertNoTechnicalKeys(fellowshipEvent.changes, "fellowship changes");

    const { applicationId, studentId, fellowshipId: appFellowshipId } =
      await seedApplication("tech-exclusion-app");
    const appResult = await callUpdateApplication(staffA, applicationId, 1, {
      student_id: studentId,
      fellowship_id: appFellowshipId,
      application_year: 2026,
      destination_country: "Techland",
      stage_of_application: "Submitted",
      is_semi_finalist: false,
      is_finalist: false,
    });
    expect(appResult.error).toBeNull();
    const appEvent = await assertSingleSemanticAudit("application", applicationId, "updated");
    assertNoTechnicalKeys(appEvent.new_values, "application new_values");
    assertNoTechnicalKeys(appEvent.changes, "application changes");
  });

  it("never exposes row_version/updated_at in advisor audit payloads (self-service rename)", async () => {
    const actor = await createBoundActor("tech-exclusion-advisor");
    const next = `${actor.advisorName} (Tech-safe)`;
    const result = await callUpdateMyProfile(actor, 1, next);
    expect(result.error).toBeNull();

    const event = await assertSingleSemanticAudit("advisor", actor.advisorId, "updated");
    assertNoTechnicalKeys(event.new_values, "advisor new_values");
    assertNoTechnicalKeys(event.old_values, "advisor old_values");
    assertNoTechnicalKeys(event.changes, "advisor changes");
    // The advisor allowlist is exactly the four business fields.
    expect(Object.keys(event.new_values ?? {}).sort()).toEqual([
      "advisor_name",
      "email",
      "is_active",
      "role",
    ]);
  });

  it("keeps lifecycle archive diffs bounded to archived_at (no version/timestamp keys)", async () => {
    const studentId = await seedStudent("tech-exclusion-lifecycle");
    const result = await callLifecycle(adminActor.client, {
      entity: "student",
      action: "archive",
      entityId: studentId,
      reason: "contract tech-exclusion archive",
      expectedVersion: 1,
    });
    expect(result.error).toBeNull();

    const event = await assertSingleSemanticAudit("student", studentId, "archived");
    expect(event.changes).toEqual({ archived_at: { old: null, new: expect.any(String) } });
    assertNoTechnicalKeys(event.changes, "archived changes");
    assertNoTechnicalKeys(event.new_values, "archived new_values");
  });
});

// ---------------------------------------------------------------------------
// R3: revoked direct authenticated UPDATE boundary
// ---------------------------------------------------------------------------

describe("revoked direct authenticated UPDATE (R3)", () => {
  const TABLES = ["student", "fellowship", "application", "advisor"] as const;

  it("revokes authenticated UPDATE table privilege on all four current-state tables", async () => {
    for (const table of TABLES) {
      const { rows } = await pool.query(
        `SELECT has_table_privilege('authenticated', 'public.${table}', 'UPDATE') AS auth_update,
                has_table_privilege('authenticated', 'public.${table}', 'SELECT')  AS auth_select
        `
      );
      expect(rows[0].auth_update, `${table} authenticated UPDATE must be revoked`).toBe(false);
      expect(rows[0].auth_select, `${table} authenticated SELECT stays available`).toBe(true);
    }
  });

  it("drops the four direct UPDATE policies", async () => {
    const { rows } = await pool.query(
      `SELECT policyname
         FROM pg_policies
        WHERE schemaname = 'public'
          AND policyname IN (
            'active_advisor_update_student',
            'active_advisor_update_fellowship',
            'active_advisor_update_application',
            'advisor_update_own_profile'
          )`
    );
    expect(rows, "all direct UPDATE policies must be dropped").toHaveLength(0);
  });

  it("denies authenticated direct UPDATE on each table (42501) and leaves state, version, timestamp, and audit untouched", async () => {
    const studentId = await seedStudent("revoked-update-student");
    const fellowshipId = await seedFellowship("revoked-update-fellowship");
    const { applicationId } = await seedApplication("revoked-update-application");
    const advisorId = await insertAdvisor(
      syntheticName(nextUnique("revoked-update-advisor")),
      syntheticEmail(nextUnique("revoked-update-advisor"))
    );

    const attempts: Array<{ table: string; idColumn: string; id: number; payload: Record<string, unknown> }> = [
      { table: "student", idColumn: "student_id", id: studentId, payload: { major: "X" } },
      {
        table: "fellowship",
        idColumn: "fellowship_id",
        id: fellowshipId,
        payload: { fellowship_name: "Y" },
      },
      {
        table: "application",
        idColumn: "application_id",
        id: applicationId,
        payload: { stage_of_application: "Z" },
      },
      { table: "advisor", idColumn: "advisor_id", id: advisorId, payload: { advisor_name: "W" } },
    ];

    for (const attempt of attempts) {
      const before = await readRowState(attempt.table, attempt.idColumn, attempt.id);
      const auditBefore = (await readAudit(attempt.table, attempt.id)).length;

      const { data, error } = await staffA.client
        .from(attempt.table)
        .update(attempt.payload)
        .eq(attempt.idColumn, attempt.id)
        .select(attempt.idColumn);
      expect(error, `direct authenticated UPDATE on ${attempt.table} must be denied`).not.toBeNull();
      expect(error?.code, `${attempt.table} direct UPDATE denial code`).toBe("42501");
      expect(data ?? [], `denied ${attempt.table} UPDATE returns no rows`).toHaveLength(0);

      const after = await readRowState(attempt.table, attempt.idColumn, attempt.id);
      expect(after.row_version, `${attempt.table} version unchanged after denial`).toBe(
        before.row_version
      );
      expect(after.updated_at, `${attempt.table} timestamp unchanged after denial`).toBe(
        before.updated_at
      );
      expect(
        (await readAudit(attempt.table, attempt.id)).length,
        `${attempt.table} denial records no audit event`
      ).toBe(auditBefore);
    }
  });

  it("denies the anon role on the versioned writer surface and on direct UPDATE", async () => {
    const denied = await anon.from("student").update({ major: "X" }).eq("student_id", 1);
    expect(denied.error, "anon direct UPDATE must be denied").not.toBeNull();

    const payload = baseStudentPayload();
    const rpcDenied = await anon.rpc("update_student_profile", {
      p_student_id: 1,
      p_expected_version: 1,
      p_full_name: payload.full_name,
      p_email: payload.email,
      p_is_ch_student: payload.is_ch_student,
      p_major: payload.major,
      p_minor: payload.minor,
      p_gpa: payload.gpa,
      p_class_standing: payload.class_standing,
      p_us_citizen: payload.us_citizen,
      p_age: payload.age,
      p_gender: payload.gender,
      p_pronouns: payload.pronouns,
      p_race_ethnicity: payload.race_ethnicity,
      p_languages: payload.languages,
      p_first_gen: payload.first_gen,
      p_honors_college: payload.honors_college,
    });
    expect(rpcDenied.error, "anon writer RPC must be denied").not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Independent-review finding 1: forged insert metadata is DB-authored
// (migration 20261016000001)
//
// The version/timestamp columns must be DB-authored on EVERY insert. A DEFAULT
// only applies when a column is omitted, so an INSERT that explicitly supplies
// `row_version`/`updated_at` must still be overridden to 1 / now().
// ---------------------------------------------------------------------------

describe("forged insert metadata is prevented (DB-authored row_version=1 / updated_at)", () => {
  const FORGED_VERSION = 999;
  const FORGED_UPDATED_AT = "2000-01-01T00:00:00Z";
  // Any DB-authored now() in this environment is well after 2023-11-14.
  const RECENT_EPOCH = 1_700_000_000;

  it("overrides forged row_version/updated_at on an authenticated INSERT (student/fellowship/application)", async () => {
    const tag = nextUnique("forged-auth");
    const { data: student, error: studentError } = await staffA.client
      .from("student")
      .insert({
        full_name: syntheticName(tag),
        email: syntheticEmail(tag),
        us_citizen: true,
        row_version: FORGED_VERSION,
        updated_at: FORGED_UPDATED_AT,
      })
      .select("student_id")
      .single();
    expect(studentError, "authenticated student INSERT with forged metadata").toBeNull();
    const studentState = await readRowState("student", "student_id", student!.student_id as number);
    expect(studentState.row_version, "authenticated INSERT cannot forge the version").toBe(1);
    expect(
      studentState.updated_at,
      "authenticated INSERT cannot forge the timestamp"
    ).toBeGreaterThan(RECENT_EPOCH);

    const { data: fellowship, error: fellowshipError } = await staffA.client
      .from("fellowship")
      .insert({
        fellowship_name: syntheticName(nextUnique("forged-auth-f")),
        row_version: FORGED_VERSION,
        updated_at: FORGED_UPDATED_AT,
      })
      .select("fellowship_id")
      .single();
    expect(fellowshipError, "authenticated fellowship INSERT with forged metadata").toBeNull();
    const fellowshipState = await readRowState(
      "fellowship",
      "fellowship_id",
      fellowship!.fellowship_id as number
    );
    expect(fellowshipState.row_version).toBe(1);
    expect(fellowshipState.updated_at).toBeGreaterThan(RECENT_EPOCH);

    const parentStudent = await seedStudent("forged-auth-app-student");
    const parentFellowship = await seedFellowship("forged-auth-app-fellowship");
    const { data: application, error: applicationError } = await staffA.client
      .from("application")
      .insert({
        student_id: parentStudent,
        fellowship_id: parentFellowship,
        stage_of_application: "Submitted",
        is_semi_finalist: false,
        is_finalist: false,
        application_year: 2026,
        row_version: FORGED_VERSION,
        updated_at: FORGED_UPDATED_AT,
      })
      .select("application_id")
      .single();
    expect(applicationError, "authenticated application INSERT with forged metadata").toBeNull();
    const applicationState = await readRowState(
      "application",
      "application_id",
      application!.application_id as number
    );
    expect(applicationState.row_version).toBe(1);
    expect(applicationState.updated_at).toBeGreaterThan(RECENT_EPOCH);
  });

  it("overrides forged row_version/updated_at on a trusted service-role INSERT for all four tables", async () => {
    const tag = nextUnique("forged-svc");
    const { data: student, error: studentError } = await service
      .from("student")
      .insert({
        full_name: syntheticName(tag),
        email: syntheticEmail(tag),
        us_citizen: true,
        row_version: FORGED_VERSION,
        updated_at: FORGED_UPDATED_AT,
      })
      .select("student_id")
      .single();
    expect(studentError).toBeNull();

    const { data: fellowship, error: fellowshipError } = await service
      .from("fellowship")
      .insert({
        fellowship_name: syntheticName(nextUnique("forged-svc-f")),
        row_version: FORGED_VERSION,
        updated_at: FORGED_UPDATED_AT,
      })
      .select("fellowship_id")
      .single();
    expect(fellowshipError).toBeNull();

    const parentStudent = await seedStudent("forged-svc-app-student");
    const parentFellowship = await seedFellowship("forged-svc-app-fellowship");
    const { data: application, error: applicationError } = await service
      .from("application")
      .insert({
        student_id: parentStudent,
        fellowship_id: parentFellowship,
        stage_of_application: "Submitted",
        is_semi_finalist: false,
        is_finalist: false,
        application_year: 2026,
        row_version: FORGED_VERSION,
        updated_at: FORGED_UPDATED_AT,
      })
      .select("application_id")
      .single();
    expect(applicationError).toBeNull();

    const { data: advisor, error: advisorError } = await service
      .from("advisor")
      .insert({
        advisor_name: syntheticName(nextUnique("forged-svc-a")),
        email: syntheticEmail(nextUnique("forged-svc-a")),
        is_active: true,
        row_version: FORGED_VERSION,
        updated_at: FORGED_UPDATED_AT,
      })
      .select("advisor_id")
      .single();
    expect(advisorError).toBeNull();

    for (const [table, idColumn, id] of [
      ["student", "student_id", student!.student_id as number],
      ["fellowship", "fellowship_id", fellowship!.fellowship_id as number],
      ["application", "application_id", application!.application_id as number],
      ["advisor", "advisor_id", advisor!.advisor_id as number],
    ] as const) {
      const state = await readRowState(table, idColumn, id);
      expect(state.row_version, `${table} service INSERT version`).toBe(1);
      expect(state.updated_at, `${table} service INSERT timestamp`).toBeGreaterThan(RECENT_EPOCH);
    }
  });

  it("overrides forged metadata on a direct INSERT and never lets a second insert inherit a forged version", async () => {
    // Direct superuser INSERTs with explicit forged metadata prove the trigger
    // (not just the column DEFAULT) is the enforcement point for every path.
    const parentStudent = await seedStudent("forged-direct-app-student");
    const parentFellowship = await seedFellowship("forged-direct-app-fellowship");

    const directCases: Array<{
      table: string;
      idColumn: string;
      insertSql: string;
      buildParams: () => unknown[];
    }> = [
      {
        table: "student",
        idColumn: "student_id",
        insertSql: `INSERT INTO public.student (full_name, email, us_citizen, row_version, updated_at)
                    VALUES ($1, $2, true, 999, '2000-01-01T00:00:00Z') RETURNING student_id`,
        buildParams: () => [
          syntheticName(nextUnique("forged-direct")),
          syntheticEmail(nextUnique("forged-direct")),
        ],
      },
      {
        table: "fellowship",
        idColumn: "fellowship_id",
        insertSql: `INSERT INTO public.fellowship (fellowship_name, row_version, updated_at)
                    VALUES ($1, 999, '2000-01-01T00:00:00Z') RETURNING fellowship_id`,
        buildParams: () => [syntheticName(nextUnique("forged-direct-f"))],
      },
      {
        table: "application",
        idColumn: "application_id",
        insertSql: `INSERT INTO public.application
                      (student_id, fellowship_id, stage_of_application, is_semi_finalist, is_finalist, row_version, updated_at)
                    VALUES ($1, $2, 'Submitted', false, false, 999, '2000-01-01T00:00:00Z') RETURNING application_id`,
        buildParams: () => [parentStudent, parentFellowship],
      },
      {
        table: "advisor",
        idColumn: "advisor_id",
        insertSql: `INSERT INTO public.advisor (advisor_name, email, is_active, row_version, updated_at)
                    VALUES ($1, $2, true, 999, '2000-01-01T00:00:00Z') RETURNING advisor_id`,
        buildParams: () => [
          syntheticName(nextUnique("forged-direct-a")),
          syntheticEmail(nextUnique("forged-direct-a")),
        ],
      },
    ];

    for (const testCase of directCases) {
      // Two inserts of the same shape: both must be version 1 (an insert never
      // inherits a forged version and never increments).
      for (let round = 0; round < 2; round += 1) {
        const { rows } = await pool.query<Record<string, number>>(
          testCase.insertSql,
          testCase.buildParams()
        );
        const id = rows[0][testCase.idColumn];
        const state = await readRowState(testCase.table, testCase.idColumn, id);
        expect(state.row_version, `${testCase.table} direct INSERT #${round} version`).toBe(1);
        expect(
          state.updated_at,
          `${testCase.table} direct INSERT #${round} timestamp`
        ).toBeGreaterThan(RECENT_EPOCH);
      }
    }
  });

  it("keeps the created audit snapshot free of the forged/technical metadata", async () => {
    const { data, error } = await service
      .from("fellowship")
      .insert({
        fellowship_name: syntheticName(nextUnique("forged-audit")),
        row_version: FORGED_VERSION,
        updated_at: FORGED_UPDATED_AT,
      })
      .select("fellowship_id")
      .single();
    expect(error).toBeNull();
    const events = await readAudit("fellowship", data!.fellowship_id as number);
    expect(events, "one created event").toHaveLength(1);
    assertNoTechnicalKeys(events[0].new_values, "created new_values after a forged INSERT");
    expect(events[0].new_values).not.toHaveProperty("row_version");
    expect(events[0].new_values).not.toHaveProperty("updated_at");
  });
});

// ---------------------------------------------------------------------------
// Independent-review finding 2: p_expected_version must be >= 1 (22023)
// (migration 20261016000001)
//
// A zero/negative version is malformed input, distinct from a stale PT409. It
// must be rejected with 22023 by every protected existing-row writer before any
// mutation, and must leave the row/version/timestamp/audit untouched.
// ---------------------------------------------------------------------------

describe("zero/negative expected versions are rejected as malformed input (22023)", () => {
  const BAD_VERSIONS = [0, -1, -42];

  function expect22023(error: { code?: string; message?: string } | null, label: string): void {
    expect(error, `${label} must be rejected`).not.toBeNull();
    expect(error?.code, `${label} malformed-version code`).toBe("22023");
  }

  it("rejects zero/negative versions on update_student_profile/update_fellowship/update_application", async () => {
    const studentId = await seedStudent("bad-version-student");
    const fellowshipId = await seedFellowship("bad-version-fellowship");
    const { applicationId, studentId: appStudent, fellowshipId: appFellowship } =
      await seedApplication("bad-version-application");

    for (const bad of BAD_VERSIONS) {
      const studentBefore = await readRowState("student", "student_id", studentId);
      const studentResult = await callUpdateStudent(staffA, studentId, bad, baseStudentPayload());
      expect22023(studentResult.error, `update_student_profile expected_version=${bad}`);
      expect(
        (await readRowState("student", "student_id", studentId)).row_version,
        "malformed student version changes nothing"
      ).toBe(studentBefore.row_version);
      expect(
        (await readAudit("student", studentId)).filter((e) => e.action === "updated"),
        "malformed student version records no event"
      ).toHaveLength(0);

      const fellowshipResult = await callUpdateFellowship(
        staffA,
        fellowshipId,
        bad,
        syntheticName(nextUnique("bad-version-f"))
      );
      expect22023(fellowshipResult.error, `update_fellowship expected_version=${bad}`);

      const applicationResult = await callUpdateApplication(staffA, applicationId, bad, {
        student_id: appStudent,
        fellowship_id: appFellowship,
        application_year: 2026,
        destination_country: "Testland",
        stage_of_application: "Submitted",
        is_semi_finalist: false,
        is_finalist: false,
      });
      expect22023(applicationResult.error, `update_application expected_version=${bad}`);
    }
  });

  it("rejects zero/negative versions on update_my_advisor_profile/update_advisor_profile_name", async () => {
    const selfActor = await createBoundActor("bad-version-self");
    const peerTarget = await createBoundActor("bad-version-peer-target");

    for (const bad of BAD_VERSIONS) {
      const selfResult = await callUpdateMyProfile(
        selfActor,
        bad,
        `${selfActor.advisorName} (bad ${bad})`
      );
      expect22023(selfResult.error, `update_my_advisor_profile expected_version=${bad}`);
      expect(
        (await readRowState("advisor", "advisor_id", selfActor.advisorId)).row_version,
        "malformed self version changes nothing"
      ).toBe(1);

      const peerResult = await callAdminProfileRename(
        adminActor,
        peerTarget.advisorId,
        bad,
        `${peerTarget.advisorName} (bad ${bad})`
      );
      expect22023(peerResult.error, `update_advisor_profile_name expected_version=${bad}`);
      expect(
        (await readRowState("advisor", "advisor_id", peerTarget.advisorId)).row_version,
        "malformed peer version changes nothing"
      ).toBe(1);
    }
  });

  it("rejects zero/negative versions on lifecycle_transition and set_advisor_role", async () => {
    const lifecycleStudent = await seedStudent("bad-version-lifecycle");
    const roleTarget = await createBoundActor("bad-version-role-target");

    for (const bad of BAD_VERSIONS) {
      const lifecycleResult = await callLifecycle(adminActor.client, {
        entity: "student",
        action: "archive",
        entityId: lifecycleStudent,
        reason: "contract malformed version",
        expectedVersion: bad,
      });
      expect22023(lifecycleResult.error, `lifecycle_transition expected_version=${bad}`);
      expect(
        (await readRowState("student", "student_id", lifecycleStudent)).row_version,
        "malformed lifecycle version changes nothing"
      ).toBe(1);
      expect(
        (await readAudit("student", lifecycleStudent)).filter((e) => e.action === "archived"),
        "malformed lifecycle version records no event"
      ).toHaveLength(0);

      const roleResult = await callSetRole({
        advisorId: roleTarget.advisorId,
        role: "Admin",
        actorAdvisorId: adminActor.advisorId,
        reason: "contract malformed version",
        expectedVersion: bad,
      });
      expect22023(roleResult.error, `set_advisor_role expected_version=${bad}`);
      expect(
        (await readRowState("advisor", "advisor_id", roleTarget.advisorId)).row_version,
        "malformed role version changes nothing"
      ).toBe(1);
    }
  });

  it("keeps 22023 (malformed) distinct from PT409 (stale) for the same writer", async () => {
    const fellowshipId = await seedFellowship("distinct-codes");
    // Advance the version once so a positive-but-stale version exists.
    const advanced = await callUpdateFellowship(
      staffA,
      fellowshipId,
      1,
      syntheticName(nextUnique("distinct-codes-1"))
    );
    expect(advanced.error).toBeNull();

    const malformed = await callUpdateFellowship(staffA, fellowshipId, 0, "x");
    expect(malformed.error?.code, "zero is malformed input").toBe("22023");

    const stale = await callUpdateFellowship(staffA, fellowshipId, 1, "y");
    expect(stale.error?.code, "a positive-but-stale version is a conflict").toBe("PT409");
  });
});

// ---------------------------------------------------------------------------
// Independent-review finding: prospective re-link parents are locked so a
// concurrent archive can never leave an application linked to an archived
// parent (migration 20261018000001)
//
// Two guarantees are proven against the lane database:
//
//   A. BARRIER-CONTROLLED ARCHIVE-vs-RELINK. While an archive transaction holds
//      the prospective parent row lock (uncommitted), a concurrent re-link
//      blocks on that lock and, once the archive commits, observes the archived
//      parent and is rejected (42501) — the application is never re-linked to an
//      archived parent. The barrier (wait until the re-link is provably waiting
//      on a lock) makes the interleaving deterministic rather than timing-based.
//   B. BARRIER-CONTROLLED SAME-EXPECTED-VERSION RACE. Two transaction-level
//      sessions invoke the same expected-version writer at the same version.
//      The winner holds the writer's target row lock (the RPC's `SELECT ...
//      FOR UPDATE`) open and uncommitted; the second attempt is proven to be
//      WAITING on that exact lock (pg_blocking_pids reports the winner's pid)
//      before the winner commits. The loser then observes the advanced version
//      and is rejected with PT409. This proves the attempts genuinely overlap
//      and yields exactly one commit (one version bump, one audit event) and
//      exactly one PT409 rejection, for both the application and the student
//      writer.
// ---------------------------------------------------------------------------

/** Set the transaction-local Supabase JWT claims a raw pg session authenticates as. */
async function setJwtClaims(
  client: Client,
  userId: string,
  appMetadata: Record<string, unknown> = {}
): Promise<void> {
  const claims = JSON.stringify({ sub: userId, role: "authenticated", app_metadata: appMetadata });
  await client.query("SELECT set_config('request.jwt.claims', $1, true)", [claims]);
}

/** Poll until `pid` is provably waiting on a lock, or fail the barrier. */
async function waitUntilBlocked(pid: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await pool.query<{ blocked: boolean }>(
      "SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked",
      [pid]
    );
    if (rows[0]?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`session ${pid} never blocked on the prospective parent lock`);
}

/**
 * Poll until `pid` is provably blocked by `blockerPid` specifically, or fail
 * the barrier. Proving the blocker identity (not merely that some lock wait
 * exists) is what ties the wait to the winner's writer row lock.
 */
async function waitUntilBlockedBy(
  pid: number,
  blockerPid: number,
  timeoutMs = 10_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await pool.query<{ blockers: number[] }>(
      "SELECT pg_blocking_pids($1) AS blockers",
      [pid]
    );
    if ((rows[0]?.blockers ?? []).includes(blockerPid)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `session ${pid} never blocked on session ${blockerPid}'s writer row lock`
  );
}

/**
 * Barrier-controlled same-expected-version race for one expected-version writer.
 *
 * Proves two concurrent attempts genuinely overlap and that the loser waits on
 * the winner's writer row lock before it is rejected:
 *
 *   1. The first transaction-level session authenticates as staff A and invokes
 *      the writer at the shared expected version. The writer's `SELECT ... FOR
 *      UPDATE` acquires the target row lock and mutates the row, but the
 *      session does NOT commit — the row lock is held open.
 *   2. The second session authenticates as staff B and invokes the SAME writer
 *      at the SAME expected version. It must block on the first session's row
 *      lock.
 *   3. The barrier proceeds only once the second session is provably waiting on
 *      the FIRST session specifically (`pg_blocking_pids`), so the overlap and
 *      the lock wait are observed rather than assumed.
 *   4. The first session commits; the second unblocks, reads the advanced
 *      version, and is rejected with PT409 (its transaction rolls back with no
 *      mutation, no version bump, and no audit event).
 *
 * Returns the second session's SQLSTATE so the caller can assert exactly one
 * PT409. `invokeFirst`/`invokeSecond` must issue the writer call on the given
 * session (the caller supplies the per-entity SQL/args).
 */
async function runBarrierControlledSameVersionRace(
  invokeFirst: (client: Client) => Promise<unknown>,
  invokeSecond: (client: Client) => Promise<unknown>
): Promise<{ secondCode: string | undefined }> {
  const first = new Client({ connectionString: env.dbUrl });
  const second = new Client({ connectionString: env.dbUrl });
  await first.connect();
  await second.connect();
  try {
    const firstPid = (await first.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]
      .pid;
    const secondPid = (await second.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]
      .pid;

    // Winner: open a transaction, authenticate, and invoke the writer at the
    // shared expected version. The writer takes the target row lock and writes,
    // but the session stays open so the lock is held.
    await first.query("BEGIN");
    await setJwtClaims(first, staffA.userId);
    await invokeFirst(first);

    // Loser: open a transaction, authenticate, and invoke the SAME writer at
    // the SAME expected version. It must block on the winner's row lock.
    await second.query("BEGIN");
    await setJwtClaims(second, staffB.userId);
    const secondPromise = invokeSecond(second);
    // Keep the pending rejection handled while the barrier is held.
    secondPromise.catch(() => {});

    // BARRIER: proceed only once the loser is provably waiting on the winner's
    // writer row lock — the overlap is deterministic, never timing-based.
    await waitUntilBlockedBy(secondPid, firstPid);

    // Release the winner: its mutation is the single committed write.
    await first.query("COMMIT");

    // The loser now observes the advanced version and is rejected as stale.
    const secondError = await secondPromise.then(
      () => null,
      (error: { code?: string }) => error
    );
    await second.query("ROLLBACK");

    return { secondCode: secondError?.code };
  } finally {
    await first.end().catch(() => {});
    await second.end().catch(() => {});
  }
}

describe("concurrent archive cannot re-link an application to an archived parent (barrier-controlled)", () => {
  it("blocks the re-link on the prospective parent lock and rejects it once the archive commits", async () => {
    const { applicationId, studentId: originalStudent, fellowshipId } =
      await seedApplication("archive-relink-race");
    // A second, currently-active student that the re-link will target.
    const targetStudent = await seedStudent("archive-relink-race-target");

    const archiveClient = new Client({ connectionString: env.dbUrl });
    const relinkClient = new Client({ connectionString: env.dbUrl });
    await archiveClient.connect();
    await relinkClient.connect();
    try {
      // Archive the target student in an OPEN transaction: it locks the student
      // row FOR UPDATE and sets archived_at, but does NOT commit yet.
      await archiveClient.query("BEGIN");
      await setJwtClaims(archiveClient, adminActor.userId, { ocf_admin: true });
      await archiveClient.query(
        "SELECT * FROM public.lifecycle_transition($1, $2, $3, $4, $5)",
        ["student", "archive", targetStudent, "contract archive-vs-relink", 1]
      );

      // Concurrently re-link the application to that same student in an OPEN
      // transaction. It must block on the student row lock.
      await relinkClient.query("BEGIN");
      await setJwtClaims(relinkClient, staffA.userId);
      const relinkPid = (
        await relinkClient.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
      ).rows[0].pid;
      const relinkPromise = relinkClient.query(
        "SELECT * FROM public.update_application($1, $2, $3, $4, $5, $6, $7, $8, $9)",
        [
          applicationId,
          1,
          targetStudent,
          fellowshipId,
          2026,
          "Testland",
          "Submitted",
          false,
          false,
        ]
      );
      // Keep the pending rejection handled while the barrier is held.
      relinkPromise.catch(() => {});

      // BARRIER: proceed only once the re-link is provably waiting on the parent
      // lock, so the archive-commits-then-relink-observes interleaving is
      // deterministic rather than timing-dependent.
      await waitUntilBlocked(relinkPid);

      // Release the archive: committing makes the target student archived.
      await archiveClient.query("COMMIT");

      // The re-link now observes the archived parent and is rejected; nothing is
      // written (its transaction is rolled back).
      await expect(relinkPromise).rejects.toMatchObject({ code: "42501" });
      await relinkClient.query("ROLLBACK");

      // The application still references its original student: the archived
      // target was never linked.
      const { rows } = await pool.query<{ student_id: number }>(
        "SELECT student_id FROM public.application WHERE application_id = $1",
        [applicationId]
      );
      expect(rows[0].student_id, "the denied re-link never committed").toBe(originalStudent);

      // The denied re-link recorded no application event; the archive is the
      // only committed change.
      expect(
        (await readAudit("application", applicationId)).filter((e) => e.action === "updated"),
        "a denied re-link records no application event"
      ).toHaveLength(0);
      const { rows: archivedRows } = await pool.query<{ archived_at: string | null }>(
        "SELECT archived_at FROM public.student WHERE student_id = $1",
        [targetStudent]
      );
      expect(archivedRows[0].archived_at, "the archive committed").not.toBeNull();
    } finally {
      await archiveClient.end().catch(() => {});
      await relinkClient.end().catch(() => {});
    }
  });
});

describe("barrier-controlled same-expected-version races commit exactly once", () => {
  it("application: concurrent attempts overlap; the loser waits on the row lock, exactly one commits, one PT409", async () => {
    const { applicationId, studentId, fellowshipId } = await seedApplication("simultaneous-app");

    // Both sessions invoke the SAME writer at the SAME (current) expected
    // version 1 via raw transaction-level connections.
    const invokeApplication = (client: Client, destinationCountry: string) =>
      client.query(
        "SELECT * FROM public.update_application($1, $2, $3, $4, $5, $6, $7, $8, $9)",
        [
          applicationId,
          1,
          studentId,
          fellowshipId,
          2026,
          destinationCountry,
          "Submitted",
          false,
          false,
        ]
      );

    const { secondCode } = await runBarrierControlledSameVersionRace(
      (client) => invokeApplication(client, "Race Alpha"),
      (client) => invokeApplication(client, "Race Beta")
    );

    // The blocked attempt observed the version the winner committed and was
    // rejected as stale — exactly one PT409, no second mutation.
    expect(secondCode, "the blocked application writer observes a stale version").toBe("PT409");

    // Exactly one version bump and one audit event for the single commit.
    const after = await readRowState("application", "application_id", applicationId);
    expect(after.row_version, "exactly one version bump").toBe(2);
    const { rows } = await pool.query<{ destination_country: string | null }>(
      "SELECT destination_country FROM public.application WHERE application_id = $1",
      [applicationId]
    );
    expect(rows[0].destination_country, "the winner's value is the committed one").toBe("Race Alpha");
    expect(
      (await readAudit("application", applicationId)).filter((e) => e.action === "updated"),
      "exactly one updated audit event for the single commit"
    ).toHaveLength(1);
  });

  it("student: concurrent attempts overlap; the loser waits on the row lock, exactly one commits, one PT409", async () => {
    const studentId = await seedStudent("simultaneous-student");
    const winner = baseStudentPayload();
    const loser = baseStudentPayload();

    const invokeStudent = (client: Client, payload: StudentProfilePayload) =>
      client.query(
        `SELECT * FROM public.update_student_profile(
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17
         )`,
        [
          studentId,
          1,
          payload.full_name,
          payload.email,
          payload.is_ch_student,
          payload.major,
          payload.minor,
          payload.gpa,
          payload.class_standing,
          payload.us_citizen,
          payload.age,
          payload.gender,
          payload.pronouns,
          payload.race_ethnicity,
          payload.languages,
          payload.first_gen,
          payload.honors_college,
        ]
      );

    const { secondCode } = await runBarrierControlledSameVersionRace(
      (client) => invokeStudent(client, winner),
      (client) => invokeStudent(client, loser)
    );

    expect(secondCode, "the blocked student writer observes a stale version").toBe("PT409");

    // Exactly one version bump and one audit event for the single commit.
    const after = await readRowState("student", "student_id", studentId);
    expect(after.row_version, "exactly one version bump").toBe(2);
    const { rows } = await pool.query<{ full_name: string }>(
      "SELECT full_name FROM public.student WHERE student_id = $1",
      [studentId]
    );
    expect(rows[0].full_name, "the winner's value is the committed one").toBe(winner.full_name);
    expect(
      (await readAudit("student", studentId)).filter((e) => e.action === "updated"),
      "exactly one updated audit event for the single commit"
    ).toHaveLength(1);
  });
});