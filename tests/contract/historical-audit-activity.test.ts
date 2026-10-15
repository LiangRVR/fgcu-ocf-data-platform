/**
 * tests/contract/historical-audit-activity.test.ts
 *
 * Database contract coverage for migration
 * 20261015000002_historical_audit_activity (historical-audit-timeline Plan
 * Work 2): the immutable audit extension for historical base/amendment records
 * and the explicit-column, SECURITY INVOKER activity read view.
 *
 * Proves, against the fresh isolated Docker-local contract lane:
 *
 *   - R5  BASE RECORD EVENTS: an INSERT into `advising_meeting`,
 *        `fellowship_thursday`, or `scholarship_history` emits EXACTLY ONE
 *        `created` `audit_event` in the source transaction with only the
 *        explicit structural snapshot (never narrative content) and the
 *        subject student/fellowship context; an authenticated active-advisor
 *        session attributes it (origin `user`, frozen actor-name snapshot)
 *        while a technical/service-role session records System/system.
 *   - R5  AMENDMENT EVENTS: an INSERT into each amendment table emits EXACTLY
 *        ONE `correction_added` event (a Scholarship History `Void` →
 *        `voided`) with only structural amendment context and the subject
 *        resolved from the parent base record.
 *   - R5  PRIVACY EXCLUSIONS: `notes` (advising meetings), amendment
 *        `reason`/`details`, credentials, and any Auth/private/technical
 *        column never enter a payload — every event's `new_values` is exactly
 *        the documented structural allowlist.
 *   - R11 ACTIVITY VIEW SCHEMA/GRANTS: `public.audit_activity` is a SECURITY
 *        INVOKER view exposing exactly the documented explicit columns (no
 *        Auth binding, private fields, or raw audit JSON payloads —
 *        `old_values`/`new_values`/`changes` are NOT selectable through the
 *        authenticated projection), grants authenticated SELECT only, and
 *        revokes anon.
 *   - R12 ACTIVITY VIEW RLS/DATASET: the underlying active-advisor audit RLS
 *        applies THROUGH the view (an authenticated active advisor sees the
 *        seeded timeline; an authenticated user with no advisor row and an
 *        inactive-bound user see zero rows; anon is outright denied).
 *        Display-safe student/fellowship labels resolve, `actor_name_snapshot`
 *        is the frozen actor (never a current join), exact-count filtering
 *        over the RLS-filtered dataset stays parity-correct, and
 *        `occurred_at DESC` order yields a newest-first chronology.
 *
 * Service role is used strictly for local fixture seeding, auth-user creation,
 * the admin pre-bind, and persisted-state oracle re-reads (never asserted as
 * an access grant).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
// Fixture helpers (file-local)
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
  const { data, error } = await service
    .from("advisor")
    .insert({ advisor_name: advisorName, email, is_active: isActive })
    .select("advisor_id")
    .single();
  if (error) throw new Error(`seed advisor ${advisorName}: ${error.message}`);
  return data.advisor_id as number;
}

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

/** An authenticated user with NO advisor row at all. */
async function createNoAdvisorActor(label: string): Promise<Actor> {
  const tag = nextUnique(label);
  const email = syntheticEmail(tag);
  const userId = await createAuthUser(service, email);
  const client = freshClient();
  const signed = await signInWithPassword(client, email);
  if (signed !== userId) throw new Error(`${label} sign-in returned a different user`);
  return { userId, email, advisorName: "", client, advisorId: -1 };
}

interface StudentSeed {
  studentId: number;
  fullName: string;
}

async function seedStudent(label: string): Promise<StudentSeed> {
  const tag = nextUnique(label);
  const fullName = syntheticName(tag);
  const { data, error } = await service
    .from("student")
    .insert({ full_name: fullName, email: syntheticEmail(tag), us_citizen: true })
    .select("student_id")
    .single();
  if (error) throw new Error(`seed student: ${error.message}`);
  return { studentId: data.student_id as number, fullName };
}

interface FellowshipSeed {
  fellowshipId: number;
  fellowshipName: string;
}

async function seedFellowship(label: string): Promise<FellowshipSeed> {
  const tag = nextUnique(label);
  const fellowshipName = syntheticName(tag);
  const { data, error } = await service
    .from("fellowship")
    .insert({ fellowship_name: fellowshipName })
    .select("fellowship_id")
    .single();
  if (error) throw new Error(`seed fellowship: ${error.message}`);
  return { fellowshipId: data.fellowship_id as number, fellowshipName };
}

// ---------------------------------------------------------------------------
// Audit oracle + typed view adapter
// ---------------------------------------------------------------------------

interface AuditRow {
  audit_id: number;
  entity_type: string;
  entity_id: number;
  action: string;
  actor_advisor_id: number | null;
  actor_name_snapshot: string;
  occurred_at: string;
  new_values: Record<string, unknown> | null;
  reason: string | null;
  subject_student_id: number | null;
  subject_application_id: number | null;
  subject_fellowship_id: number | null;
  origin: string;
}

