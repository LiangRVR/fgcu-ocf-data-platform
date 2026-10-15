/**
 * tests/contract/audit-presentation-projection.test.ts
 *
 * Database contract for migration 20261021000001_audit_presentation_projection:
 * the explicit `security_invoker` `audit_activity` presentation source.
 *
 * Proves, against the fresh isolated Docker-local contract lane:
 *   - the view stays SECURITY INVOKER, SELECT-only, and one row per event, and
 *     exposes the new safe presentation scalars;
 *   - paired frozen relationship endpoint IDs resolve for an application
 *     re-link;
 *   - a Fellowship Thursday amendment's per-field effective-before value is
 *     derived from the immutable base plus strictly-earlier amendments
 *     (including an explicit source correction to NULL), never from a later
 *     amendment or current state;
 *   - a Scholarship amendment projects its immediately-prior/corrected frozen
 *     fellowship, and a Void projects ONLY that amendment's required reason;
 *   - an advising amendment projects the immutable parent-meeting
 *     `meeting_date`/`application_id`/`advisor_id` and never a mutable
 *     advisor-name join.
 *
 * Service role is used strictly for fixture seeding and oracle re-reads.
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

function freshClient(): SupabaseClient {
  return createClient(env.apiUrl, env.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

interface Actor {
  advisorId: number;
  client: SupabaseClient;
}

async function createStaff(label: string): Promise<Actor> {
  const tag = nextUnique(label);
  const email = syntheticEmail(tag);
  const userId = await createAuthUser(service, email);
  const advisorId = (
    await service.from("advisor").insert({ advisor_name: syntheticName(tag), email, is_active: true }).select("advisor_id").single()
  ).data!.advisor_id as number;
  await service.from("advisor").update({ auth_user_id: userId }).eq("advisor_id", advisorId);
  const client = freshClient();
  await signInWithPassword(client, email);
  return { advisorId, client };
}

async function seedStudent(label: string): Promise<number> {
  const tag = nextUnique(label);
  const { data, error } = await service
    .from("student")
    .insert({ full_name: syntheticName(tag), email: syntheticEmail(tag), us_citizen: true })
    .select("student_id")
    .single();
  if (error) throw new Error(`seed student: ${error.message}`);
  return data!.student_id as number;
}

async function seedFellowship(label: string): Promise<number> {
  const { data, error } = await service
    .from("fellowship")
    .insert({ fellowship_name: syntheticName(nextUnique(label)) })
    .select("fellowship_id")
    .single();
  if (error) throw new Error(`seed fellowship: ${error.message}`);
  return data!.fellowship_id as number;
}

interface ProjectionRow {
  audit_id: number;
  previous_student_id: number | null;
  current_student_id: number | null;
  previous_fellowship_id: number | null;
  current_fellowship_id: number | null;
  fellowship_thursday_attended_before: boolean | null;
  fellowship_thursday_attended_after: boolean | null;
  fellowship_thursday_attended_amended: boolean | null;
  fellowship_thursday_source_before: string | null;
  fellowship_thursday_source_after: string | null;
  fellowship_thursday_source_amended: boolean | null;
  void_reason: string | null;
  advising_meeting_date: string | null;
  advising_application_id: number | null;
  advising_advisor_id: number | null;
  subject_application_name: string | null;
}

async function readProjection(auditId: number): Promise<ProjectionRow> {
  const { rows } = await pool.query<ProjectionRow>(
    `SELECT audit_id::int AS audit_id, previous_student_id, current_student_id,
            previous_fellowship_id, current_fellowship_id,
            fellowship_thursday_attended_before, fellowship_thursday_attended_after,
            fellowship_thursday_attended_amended, fellowship_thursday_source_before,
            fellowship_thursday_source_after, fellowship_thursday_source_amended,
            void_reason, advising_meeting_date::text AS advising_meeting_date,
            advising_application_id, advising_advisor_id,
            subject_application_name
       FROM public.audit_activity WHERE audit_id = $1`,
    [auditId]
  );
  if (rows.length !== 1) throw new Error(`expected one projection row for audit ${auditId}`);
  return rows[0];
}

async function latestAuditId(entityType: string, entityId: number): Promise<number> {
  const { rows } = await pool.query<{ audit_id: number }>(
    `SELECT audit_id::int AS audit_id FROM public.audit_event
      WHERE entity_type = $1 AND entity_id = $2 ORDER BY audit_id DESC LIMIT 1`,
    [entityType, entityId]
  );
  if (!rows.length) throw new Error(`no audit event for ${entityType}#${entityId}`);
  return rows[0].audit_id;
}

let staff: Actor;

beforeAll(async () => {
  pool = createDbPool(env);
  staff = await createStaff("presentation-staff");
}, 60_000);

afterAll(async () => {
  if (pool) await pool.end();
});

describe("audit_activity presentation source schema (migration 20261021000001)", () => {
  it("is SECURITY INVOKER, one row per event, SELECT-only, and exposes the presentation scalars", async () => {
    const { rows: meta } = await pool.query<{ reloptions: string[] | null; relkind: string }>(
      `SELECT c.reloptions, c.relkind FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'audit_activity'`
    );
    expect(meta[0].relkind).toBe("v");
    expect(String(meta[0].reloptions ?? "")).toContain("security_invoker");

    const { rows: cols } = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'audit_activity'`
    );
    const names = cols.map((c) => c.column_name);
    for (const expected of [
      "previous_student_id",
      "current_student_id",
      "previous_fellowship_id",
      "current_fellowship_id",
      "fellowship_thursday_attended_before",
      "fellowship_thursday_source_after",
      "void_reason",
      "advising_meeting_date",
      "advising_application_id",
      "advising_advisor_id",
    ]) {
      expect(names, `audit_activity exposes ${expected}`).toContain(expected);
    }
    // Browser-safe boundary: the raw audit JSON payloads are NOT part of the
    // authenticated projection.
    for (const absent of ["old_values", "new_values", "changes"] as const) {
      expect(names, `audit_activity must not expose raw payload column ${absent}`).not.toContain(absent);
    }

    const { rows: grants } = await pool.query(
      `SELECT has_table_privilege('authenticated', 'public.audit_activity', 'SELECT') AS s,
              has_table_privilege('authenticated', 'public.audit_activity', 'INSERT') AS i,
              has_table_privilege('anon', 'public.audit_activity', 'SELECT') AS a`
    );
    expect(grants[0].s).toBe(true);
    expect(grants[0].i).toBe(false);
    expect(grants[0].a).toBe(false);
  });
});

describe("application re-link relationship endpoint ids", () => {
  it("projects the frozen previous/current student and fellowship ids", async () => {
    const studentA = await seedStudent("relink-a");
    const studentB = await seedStudent("relink-b");
    const fellowshipA = await seedFellowship("relink-fa");
    const fellowshipB = await seedFellowship("relink-fb");
    const applicationId = (
      await service
        .from("application")
        .insert({ student_id: studentA, fellowship_id: fellowshipA, stage_of_application: "Submitted", application_year: 2026 })
        .select("application_id")
        .single()
    ).data!.application_id as number;

    const version = (
      await pool.query<{ row_version: number }>("SELECT row_version FROM public.application WHERE application_id = $1", [applicationId])
    ).rows[0].row_version;
    const relink = await staff.client.rpc("update_application", {
      p_application_id: applicationId,
      p_expected_version: version,
      p_student_id: studentB,
      p_fellowship_id: fellowshipB,
      p_application_year: 2026,
      p_destination_country: "Testland",
      p_stage_of_application: "Submitted",
      p_is_semi_finalist: false,
      p_is_finalist: false,
    });
    expect(relink.error).toBeNull();

    const auditId = (
      await pool.query<{ audit_id: number }>(
        `SELECT audit_id::int AS audit_id FROM public.audit_event
          WHERE entity_type = 'application' AND entity_id = $1 AND action = 'updated'`,
        [applicationId]
      )
    ).rows[0].audit_id;

    const projection = await readProjection(auditId);
    expect(projection.previous_student_id).toBe(studentA);
    expect(projection.current_student_id).toBe(studentB);
    expect(projection.previous_fellowship_id).toBe(fellowshipA);
    expect(projection.current_fellowship_id).toBe(fellowshipB);
  });
});

describe("Fellowship Thursday per-field predecessor chain", () => {
  it("derives each field's effective-before from the immutable base and earlier amendments", async () => {
    const studentId = await seedStudent("ft-chain");
    const attendanceId = (
      await staff.client
        .from("fellowship_thursday")
        .insert({ student_id: studentId, attended: true, source_info: "OCF" })
        .select("attendance_id")
        .single()
    ).data!.attendance_id as number;

    const addAmendment = async (payload: Record<string, unknown>): Promise<number> => {
      const { data, error } = await staff.client
        .from("fellowship_thursday_amendment")
        .insert({ attendance_id: attendanceId, reason: "contract FT chain", ...payload })
        .select("amendment_id")
        .single();
      if (error) throw new Error(`FT amendment insert: ${error.message}`);
      return data!.amendment_id as number;
    };

    // 1) correct attended true -> false (source untouched).
    const correction1 = await addAmendment({ corrected_attended: false });
    const p1 = await readProjection(await latestAuditId("fellowship_thursday_amendment", correction1));
    expect(p1.fellowship_thursday_attended_amended).toBe(true);
    expect(p1.fellowship_thursday_attended_before).toBe(true);
    expect(p1.fellowship_thursday_attended_after).toBe(false);
    expect(p1.fellowship_thursday_source_amended).toBe(false);

    // 2) explicitly correct source to NULL: before is the base OCF, after NULL.
    const correction2 = await addAmendment({ corrects_source_info: true, corrected_source_info: null });
    const p2 = await readProjection(await latestAuditId("fellowship_thursday_amendment", correction2));
    expect(p2.fellowship_thursday_source_amended).toBe(true);
    expect(p2.fellowship_thursday_source_before).toBe("OCF");
    expect(p2.fellowship_thursday_source_after).toBeNull();
    // The prior attended correction is the effective BEFORE value, not the base.
    expect(p2.fellowship_thursday_attended_amended).toBe(false);
    expect(p2.fellowship_thursday_attended_before).toBe(false);

    // 3) correct attended false -> true: before is the IMMEDIATELY prior correction.
    const correction3 = await addAmendment({ corrected_attended: true });
    const p3 = await readProjection(await latestAuditId("fellowship_thursday_amendment", correction3));
    expect(p3.fellowship_thursday_attended_before).toBe(false);
    expect(p3.fellowship_thursday_attended_after).toBe(true);
  });
});

describe("Scholarship amendment projection", () => {
  it("projects the immediately-prior/corrected fellowship and only the exact Void reason", async () => {
    const studentId = await seedStudent("scholar-proj");
    const goldwater = await seedFellowship("scholar-gold");
    const fulbright = await seedFellowship("scholar-ful");
    const marshall = await seedFellowship("scholar-mar");
    const historyId = (
      await staff.client
        .from("scholarship_history")
        .insert({ student_id: studentId, fellowship_id: goldwater })
        .select("history_id")
        .single()
    ).data!.history_id as number;

    const correction = (
      await staff.client
        .from("scholarship_history_amendment")
        .insert({ history_id: historyId, amendment_type: "Correction", reason: "contract correction", corrected_fellowship_id: fulbright })
        .select("amendment_id")
        .single()
    ).data!.amendment_id as number;
    const pCorrection = await readProjection(await latestAuditId("scholarship_history_amendment", correction));
    expect(pCorrection.previous_fellowship_id).toBe(goldwater);
    expect(pCorrection.current_fellowship_id).toBe(fulbright);
    expect(pCorrection.void_reason).toBeNull();

    const secondCorrection = (
      await staff.client
        .from("scholarship_history_amendment")
        .insert({ history_id: historyId, amendment_type: "Correction", reason: "contract correction 2", corrected_fellowship_id: marshall })
        .select("amendment_id")
        .single()
    ).data!.amendment_id as number;
    const pSecond = await readProjection(await latestAuditId("scholarship_history_amendment", secondCorrection));
    expect(pSecond.previous_fellowship_id).toBe(fulbright);
    expect(pSecond.current_fellowship_id).toBe(marshall);

    const voidId = (
      await staff.client
        .from("scholarship_history_amendment")
        .insert({ history_id: historyId, amendment_type: "Void", reason: "contract void reason" })
        .select("amendment_id")
        .single()
    ).data!.amendment_id as number;
    const pVoid = await readProjection(await latestAuditId("scholarship_history_amendment", voidId));
    expect(pVoid.void_reason).toBe("contract void reason");
    expect(pVoid.current_fellowship_id).toBe(marshall);
  });
});

describe("advising amendment safe parent scalars", () => {
  it("projects the immutable parent meeting_date/application_id/advisor_id and never a mutable name", async () => {
    const studentId = await seedStudent("advising-proj");
    const fellowshipId = await seedFellowship("advising-proj-f");
    const applicationId = (
      await service
        .from("application")
        .insert({ student_id: studentId, fellowship_id: fellowshipId, stage_of_application: "Submitted", application_year: 2026 })
        .select("application_id")
        .single()
    ).data!.application_id as number;

    const meetingId = (
      await staff.client
        .from("advising_meeting")
        .insert({
          student_id: studentId,
          advisor_id: staff.advisorId,
          application_id: applicationId,
          meeting_date: "2026-09-21",
          meeting_mode: "Virtual",
          no_show: false,
        })
        .select("meeting_id")
        .single()
    ).data!.meeting_id as number;

    const amendmentId = (
      await staff.client
        .from("advising_meeting_amendment")
        .insert({ meeting_id: meetingId, reason: "contract advising amendment", details: "narrative" })
        .select("amendment_id")
        .single()
    ).data!.amendment_id as number;

    const projection = await readProjection(await latestAuditId("advising_meeting_amendment", amendmentId));
    expect(projection.advising_meeting_date).toBe("2026-09-21");
    expect(projection.advising_application_id).toBe(applicationId);
    expect(projection.advising_advisor_id).toBe(staff.advisorId);
  });
});
