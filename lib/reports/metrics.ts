// ── constants ─────────────────────────────────────────────────────────────────

import { formatApplicationLabel } from "@/lib/applications/pipeline";

export const STAGE_ORDER = [
  "Started",
  "Submitted",
  "Under Review",
  "Semi-Finalist",
  "Finalist",
  "Awarded",
  "Rejected",
] as const;

export const CLASS_ORDER = [
  "Freshman",
  "Sophomore",
  "Junior",
  "Senior",
  "Graduate",
  "Doctoral",
] as const;

/** Explicit label for advising meetings with no linked application. */
export const GENERAL_ADVISING_LABEL = "General Advising" as const;

// ── row types (Supabase select payloads) ──────────────────────────────────────

export type ReportApplicationRow = {
  student_id: number;
  fellowship_id: number;
  application_year?: number | null;
  stage_of_application: string;
  is_finalist: boolean;
  is_semi_finalist: boolean;
  student: { full_name: string; major: string | null; class_standing: string | null } | null;
  fellowship: { fellowship_name: string } | null;
};

export type ReportMeetingRow = {
  student_id: number;
  advisor_id: number | null;
  no_show: boolean;
  meeting_date: string;
  advisor: { advisor_name: string } | null;
  application_id: number | null;
  application: ReportLinkedApplication | null;
};

/** Joined `application` relation for an advising meeting (application → fellowship). */
export type ReportLinkedApplication = {
  application_id: number;
  fellowship_id: number;
  application_year?: number | null;
  fellowship: { fellowship_name: string } | null;
};

export type ReportStudentRow = {
  student_id: number;
  full_name: string;
  major: string | null;
  class_standing: string | null;
};

export type ReportFellowshipThursdayRow = {
  student_id: number;
  attended: boolean;
};

// ── result types ──────────────────────────────────────────────────────────────

export type StageCount = { stage: string; count: number };
export type FellowshipSummary = {
  id: number;
  name: string;
  total: number;
  semiFinalists: number;
  finalists: number;
  awarded: number;
};
export type ClassStandingCount = { standing: string; count: number };
export type AdvisorActivityRow = {
  id: number | null;
  name: string;
  total: number;
  noShows: number;
  students: number;
};
export type StudentSessionsRow = { student_id: number; full_name: string; sessions: number };
export type StudentApplicationSessionsRow = {
  student_id: number;
  full_name: string;
  application_id: number | null;
  label: string;
  sessions: number;
};
export type FellowshipSessionsRow = { fellowship_id: number; label: string; sessions: number };
export type MonthTrendRow = { month: string; total: number; noShows: number };
export type ReportMetrics = {
  applicationsByStage: StageCount[];
  fellowshipsByFinalists: FellowshipSummary[];
  byClassStanding: ClassStandingCount[];
  advisorActivity: AdvisorActivityRow[];
  advisingSessionsByStudent: StudentSessionsRow[];
  advisingSessionsByStudentApplication: StudentApplicationSessionsRow[];
  advisingSessionsByFellowship: FellowshipSessionsRow[];
  noShowTrend: MonthTrendRow[];
  advisingNoApplication: ReportStudentRow[];
  ftThenApplied: ReportStudentRow[];
  ftNotYetApplied: ReportStudentRow[];
  totals: {
    students: number;
    applications: number;
    meetings: number;
    ftAttendees: number;
    awarded: number;
  };
};

// ── aggregation ───────────────────────────────────────────────────────────────

/**
 * Pure post-query aggregation for the Reports dashboard.
 *
 * Takes the raw Supabase select payloads and derives every report the page
 * renders. Behavior is intentionally identical to the original inline logic:
 *
 * - Stages are emitted in pipeline order, with unrecognized stages appended
 *   afterward in first-seen order.
 * - Class standings are emitted in `CLASS_ORDER`, with a synthetic "Unknown"
 *   bucket appended last (null standings). Unlisted standings are dropped.
 * - Fellowships are sorted by finalists then awarded (descending) and limited
 *   to the top 15; missing fellowship relations fall back to "Fellowship {id}".
 * - Advisors are keyed by advisor id (null -> "none") and sorted by meeting
 *   count descending; missing advisor relations fall back to "Unassigned".
 *   Each row also carries the count of unique students advised.
 * - Advising sessions by student group every meeting (General Advising and
 *   application-linked) and are sorted by session count descending, then
 *   student id ascending; missing student relations fall back to "Student {id}".
 * - Advising sessions by student & application group meetings by student and
 *   nullable application link. NULL `application_id` is explicitly labeled
 *   "General Advising"; a non-NULL `application_id` whose relation is missing
 *   keeps a safe "Application {id}" label and is never collapsed into General
 *   Advising. Rows are sorted by student id ascending, then sessions descending.
 * - Advising sessions by fellowship count only application-linked meetings
 *   (non-NULL `application_id` with a joined application) and group by
 *   fellowship, combining every application cycle into a single total; NULL
 *   links and missing relations contribute to no fellowship. A missing
 *   fellowship relation falls back to "Fellowship {id}". Rows are sorted by
 *   sessions descending, then label ascending.
 * - The no-show trend takes the last six *observed* months (sorted ascending,
 *   then `slice(-6)`), NOT a calendar window.
 */