async function readAudit(entityType: string, entityId: number): Promise<AuditRow[]> {
  const { rows } = await pool.query<AuditRow>(
    `SELECT audit_id, entity_type, entity_id, action, actor_advisor_id,
            actor_name_snapshot, occurred_at, new_values, reason,
            subject_student_id, subject_application_id, subject_fellowship_id, origin
       FROM public.audit_event
      WHERE entity_type = $1 AND entity_id = $2
      ORDER BY audit_id`,
    [entityType, entityId]
  );
  return rows;
}

/** Exact documented structural payload keys per historical entity. */
const EXPECTED_PAYLOAD_KEYS: Record<string, string[]> = {
  advising_meeting: ["advisor_id", "application_id", "meeting_date", "meeting_id", "meeting_mode", "no_show", "student_id"].sort(),
  advising_meeting_amendment: ["amendment_id", "meeting_id"].sort(),
  fellowship_thursday: ["attendance_id", "attended", "event_date", "source_info", "student_id"].sort(),
  fellowship_thursday_amendment: ["amendment_id", "attendance_id", "corrected_attended", "corrected_source_info", "corrects_source_info"].sort(),
  scholarship_history: ["award_year", "fellowship_id", "history_id", "student_id"].sort(),
  scholarship_history_amendment: ["amendment_id", "amendment_type", "corrected_fellowship_id", "history_id"].sort(),
};

/** Narrative/private keys that must NEVER appear in any structural payload. */
const FORBIDDEN_PAYLOAD_KEYS = [
  // narrative / reason / detail content
  "notes",
  "reason",
  "details",
  // credentials / auth / technical surface
  "credentials",
  "token",
  "password",
  "auth_user_id",
  "last_login_at",
  "created_at",
  "updated_at",
  "row_version",
];

function assertPayloadExactly(entityType: string, newValues: Record<string, unknown> | null, label: string): void {
  expect(newValues, `${label} must carry a structural snapshot`).not.toBeNull();
  expect(
    Object.keys(newValues ?? {}).sort(),
    `${label} must be exactly the ${entityType} structural allowlist`
  ).toEqual(EXPECTED_PAYLOAD_KEYS[entityType]);
  for (const forbidden of FORBIDDEN_PAYLOAD_KEYS) {
    expect(newValues, `${label} must never contain ${forbidden}`).not.toHaveProperty(forbidden);
  }
}

/**
 * Minimal untyped PostgREST accessor for `audit_activity` (the view is not in
 * the committed generated types; the adapter keeps the assertions typed).
 */
interface UntypedActivityResult {
  data: Array<Record<string, unknown>> | null;
  error: { code?: string; message?: string } | null;
  count: number | null;
}

interface UntypedActivityQuery extends PromiseLike<UntypedActivityResult> {
  eq(column: string, value: unknown): UntypedActivityQuery;
  in(column: string, values: readonly unknown[]): UntypedActivityQuery;
  order(column: string, options?: { ascending?: boolean }): UntypedActivityQuery;
  range(from: number, to: number): UntypedActivityQuery;
  limit(count: number): UntypedActivityQuery;
}

interface UntypedActivityClient {
  from(table: string): {
    select(columns?: string, options?: { count?: "exact" }): UntypedActivityQuery;
  };
}

function activityClient(client: SupabaseClient): UntypedActivityClient {
  return client as unknown as UntypedActivityClient;
}

/**
 * REAL authenticated TRUNCATE attempt. `SET LOCAL ROLE authenticated` mirrors
 * the exact PostgREST request role, and the attempt runs inside a transaction
 * that is ALWAYS rolled back — so even an unexpected grant could never destroy
 * history. Returns the rejection SQLSTATE (undefined when it was NOT denied).
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

/**
 * Historical tables whose TRUNCATE privilege is EXPLICITLY revoked from the
 * normal request roles by an applied migration, so a real denial is guaranteed
 * and safe to assert:
 *   - `20261008000001_historical_integrity_remediation.sql` revokes TRUNCATE on
 *     `fellowship_thursday`, `scholarship_history`,
 *     `fellowship_thursday_amendment`, and `scholarship_history_amendment`.
 *   - `20261017000001_revoke_advising_meeting_truncate.sql` closes the same
 *     normal-role bypass on `advising_meeting` and
 *     `advising_meeting_amendment`, which the append-only hardening had left
 *     TRUNCATE-able through the local Supabase default grants.
 */
const HISTORICAL_TRUNCATE_REVOKED_TABLES = [
  "advising_meeting",
  "advising_meeting_amendment",
  "fellowship_thursday",
  "fellowship_thursday_amendment",
  "scholarship_history",
  "scholarship_history_amendment",
] as const;

// ---------------------------------------------------------------------------
// Suite state
// ---------------------------------------------------------------------------

let staff: Actor;
let noAdvisor: Actor;
let inactiveBound: Actor;

let student: StudentSeed;
let fellowship: FellowshipSeed;
let secondaryFellowship: FellowshipSeed;

/** Ids of base/amendment rows Inserted as authenticated for attribution. */
const authenticatedHistoryIds: Array<{ entityType: string; entityId: number }> = [];

beforeAll(async () => {
  pool = createDbPool(env);
  staff = await createBoundActor("activity-staff");
  noAdvisor = await createNoAdvisorActor("activity-no-advisor");
  inactiveBound = await createBoundActor("activity-inactive", false, false);

  student = await seedStudent("activity-student");
  fellowship = await seedFellowship("activity-fellowship");
  secondaryFellowship = await seedFellowship("activity-secondary");
}, 60_000);

