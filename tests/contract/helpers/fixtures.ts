/**
 * tests/contract/helpers/fixtures.ts
 *
 * Synthetic fixtures for the contract-test lane.
 *
 * - Every value is explicitly synthetic: `@example.com` emails prefixed with
 *   `contract-` and names prefixed with `Contract`. No real student or advisor
 *   PII is used anywhere.
 * - A run token (timestamp + random suffix) makes every synthetic value unique
 *   per run, so repeated runs never collide with unique constraints and the
 *   suite stays deterministic.
 * - All rows are created through the local service-role client (bypasses RLS)
 *   strictly to seed data and to isolate DB constraints; the service role is
 *   never asserted as an access grant.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

const RUN_TOKEN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** Password shared by all synthetic auth users (local GoTrue only). */
export const CONTRACT_TEST_PASSWORD = "ContractPass!2026";

export function syntheticEmail(prefix: string): string {
  return `contract-${prefix}-${RUN_TOKEN}@example.com`;
}

export function syntheticName(prefix: string): string {
  return `Contract ${prefix} ${RUN_TOKEN}`;
}

export interface SeededCore {
  advisorSelfId: number;
  advisorSelfEmail: string;
  advisorOtherId: number;
  advisorOtherEmail: string;
  advisorInactiveId: number;
  advisorInactiveEmail: string;
  studentId: number;
  studentEmail: string;
  fellowshipId: number;
  applicationId: number;
  meetingId: number;
  attendanceId: number;
  historyId: number;
}

/**
 * Seed one row in every operational table (all seven) plus three advisors
 * (self-linked, other, inactive) needed by the RLS contract. Returns the
 * created ids. The local instance is ephemeral (`supabase stop --no-backup`
 * after every run), so no cross-run cleanup is required.
 */
export async function seedCoreFixtures(service: SupabaseClient): Promise<SeededCore> {
  const advisorSelfEmail = syntheticEmail("advisor-self");
  const advisorOtherEmail = syntheticEmail("advisor-other");
  const advisorInactiveEmail = syntheticEmail("advisor-inactive");

  const insertAdvisor = async (
    advisorName: string,
    email: string,
    isActive: boolean
  ): Promise<number> => {
    const { data, error } = await service
      .from("advisor")
      .insert({ advisor_name: advisorName, email, is_active: isActive })
      .select("advisor_id")
      .single();
    if (error) throw new Error(`seed advisor: ${error.message}`);
    return data.advisor_id as number;
  };

  const advisorSelfId = await insertAdvisor(syntheticName("advisor-self"), advisorSelfEmail, true);
  const advisorOtherId = await insertAdvisor(syntheticName("advisor-other"), advisorOtherEmail, true);
  const advisorInactiveId = await insertAdvisor(syntheticName("advisor-inactive"), advisorInactiveEmail, false);

  const studentEmail = syntheticEmail("student");
  const { data: student, error: studentError } = await service
    .from("student")
    .insert({
      full_name: syntheticName("student"),
      email: studentEmail,
      is_ch_student: false,
      us_citizen: true,
      first_gen: false,
      honors_college: false,
      class_standing: "Junior",
      gpa: 3.42,
      gender: "NR",
    })
    .select("student_id")
    .single();
  if (studentError) throw new Error(`seed student: ${studentError.message}`);
  const studentId = student.student_id as number;

  const { data: fellowship, error: fellowshipError } = await service
    .from("fellowship")
    .insert({ fellowship_name: syntheticName("fellowship") })
    .select("fellowship_id")
    .single();
  if (fellowshipError) throw new Error(`seed fellowship: ${fellowshipError.message}`);
  const fellowshipId = fellowship.fellowship_id as number;

  const { data: application, error: applicationError } = await service
    .from("application")
    .insert({
      student_id: studentId,
      fellowship_id: fellowshipId,
      destination_country: "Testland",
      stage_of_application: "Submitted",
    })
    .select("application_id")
    .single();
  if (applicationError) throw new Error(`seed application: ${applicationError.message}`);
  const applicationId = application.application_id as number;

  const { data: meeting, error: meetingError } = await service
    .from("advising_meeting")
    .insert({
      student_id: studentId,
      advisor_id: advisorSelfId,
      meeting_date: "2026-09-01",
      meeting_mode: "Virtual",
      no_show: false,
    })
    .select("meeting_id")
    .single();
  if (meetingError) throw new Error(`seed advising_meeting: ${meetingError.message}`);
  const meetingId = meeting.meeting_id as number;

  const { data: attendance, error: attendanceError } = await service
    .from("fellowship_thursday")
    .insert({ student_id: studentId, attended: true, source_info: "OCF" })
    .select("attendance_id")
    .single();
  if (attendanceError) throw new Error(`seed fellowship_thursday: ${attendanceError.message}`);
  const attendanceId = attendance.attendance_id as number;

  const { data: history, error: historyError } = await service
    .from("scholarship_history")
    .insert({ student_id: studentId, fellowship_id: fellowshipId })
    .select("history_id")
    .single();
  if (historyError) throw new Error(`seed scholarship_history: ${historyError.message}`);
  const historyId = history.history_id as number;

  return {
    advisorSelfId,
    advisorSelfEmail,
    advisorOtherId,
    advisorOtherEmail,
    advisorInactiveId,
    advisorInactiveEmail,
    studentId,
    studentEmail,
    fellowshipId,
    applicationId,
    meetingId,
    attendanceId,
    historyId,
  };
}

/** Create a synthetic Supabase Auth user on the local instance; returns its id. */
export async function createAuthUser(service: SupabaseClient, email: string): Promise<string> {
  const { data, error } = await service.auth.admin.createUser({
    email,
    password: CONTRACT_TEST_PASSWORD,
    email_confirm: true,
  });
  if (error) throw new Error(`create auth user: ${error.message}`);
  if (!data?.user) throw new Error("create auth user: no user returned");
  return data.user.id;
}

/** Sign a fresh anon-key client in as the synthetic user; returns the user id. */
export async function signInWithPassword(client: SupabaseClient, email: string): Promise<string> {
  const { data, error } = await client.auth.signInWithPassword({
    email,
    password: CONTRACT_TEST_PASSWORD,
  });
  if (error) throw new Error(`sign in: ${error.message}`);
  if (!data?.user) throw new Error("sign in: no user returned");
  return data.user.id;
}