export function computeReportMetrics(
  applications: ReportApplicationRow[],
  meetings: ReportMeetingRow[],
  students: ReportStudentRow[],
  ftRows: ReportFellowshipThursdayRow[],
): ReportMetrics {
  // ── Report 1: Applications by Stage (pipeline order) ─────────────────────
  const stageMap = new Map<string, number>();
  for (const a of applications) {
    stageMap.set(a.stage_of_application, (stageMap.get(a.stage_of_application) ?? 0) + 1);
  }
  const applicationsByStage: StageCount[] = STAGE_ORDER
    .filter((s) => stageMap.has(s))
    .map((stage) => ({ stage, count: stageMap.get(stage)! }));
  for (const [stage, count] of stageMap) {
    if (!STAGE_ORDER.includes(stage as (typeof STAGE_ORDER)[number])) {
      applicationsByStage.push({ stage, count });
    }
  }

  // ── Report 2: Finalists & Awarded by Fellowship + Application Year ────────
  // Group by fellowship AND application year so cycles are never merged.
  const fellowshipMap = new Map<
    string,
    { id: number; name: string; total: number; semiFinalists: number; finalists: number; awarded: number }
  >();
  for (const a of applications) {
    const baseName = a.fellowship?.fellowship_name ?? `Fellowship ${a.fellowship_id}`;
    const year = a.application_year ?? null;
    const key = `${a.fellowship_id}:${year ?? "unknown"}`;
    const name = formatApplicationLabel(baseName, year);
    const rec = fellowshipMap.get(key) ?? { id: a.fellowship_id, name, total: 0, semiFinalists: 0, finalists: 0, awarded: 0 };
    rec.total += 1;
    if (a.is_semi_finalist || a.stage_of_application === "Semi-Finalist") rec.semiFinalists += 1;
    if (a.is_finalist || a.stage_of_application === "Finalist") rec.finalists += 1;
    if (a.stage_of_application === "Awarded") rec.awarded += 1;
    fellowshipMap.set(key, rec);
  }
  const fellowshipsByFinalists: FellowshipSummary[] = [...fellowshipMap.values()]
    .sort((a, b) => b.finalists - a.finalists || b.awarded - a.awarded)
    .slice(0, 15);

  // ── Report 3: Students by Class Standing ─────────────────────────────────
  const classMap = new Map<string, number>();
  for (const s of students) {
    const cs = s.class_standing ?? "Unknown";
    classMap.set(cs, (classMap.get(cs) ?? 0) + 1);
  }
  const byClassStanding: ClassStandingCount[] = CLASS_ORDER
    .filter((c) => classMap.has(c))
    .map((standing) => ({ standing, count: classMap.get(standing)! }));
  if (classMap.has("Unknown")) {
    byClassStanding.push({ standing: "Unknown", count: classMap.get("Unknown")! });
  }

  // ── Report 4: Advising Meetings by Advisor ────────────────────────────────
  const advisorMap = new Map<
    string,
    { id: number | null; name: string; total: number; noShows: number; students: Set<number> }
  >();
  for (const m of meetings) {
    const name = m.advisor?.advisor_name ?? "Unassigned";
    const key = String(m.advisor_id ?? "none");
    const rec = advisorMap.get(key) ?? {
      id: m.advisor_id ?? null,
      name,
      total: 0,
      noShows: 0,
      students: new Set<number>(),
    };
    rec.total += 1;
    if (m.no_show) rec.noShows += 1;
    rec.students.add(m.student_id);
    advisorMap.set(key, rec);
  }
  const advisorActivity: AdvisorActivityRow[] = [...advisorMap.values()]
    .map(({ students, ...rec }) => ({ ...rec, students: students.size }))
    .sort((a, b) => b.total - a.total);

  // ── Advising Sessions by Student (lifetime, General + linked) ─────────────
  const studentNameMap = new Map(students.map((s) => [s.student_id, s.full_name]));
  const studentSessionsMap = new Map<number, number>();
  for (const m of meetings) {
    studentSessionsMap.set(m.student_id, (studentSessionsMap.get(m.student_id) ?? 0) + 1);
  }
  const advisingSessionsByStudent: StudentSessionsRow[] = [...studentSessionsMap.entries()]
    .map(([student_id, sessions]) => ({
      student_id,
      full_name: studentNameMap.get(student_id) ?? `Student ${student_id}`,
      sessions,
    }))
    .sort((a, b) => b.sessions - a.sessions || a.student_id - b.student_id);

  // ── Advising Sessions by Student & Application/Fellowship ────────────────
  // NULL application_id is explicitly General Advising. A non-NULL
  // application_id whose joined relation is missing keeps a safe
  // "Application {id}" label and is never collapsed into General Advising.
  const studentApplicationMap = new Map<string, StudentApplicationSessionsRow>();
  for (const m of meetings) {
    const applicationId = m.application_id ?? null;
    const label =
      applicationId === null
        ? GENERAL_ADVISING_LABEL
        : m.application
          ? formatApplicationLabel(m.application.fellowship?.fellowship_name ?? null, m.application.application_year)
          : `Application ${applicationId}`;
    const key = `${m.student_id}|${applicationId === null ? "general" : applicationId}`;
    const rec = studentApplicationMap.get(key) ?? {
      student_id: m.student_id,
      full_name: studentNameMap.get(m.student_id) ?? `Student ${m.student_id}`,
      application_id: applicationId,
      label,
      sessions: 0,
    };
    rec.sessions += 1;
    studentApplicationMap.set(key, rec);
  }
  const advisingSessionsByStudentApplication: StudentApplicationSessionsRow[] = [
    ...studentApplicationMap.values(),
  ].sort((a, b) => a.student_id - b.student_id || b.sessions - a.sessions);

  // ── Advising Sessions by Fellowship (application-linked only) ────────────
  // Only meetings with a non-NULL application_id AND a joined application
  // contribute; General Advising and missing relations are excluded from every
  // fellowship bucket. All application cycles for one fellowship combine into a
  // single total (by fellowship), and a missing fellowship relation falls back
  // to the existing safe "Fellowship {id}" label.
  const fellowshipSessionsMap = new Map<number, FellowshipSessionsRow>();
  for (const m of meetings) {
    if (m.application_id === null || m.application === null) continue;
    const linked = m.application;
    const label = linked.fellowship?.fellowship_name ?? `Fellowship ${linked.fellowship_id}`;
    const rec = fellowshipSessionsMap.get(linked.fellowship_id) ?? {
      fellowship_id: linked.fellowship_id,
      label,
      sessions: 0,
    };
    rec.sessions += 1;
    fellowshipSessionsMap.set(linked.fellowship_id, rec);
  }
  const advisingSessionsByFellowship: FellowshipSessionsRow[] = [...fellowshipSessionsMap.values()].sort(
    (a, b) => b.sessions - a.sessions || a.label.localeCompare(b.label),
  );

  // ── Report 5: No-Show Trend (last 6 observed months) ─────────────────────
  const monthMap = new Map<string, { total: number; noShows: number }>();
  for (const m of meetings) {
    const month = m.meeting_date.slice(0, 7); // "YYYY-MM"
    const rec = monthMap.get(month) ?? { total: 0, noShows: 0 };
    rec.total += 1;
    if (m.no_show) rec.noShows += 1;
    monthMap.set(month, rec);
  }
  const noShowTrend: MonthTrendRow[] = [...monthMap.entries()]
    .map(([month, v]) => ({ month, ...v }))
    .sort((a, b) => a.month.localeCompare(b.month))
    .slice(-6);

  // ── Report 6: Students with Advising but No Application ──────────────────
  const studentsWithApplications = new Set(applications.map((a) => a.student_id));
  const studentsWithMeetings = new Set(meetings.map((m) => m.student_id));
  const advisingNoApplication = students.filter(
    (s) => studentsWithMeetings.has(s.student_id) && !studentsWithApplications.has(s.student_id),
  );

  // ── Report 7: FT Attendees → Applied / Not Yet Applied ───────────────────
  const ftAttendeeIds = new Set(ftRows.filter((r) => r.attended).map((r) => r.student_id));
  const ftThenApplied = students.filter(
    (s) => ftAttendeeIds.has(s.student_id) && studentsWithApplications.has(s.student_id),
  );
  const ftNotYetApplied = students.filter(
    (s) => ftAttendeeIds.has(s.student_id) && !studentsWithApplications.has(s.student_id),
  );

  return {
    applicationsByStage,
    fellowshipsByFinalists,
    byClassStanding,
    advisorActivity,
    advisingSessionsByStudent,
    advisingSessionsByStudentApplication,
    advisingSessionsByFellowship,
    noShowTrend,
    advisingNoApplication,
    ftThenApplied,
    ftNotYetApplied,
    totals: {
      students: students.length,
      applications: applications.length,
      meetings: meetings.length,
      ftAttendees: ftAttendeeIds.size,
      awarded: applications.filter((a) => a.stage_of_application === "Awarded").length,
    },
  };
}