afterAll(async () => {
  if (pool) await pool.end();
});

// ---------------------------------------------------------------------------
// R5: base record created events
// ---------------------------------------------------------------------------

describe("historical base-record audit events (R5)", () => {
  it("emits exactly one attributed advising_meeting/created event with a structural snapshot (never notes)", async () => {
    const { data, error } = await staff.client
      .from("advising_meeting")
      .insert({
        student_id: student.studentId,
        advisor_id: staff.advisorId,
        meeting_date: "2026-09-10",
        meeting_mode: "Virtual",
        no_show: false,
        notes: "Contract narrative note that must never enter an audit payload",
      })
      .select("meeting_id")
      .single();
    expect(error, "authenticated advising_meeting INSERT").toBeNull();
    const meetingId = data!.meeting_id as number;
    authenticatedHistoryIds.push({ entityType: "advising_meeting", entityId: meetingId });

    const events = await readAudit("advising_meeting", meetingId);
    expect(events, "exactly one created event per base INSERT").toHaveLength(1);
    const event = events[0];
    expect(event.action).toBe("created");
    expect(event.origin).toBe("user");
    expect(event.actor_advisor_id, "attributed to the authenticated active advisor").toBe(
      staff.advisorId
    );
    expect(event.actor_name_snapshot).toBe(staff.advisorName);
    expect(event.subject_student_id).toBe(student.studentId);
    expect(event.subject_application_id).toBeNull();
    assertPayloadExactly("advising_meeting", event.new_values, "advising_meeting created");
    expect(event.new_values).toMatchObject({
      meeting_id: meetingId,
      student_id: student.studentId,
      advisor_id: staff.advisorId,
      meeting_date: "2026-09-10",
      meeting_mode: "Virtual",
      no_show: false,
    });
  });

  it("emits exactly one attributed fellowship_thursday/created event", async () => {
    const { data, error } = await staff.client
      .from("fellowship_thursday")
      .insert({ student_id: student.studentId, attended: true, source_info: "OCF", event_date: "2026-09-03" })
      .select("attendance_id")
      .single();
    expect(error, "authenticated fellowship_thursday INSERT").toBeNull();
    const attendanceId = data!.attendance_id as number;
    authenticatedHistoryIds.push({ entityType: "fellowship_thursday", entityId: attendanceId });

    const events = await readAudit("fellowship_thursday", attendanceId);
    expect(events, "exactly one created event").toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "created",
      origin: "user",
      actor_advisor_id: staff.advisorId,
      actor_name_snapshot: staff.advisorName,
      subject_student_id: student.studentId,
    });
    assertPayloadExactly("fellowship_thursday", events[0].new_values, "fellowship_thursday created");
    expect(events[0].new_values).toMatchObject({
      attendance_id: attendanceId,
      student_id: student.studentId,
      attended: true,
      source_info: "OCF",
    });
  });

  it("emits exactly one attributed scholarship_history/created event with subject fellowship context", async () => {
    const { data, error } = await staff.client
      .from("scholarship_history")
      .insert({ student_id: student.studentId, fellowship_id: fellowship.fellowshipId, award_year: 2026 })
      .select("history_id")
      .single();
    expect(error, "authenticated scholarship_history INSERT").toBeNull();
    const historyId = data!.history_id as number;
    authenticatedHistoryIds.push({ entityType: "scholarship_history", entityId: historyId });

    const events = await readAudit("scholarship_history", historyId);
    expect(events, "exactly one created event").toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "created",
      origin: "user",
      actor_advisor_id: staff.advisorId,
      actor_name_snapshot: staff.advisorName,
      subject_student_id: student.studentId,
      subject_fellowship_id: fellowship.fellowshipId,
    });
    assertPayloadExactly("scholarship_history", events[0].new_values, "scholarship_history created");
    expect(events[0].new_values).toMatchObject({
      history_id: historyId,
      student_id: student.studentId,
      fellowship_id: fellowship.fellowshipId,
    });
  });

  it("records a service-role base INSERT as exactly one System/system created event", async () => {
    const { data, error } = await service
      .from("fellowship_thursday")
      .insert({ student_id: student.studentId, attended: false, source_info: "HC" })
      .select("attendance_id")
      .single();
    expect(error, "service-role fellowship_thursday INSERT").toBeNull();
    const attendanceId = data!.attendance_id as number;

    const events = await readAudit("fellowship_thursday", attendanceId);
    expect(events, "one system event").toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "created",
      origin: "system",
      actor_advisor_id: null,
      actor_name_snapshot: "System",
      subject_student_id: student.studentId,
    });
    assertPayloadExactly("fellowship_thursday", events[0].new_values, "system fellowship_thursday");
  });
});

// ---------------------------------------------------------------------------
// R5: amendment records → correction_added / voided
// ---------------------------------------------------------------------------

describe("historical amendment audit events (R5)", () => {
  it("emits exactly one advising_meeting_amendment/correction_added event with the structural amendment allowlist", async () => {
    const { data: meeting } = await staff.client
      .from("advising_meeting")
      .insert({
        student_id: student.studentId,
        advisor_id: staff.advisorId,
        meeting_date: "2026-09-11",
        meeting_mode: "In-Person",
        no_show: false,
      })
      .select("meeting_id")
      .single();
    const meetingId = meeting!.meeting_id as number;

    const { data, error } = await staff.client
      .from("advising_meeting_amendment")
      .insert({
        meeting_id: meetingId,
        reason: "Contract amendment reason that must never be audited",
        details: "Contract amendment details that must never be audited",
      })
      .select("amendment_id")
      .single();
    expect(error, "authenticated advising_meeting_amendment INSERT").toBeNull();
    const amendmentId = data!.amendment_id as number;

    const events = await readAudit("advising_meeting_amendment", amendmentId);
    expect(events, "exactly one correction_added event").toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "correction_added",
      origin: "user",
      actor_advisor_id: staff.advisorId,
      // subject resolved from the parent meeting
      subject_student_id: student.studentId,
      subject_application_id: null,
    });
    assertPayloadExactly(
      "advising_meeting_amendment",
      events[0].new_values,
      "advising_meeting_amendment correction_added"
    );
    expect(events[0].new_values).toMatchObject({ amendment_id: amendmentId, meeting_id: meetingId });
  });

  it("emits exactly one fellowship_thursday_amendment/correction_added event with the structural correction fields", async () => {
    const { data: attendance } = await staff.client
      .from("fellowship_thursday")
      .insert({ student_id: student.studentId, attended: true, source_info: "OCF", event_date: "2026-09-03" })
      .select("attendance_id")
      .single();
    const attendanceId = attendance!.attendance_id as number;

    const { data, error } = await staff.client
      .from("fellowship_thursday_amendment")
      .insert({
        attendance_id: attendanceId,
        reason: "Contract attendance correction reason (never audited)",
        corrects_source_info: true,
        corrected_source_info: "HC",
        corrected_attended: false,
      })
      .select("amendment_id")
      .single();
    expect(error, "authenticated fellowship_thursday_amendment INSERT").toBeNull();
    const amendmentId = data!.amendment_id as number;

    const events = await readAudit("fellowship_thursday_amendment", amendmentId);
    expect(events, "exactly one correction_added event").toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "correction_added",
      origin: "user",
      actor_advisor_id: staff.advisorId,
      subject_student_id: student.studentId,
    });
    assertPayloadExactly(
      "fellowship_thursday_amendment",
      events[0].new_values,
      "fellowship_thursday_amendment correction_added"
    );
    expect(events[0].new_values).toMatchObject({
      amendment_id: amendmentId,
      attendance_id: attendanceId,
      corrected_attended: false,
      corrects_source_info: true,
      corrected_source_info: "HC",
    });
  });

  it("classifies a Scholarship History Correction as correction_added and a Void as voided, each with exactly one event", async () => {
    const { data: history } = await staff.client
      .from("scholarship_history")
      .insert({ student_id: student.studentId, fellowship_id: fellowship.fellowshipId, award_year: 2026 })
      .select("history_id")
      .single();
    const historyId = history!.history_id as number;

    const { data: correction, error: correctionError } = await staff.client
      .from("scholarship_history_amendment")
      .insert({
        history_id: historyId,
        amendment_type: "Correction",
        reason: "Contract correction reason (never audited)",
        corrected_fellowship_id: secondaryFellowship.fellowshipId,
      })
      .select("amendment_id")
      .single();
    expect(correctionError, "scholarship correction INSERT").toBeNull();
    const correctionId = correction!.amendment_id as number;

    const correctionEvents = await readAudit("scholarship_history_amendment", correctionId);
    expect(correctionEvents, "exactly one correction_added event").toHaveLength(1);
    expect(correctionEvents[0]).toMatchObject({
      action: "correction_added",
      origin: "user",
      actor_advisor_id: staff.advisorId,
      subject_student_id: student.studentId,
      subject_fellowship_id: fellowship.fellowshipId,
    });
    assertPayloadExactly(
      "scholarship_history_amendment",
      correctionEvents[0].new_values,
      "scholarship_history_amendment correction_added"
    );
    expect(correctionEvents[0].new_values).toMatchObject({
      amendment_id: correctionId,
      history_id: historyId,
      amendment_type: "Correction",
      corrected_fellowship_id: secondaryFellowship.fellowshipId,
    });

    const { data: voidAmendment, error: voidError } = await staff.client
      .from("scholarship_history_amendment")
      .insert({
        history_id: historyId,
        amendment_type: "Void",
        reason: "Contract void reason (never audited)",
      })
      .select("amendment_id")
      .single();
    expect(voidError, "scholarship void INSERT").toBeNull();
    const voidId = voidAmendment!.amendment_id as number;

    const voidEvents = await readAudit("scholarship_history_amendment", voidId);
    expect(voidEvents, "a Void amendment is classified voided, exactly one event").toHaveLength(1);
    expect(voidEvents[0].action).toBe("voided");
    assertPayloadExactly(
      "scholarship_history_amendment",
      voidEvents[0].new_values,
      "scholarship_history_amendment voided"
    );
    expect(voidEvents[0].new_values).toMatchObject({
      amendment_id: voidId,
      history_id: historyId,
      amendment_type: "Void",
      corrected_fellowship_id: null,
    });
  });
});

// ---------------------------------------------------------------------------
// R5/R6: structural privacy — narrative/amendment content never audited
// ---------------------------------------------------------------------------

describe("historical payload privacy exclusions (R5/R6)", () => {
  it("never leaks meeting notes or amendment reason/details into any event payload", async () => {
    // The suite deliberately Inserted narrative-rich rows above; now assert the
    // invariants over every event created for this run's historically-inserted
    // rows (both base records and amendments).
    for (const { entityType, entityId } of authenticatedHistoryIds) {
      for (const event of await readAudit(entityType, entityId)) {
        assertPayloadExactly(entityType, event.new_values, `${entityType}#${entityId} ${event.action}`);
        expect(String(JSON.stringify(event.new_values))).not.toMatch(
          /narrative|must never|Contract/i
        );
      }
    }
    // Explicit per-row checks using the narrative-rich seeds from the tests above.
    const { rows } = await pool.query<{ new_values: Record<string, unknown> | null }>(
      `SELECT new_values
         FROM public.audit_event
        WHERE entity_type = 'advising_meeting'
          AND action = 'created'
        ORDER BY audit_id DESC
        LIMIT 5`
    );
    for (const row of rows) {
      expect(row.new_values).not.toHaveProperty("notes");
    }
  });
});

// ---------------------------------------------------------------------------
// R3: immutable historical history denies a REAL authenticated TRUNCATE
// ---------------------------------------------------------------------------

describe("immutable historical history denies a REAL authenticated TRUNCATE (R3)", () => {
  it("rejects authenticated TRUNCATE on every table whose grant is explicitly revoked and removes no row", async () => {
    const snapshot = async (): Promise<Record<string, number>> => {
      const out: Record<string, number> = {};
      for (const table of HISTORICAL_TRUNCATE_REVOKED_TABLES) {
        const { rows } = await pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM public.${table}`
        );
        out[table] = rows[0].n;
      }
      return out;
    };

    const before = await snapshot();
    expect(
      Object.values(before).some((n) => n > 0),
      "immutable history rows exist to protect"
    ).toBe(true);

    // Execute the attempt as the EXACT `authenticated` request role — not a
    // catalog-privilege proxy.
    for (const table of HISTORICAL_TRUNCATE_REVOKED_TABLES) {
      const code = await authenticatedTruncateCode(table);
      expect(code, `authenticated TRUNCATE of ${table} must be denied with 42501`).toBe("42501");
    }

    const after = await snapshot();
    for (const table of HISTORICAL_TRUNCATE_REVOKED_TABLES) {
      expect(after[table], `${table} row count did not decrease`).toBeGreaterThanOrEqual(before[table]);
    }
  });
});

// ---------------------------------------------------------------------------
// R11/R12: activity view — schema, grants, RLS, labels, order, filters
// ---------------------------------------------------------------------------

describe("audit_activity view: schema and grants (R11)", () => {
  it("is a SECURITY INVOKER read view with exactly the documented explicit columns", async () => {
    const { rows: viewRows } = await pool.query(
      `SELECT c.relname, c.relkind, c.reloptions
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'audit_activity'`
    );
    expect(viewRows, "audit_activity view exists").toHaveLength(1);
    expect(viewRows[0].relkind).toBe("v");
    expect(String(viewRows[0].reloptions ?? ""), "must be SECURITY INVOKER").toContain(
      "security_invoker"
    );

    const { rows } = await pool.query(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'audit_activity'
        ORDER BY ordinal_position`
    );
    expect(rows.map((r) => r.column_name)).toEqual([
      "audit_id",
      "occurred_at",
      "entity_type",
      "entity_id",
      "action",
      "actor_advisor_id",
      "actor_name_snapshot",
      "reason",
      "origin",
      "subject_student_id",
      "subject_application_id",
      "subject_fellowship_id",
      "student_name",
      "fellowship_name",
      "student_subject_ids",
      "fellowship_subject_ids",
      "previous_student_name",
      "current_student_name",
      "previous_fellowship_name",
      "current_fellowship_name",
      "subject_application_name",
      "previous_student_id",
      "current_student_id",
      "previous_fellowship_id",
      "current_fellowship_id",
      "fellowship_thursday_attended_before",
      "fellowship_thursday_attended_after",
      "fellowship_thursday_attended_amended",
      "fellowship_thursday_source_before",
      "fellowship_thursday_source_after",
      "fellowship_thursday_source_amended",
      "void_reason",
      "advising_meeting_date",
      "advising_application_id",
      "advising_advisor_id",
    ]);
  });

  it("does NOT expose the raw audit JSON payload columns (browser-safe boundary)", async () => {
    const { rows } = await pool.query(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'audit_activity'
          AND column_name IN ('old_values', 'new_values', 'changes')`
    );
    expect(
      rows,
      "raw audit JSON must not be selectable through the app's authenticated projection"
    ).toHaveLength(0);

    // A real authenticated PostgREST attempt to select a raw payload column is
    // rejected (the column is not part of the browser-safe projection).
    const { data, error } = await activityClient(staff.client)
      .from("audit_activity")
      .select("changes")
      .limit(1);
    expect(data, "raw `changes` is not reachable through the projection").toBeNull();
    expect(error, "selecting raw `changes` through the projection must fail").not.toBeNull();
  });

  it("never exposes Auth-binding or private columns", async () => {
    const { rows } = await pool.query(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'audit_activity'
          AND column_name IN ('auth_user_id', 'notes', 'details', 'last_login_at',
                              'created_at', 'updated_at', 'row_version')`
    );
    expect(rows, "no Auth/private/technical column may appear on the activity view").toHaveLength(0);
  });

  it("grants authenticated SELECT only and revokes anon", async () => {
    const { rows } = await pool.query(
      `SELECT has_table_privilege('authenticated', 'public.audit_activity', 'SELECT') AS auth_select,
              has_table_privilege('authenticated', 'public.audit_activity', 'INSERT') AS auth_insert,
              has_table_privilege('authenticated', 'public.audit_activity', 'UPDATE') AS auth_update,
              has_table_privilege('authenticated', 'public.audit_activity', 'DELETE') AS auth_delete,
              has_table_privilege('anon', 'public.audit_activity', 'SELECT') AS anon_select`
    );
    expect(rows[0].auth_select, "authenticated SELECT on audit_activity").toBe(true);
    expect(rows[0].auth_insert, "authenticated INSERT must not be granted").toBe(false);
    expect(rows[0].auth_update, "authenticated UPDATE must not be granted").toBe(false);
    expect(rows[0].auth_delete, "authenticated DELETE must not be granted").toBe(false);
    expect(rows[0].anon_select, "anon SELECT must be revoked").toBe(false);
  });

  it("resolves labels and correction context in a single set-based statement (R10/NFR2)", async () => {
    const { rows } = await pool.query<{ def: string }>(
      `SELECT pg_get_viewdef('public.audit_activity'::regclass, true) AS def`
    );
    const def = String(rows[0].def).replace(/\s+/g, " ");

    // A single SQL statement returns event rows AND their labels/context, so a
    // history read is one round trip (no per-row N+1 follow-up query).
    expect(def, "reads the immutable audit event source").toMatch(/from\s+(?:public\.)?audit_event/i);
    expect(def, "student label comes from frozen subject snapshots").toMatch(/aes\.subject_type\s*=\s*'student'/i);
    expect(def, "fellowship label comes from frozen subject snapshots").toMatch(/aes\.subject_type\s*=\s*'fellowship'/i);
    expect(def, "relationship scalars read frozen subject snapshots").toMatch(/aes\.relationship\s*=\s*'previous'/i);
    expect(def, "application subject label reads the application association").toMatch(/aes\.subject_type\s*=\s*'application'/i);

    // Fellowship Thursday predecessor is set-based over the immutable base and
    // strictly-earlier amendments ordered by (created_at, amendment_id).
    expect(def, "FT predecessor ordered by (created_at, amendment_id)").toMatch(
      /a2\.created_at[^;]*a2\.amendment_id/i
    );
    // The exact Scholarship Void reason is bound to the event's own amendment id.
    expect(def, "void reason joined to the scholarship amendment").toMatch(
      /scholarship_history_amendment/i
    );
    // The immutable parent-meeting scalars are projected from the append-only
    // parent row, never from a mutable advisor/application join.
    expect(def, "advising parent scalars joined from the amendment").toMatch(
      /advising_meeting_amendment/i
    );
    expect(def, "no live advisor join").not.toMatch(/from\s+(?:public\.)?advisor\b/i);
    expect(def, "no live student join").not.toMatch(/from\s+(?:public\.)?student\b/i);
    expect(def, "no live free-text fellowship join").not.toMatch(/from\s+(?:public\.)?fellowship\s/i);
    expect(def, "no live Auth join").not.toMatch(/auth\.users/i);
  });
});

describe("audit_activity view: RLS applies through the view (R12)", () => {

  it("returns zero rows to an authenticated user with no advisor row (RLS round-trips)", async () => {
    const { data, error, count } = await activityClient(noAdvisor.client)
      .from("audit_activity")
      .select("audit_id", { count: "exact" });
    expect(error, "no-advisor read is RLS-filtered, never an error").toBeNull();
    expect(data ?? [], "no-advisor sees zero activity rows").toHaveLength(0);
    expect(count).toBe(0);
  });

  it("returns zero rows to a user bound to an INACTIVE advisor", async () => {
    const { data, error, count } = await activityClient(inactiveBound.client)
      .from("audit_activity")
      .select("audit_id", { count: "exact" });
    expect(error, "inactive-bound read is RLS-filtered, never an error").toBeNull();
    expect(data ?? [], "inactive-bound sees zero activity rows").toHaveLength(0);
    expect(count).toBe(0);
  });

  it("denies anon explicitly (no grant boundary)", async () => {
    const { data, error } = await activityClient(anon)
      .from("audit_activity")
      .select("audit_id");
    expect(data, "anon audit_activity read returns no rows").toBeNull();
    expect(error, "anon audit_activity read must be denied").not.toBeNull();
    expect(error?.code, "anon denial code").toBe("42501");
  });

  it("exposes the frozen actor snapshot and display-safe labels, never current joins or Auth fields", async () => {
    // Gather the scholarship_history events Inserted for this run's student.
    const { rows: oracle } = await pool.query<{ audit_id: number }>(
      `SELECT audit_id
         FROM public.audit_event
        WHERE entity_type = 'scholarship_history' AND entity_id = $1`,
      [authenticatedHistoryIds.find((r) => r.entityType === "scholarship_history")?.entityId ?? -1]
    );
    const auditIds = oracle.map((r) => r.audit_id);
    expect(auditIds.length, "this run produced at least one scholarship_history event").toBeGreaterThan(0);

    const view = await activityClient(staff.client)
      .from("audit_activity")
      .select("*")
      .in("audit_id", auditIds);
    expect(view.error, "active advisor activity read").toBeNull();
    expect(view.data ?? []).toHaveLength(auditIds.length);
    for (const row of view.data ?? []) {
      expect(row.actor_name_snapshot, "actor snapshot is frozen, never a live join").toBe(
        staff.advisorName
      );
      expect(row.origin).toBe("user");
      expect(row.entity_type).toBe("scholarship_history");
      expect(row.student_name, "display-safe student label resolves").toBe(student.fullName);
      expect(row.fellowship_name, "display-safe fellowship label resolves").toBe(
        fellowship.fellowshipName
      );
      expect(row, "no Auth-binding column on the resolved row").not.toHaveProperty("auth_user_id");
    }
  });

  it("orders newest-first by occurred_at DESC and keeps deterministic dataset parity", async () => {
    // Collect all events for the authenticated base records this run created.
    const { rows: oracle } = await pool.query<{ audit_id: number; occurred_at: string }>(
      `SELECT audit_id, occurred_at
         FROM public.audit_event
        WHERE (entity_type, entity_id) IN (
              SELECT * FROM unnest($1::text[], $2::int[]))
        ORDER BY occurred_at, audit_id`,
      [
        authenticatedHistoryIds.map((r) => r.entityType),
        authenticatedHistoryIds.map((r) => r.entityId),
      ]
    );
    expect(oracle.length, "multiple seeded events for the ordering assertion").toBeGreaterThanOrEqual(3);
    const auditIds = oracle.map((r) => r.audit_id);

    const result = await activityClient(staff.client)
      .from("audit_activity")
      .select("audit_id, occurred_at", { count: "exact" })
      .in("audit_id", auditIds)
      .order("occurred_at", { ascending: false });
    expect(result.error, "ordered activity read").toBeNull();
    expect(result.count, "exact-count parity with the RLS-filtered dataset").toBe(auditIds.length);
    const rows = result.data ?? [];
    expect(rows, "the ordered dataset carries every expected audit id").toHaveLength(auditIds.length);
    expect(
      new Set(rows.map((r) => String(r.audit_id))),
      "the ordered dataset is exactly the oracle audit set"
    ).toEqual(new Set(auditIds));

    const timestamps = rows.map((r) => new Date(String(r.occurred_at)).getTime());
    for (let i = 1; i < timestamps.length; i += 1) {
      expect(
        timestamps[i],
        "occurred_at DESC must be non-increasing (newest-first chronology)"
      ).toBeLessThanOrEqual(timestamps[i - 1]);
    }
  });

  it("paginates the RLS-filtered dataset in bounded, disjoint, ordered pages (R10/NFR1)", async () => {
    // Seed two extra attributed events so the assertion always spans two full
    // bounded pages regardless of how many rows the earlier describes created.
    for (let i = 0; i < 2; i += 1) {
      const { data, error } = await staff.client
        .from("fellowship_thursday")
        .insert({ student_id: student.studentId, attended: i % 2 === 0, source_info: "OCF", event_date: "2026-09-24" })
        .select("attendance_id")
        .single();
      expect(error, "paging seed insert").toBeNull();
      authenticatedHistoryIds.push({
        entityType: "fellowship_thursday",
        entityId: data!.attendance_id as number,
      });
    }

    const { rows: oracle } = await pool.query<{ audit_id: number }>(
      `SELECT audit_id
         FROM public.audit_event
        WHERE (entity_type, entity_id) IN (SELECT * FROM unnest($1::text[], $2::int[]))
        ORDER BY occurred_at DESC, audit_id DESC`,
      [
        authenticatedHistoryIds.map((r) => r.entityType),
        authenticatedHistoryIds.map((r) => r.entityId),
      ]
    );
    expect(oracle.length, "multiple events for the paging assertion").toBeGreaterThanOrEqual(4);
    const allIds = oracle.map((r) => Number(r.audit_id));
    const pageSize = 2;

    const loadPage = async (from: number) => {
      const result = await activityClient(staff.client)
        .from("audit_activity")
        .select("audit_id, occurred_at", { count: "exact" })
        .in("audit_id", allIds)
        .order("occurred_at", { ascending: false })
        .order("audit_id", { ascending: false })
        .range(from, from + pageSize - 1);
      expect(result.error, "paged activity read").toBeNull();
      return result;
    };

    const page1 = await loadPage(0);
    const page2 = await loadPage(pageSize);
    expect(page1.count, "exact count parity across all pages").toBe(allIds.length);
    expect(page2.count, "exact count parity across all pages").toBe(allIds.length);

    const page1Ids = (page1.data ?? []).map((r) => Number(r.audit_id));
    const page2Ids = (page2.data ?? []).map((r) => Number(r.audit_id));
    expect(page1Ids, "page 1 is the first bounded slice").toEqual(allIds.slice(0, pageSize));
    expect(page2Ids, "page 2 is the next bounded slice").toEqual(allIds.slice(pageSize, pageSize * 2));
    expect(
      new Set([...page1Ids, ...page2Ids]).size,
      "pages are disjoint and fully ordered"
    ).toBe(page1Ids.length + page2Ids.length);

    // A bounded single page never exceeds the requested range size, yet the
    // total filtered count is still reported for the UI pager.
    const bounded = await activityClient(staff.client)
      .from("audit_activity")
      .select("audit_id", { count: "exact" })
      .in("audit_id", allIds)
      .order("occurred_at", { ascending: false })
      .order("audit_id", { ascending: false })
      .limit(pageSize);
    expect(bounded.error, "limited activity read").toBeNull();
    expect((bounded.data ?? []).length, "limit bounds the page").toBeLessThanOrEqual(pageSize);
    expect(bounded.count, "limit still reports the full filtered count").toBe(allIds.length);
  });

  it("breaks occurred_at ties deterministically by audit_id DESC (R10)", async () => {
    // Two base rows inserted in ONE transaction share the transaction-clock
    // `occurred_at`, so only the audit_id tie-breaker can order them.
    const client = await pool.connect();
    let firstMeetingId = 0;
    let secondMeetingId = 0;
    try {
      await client.query("BEGIN");
      const first = await client.query<{ meeting_id: number }>(
        `INSERT INTO public.advising_meeting
           (student_id, advisor_id, meeting_date, meeting_mode, no_show)
         VALUES ($1, $2, $3, $4, $5) RETURNING meeting_id`,
        [student.studentId, staff.advisorId, "2026-09-30", "Virtual", false]
      );
      const second = await client.query<{ meeting_id: number }>(
        `INSERT INTO public.advising_meeting
           (student_id, advisor_id, meeting_date, meeting_mode, no_show)
         VALUES ($1, $2, $3, $4, $5) RETURNING meeting_id`,
        [student.studentId, staff.advisorId, "2026-10-01", "In-Person", false]
      );
      firstMeetingId = first.rows[0].meeting_id;
      secondMeetingId = second.rows[0].meeting_id;
      await client.query("COMMIT");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
    authenticatedHistoryIds.push({ entityType: "advising_meeting", entityId: firstMeetingId });
    authenticatedHistoryIds.push({ entityType: "advising_meeting", entityId: secondMeetingId });

    const { rows } = await pool.query<{ audit_id: number; occurred_at: string }>(
      `SELECT audit_id, occurred_at
         FROM public.audit_event
        WHERE entity_type = 'advising_meeting' AND entity_id = ANY($1::int[])
        ORDER BY audit_id`,
      [[firstMeetingId, secondMeetingId]]
    );
    expect(rows, "two events for the tie").toHaveLength(2);
    expect(
      new Date(String(rows[0].occurred_at)).getTime(),
      "both events share one transaction-clock occurred_at"
    ).toBe(new Date(String(rows[1].occurred_at)).getTime());

    const view = await activityClient(staff.client)
      .from("audit_activity")
      .select("audit_id, occurred_at")
      .in("audit_id", rows.map((r) => r.audit_id))
      .order("occurred_at", { ascending: false })
      .order("audit_id", { ascending: false });
    expect(view.error, "tie-break activity read").toBeNull();
    const ids = (view.data ?? []).map((r) => Number(r.audit_id));
    expect(ids, "both tied events are returned").toHaveLength(2);
    expect(ids[0], "occurred_at ties break to the higher audit_id first").toBeGreaterThan(ids[1]);
    expect(ids, "the tied order is strictly audit_id DESC").toEqual([...ids].sort((a, b) => b - a));
  });

  it("filters the dataset by entity_type and keeps exact-count parity", async () => {
    const scholarshipIds = authenticatedHistoryIds
      .filter((r) => r.entityType === "scholarship_history")
      .map((r) => r.entityId);
    expect(scholarshipIds, "at least one seeded scholarship_history row").toHaveLength(1);

    const { rows: oracle } = await pool.query<{ audit_id: number }>(
      `SELECT audit_id
         FROM public.audit_event
        WHERE entity_type = 'scholarship_history' AND entity_id = $1`,
      [scholarshipIds[0]]
    );
    const expectedAuditIds = oracle.map((r) => r.audit_id);

    const result = await activityClient(staff.client)
      .from("audit_activity")
      .select("audit_id, entity_type", { count: "exact" })
      .eq("entity_type", "scholarship_history")
      .in("entity_id", scholarshipIds);
    expect(result.error, "entity-type-filtered activity read").toBeNull();
    expect(result.count, "filtered exact count parity").toBe(expectedAuditIds.length);
    for (const row of result.data ?? []) {
      expect(row.entity_type).toBe("scholarship_history");
    }
  });
});

describe("no-op maintenance assertions for the activity view", () => {
  it("exposes no INSERT/UPDATE/DELETE path through PostgREST for an active advisor", async () => {
    const insertResult = await staff.client.from("audit_activity").insert({ entity_type: "student", entity_id: 1, action: "created", actor_name_snapshot: "Forged", origin: "user" });
    expect(insertResult.error, "authenticated activity INSERT must be denied").not.toBeNull();
  });
});
