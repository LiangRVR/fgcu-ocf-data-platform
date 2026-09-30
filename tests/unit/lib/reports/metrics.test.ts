import { describe, expect, it } from "vitest";
import {
  computeReportMetrics,
  type ReportApplicationRow,
  type ReportFellowshipThursdayRow,
  type ReportMeetingRow,
  type ReportStudentRow,
} from "@/lib/reports/metrics";

// ── fixture builders ──────────────────────────────────────────────────────────

function app(overrides: Partial<ReportApplicationRow> & { student_id: number; fellowship_id: number }): ReportApplicationRow {
  return {
    stage_of_application: "Started",
    is_finalist: false,
    is_semi_finalist: false,
    student: { full_name: "Student A", major: null, class_standing: null },
    fellowship: { fellowship_name: "Fellowship" },
    ...overrides,
  };
}

function meeting(overrides: Partial<ReportMeetingRow> & { student_id: number }): ReportMeetingRow {
  return {
    advisor_id: null,
    no_show: false,
    meeting_date: "2026-01-15",
    advisor: null,
    ...overrides,
  };
}

function student(overrides: Partial<ReportStudentRow> & { student_id: number; full_name: string }): ReportStudentRow {
  return {
    major: null,
    class_standing: null,
    ...overrides,
  };
}

function ft(overrides: Partial<ReportFellowshipThursdayRow> & { student_id: number }): ReportFellowshipThursdayRow {
  return { attended: false, ...overrides };
}

function compute(
  applications: ReportApplicationRow[] = [],
  meetings: ReportMeetingRow[] = [],
  students: ReportStudentRow[] = [],
  ftRows: ReportFellowshipThursdayRow[] = [],
) {
  return computeReportMetrics(applications, meetings, students, ftRows);
}

// ── empty / degenerate inputs ─────────────────────────────────────────────────

describe("computeReportMetrics", () => {
  it("returns empty reports and zero totals for empty inputs", () => {
    const r = compute();
    expect(r).toEqual({
      applicationsByStage: [],
      fellowshipsByFinalists: [],
      byClassStanding: [],
      advisorActivity: [],
      noShowTrend: [],
      advisingNoApplication: [],
      ftThenApplied: [],
      ftNotYetApplied: [],
      totals: { students: 0, applications: 0, meetings: 0, ftAttendees: 0, awarded: 0 },
    });
  });

  it("does not crash when embedded relations are null", () => {
    const r = compute(
      [
        {
          student_id: 1,
          fellowship_id: 10,
          stage_of_application: "Awarded",
          is_finalist: true,
          is_semi_finalist: true,
          student: null,
          fellowship: null,
        },
      ],
      [{ student_id: 1, advisor_id: null, no_show: true, meeting_date: "2026-01-10", advisor: null }],
      [student({ student_id: 1, full_name: "Solo" })],
      [ft({ student_id: 1, attended: true })],
    );
    expect(r.fellowshipsByFinalists[0]).toMatchObject({ id: 10, name: "Fellowship 10 — year unknown" });
    expect(r.advisorActivity[0]).toMatchObject({ id: null, name: "Unassigned" });
    expect(r.totals).toEqual({ students: 1, applications: 1, meetings: 1, ftAttendees: 1, awarded: 1 });
  });

  // ── Report 1: Applications by Stage ──────────────────────────────────────

  describe("applicationsByStage", () => {
    it("counts applications per stage in pipeline order", () => {
      const r = compute([
        app({ student_id: 1, fellowship_id: 10, stage_of_application: "Submitted" }),
        app({ student_id: 2, fellowship_id: 10, stage_of_application: "Started" }),
        app({ student_id: 3, fellowship_id: 11, stage_of_application: "Awarded" }),
        app({ student_id: 4, fellowship_id: 11, stage_of_application: "Awarded" }),
        app({ student_id: 5, fellowship_id: 12, stage_of_application: "Under Review" }),
      ]);
      expect(r.applicationsByStage).toEqual([
        { stage: "Started", count: 1 },
        { stage: "Submitted", count: 1 },
        { stage: "Under Review", count: 1 },
        { stage: "Awarded", count: 2 },
      ]);
    });

    it("appends stages not in the pipeline after known ones, in first-seen order", () => {
      const r = compute([
        app({ student_id: 1, fellowship_id: 10, stage_of_application: "Withdrawn" }),
        app({ student_id: 2, fellowship_id: 10, stage_of_application: "Submitted" }),
        app({ student_id: 3, fellowship_id: 11, stage_of_application: "Deferred" }),
        app({ student_id: 4, fellowship_id: 11, stage_of_application: "Withdrawn" }),
      ]);
      expect(r.applicationsByStage).toEqual([
        { stage: "Submitted", count: 1 },
        { stage: "Withdrawn", count: 2 },
        { stage: "Deferred", count: 1 },
      ]);
    });

    it("omits pipeline stages that have no applications", () => {
      const r = compute([
        app({ student_id: 1, fellowship_id: 10, stage_of_application: "Finalist" }),
      ]);
      expect(r.applicationsByStage).toEqual([{ stage: "Finalist", count: 1 }]);
    });
  });

  // ── Report 2: Fellowships ────────────────────────────────────────────────

  describe("fellowshipsByFinalists", () => {
    it("tallies total, semiFinalists, finalists, and awarded", () => {
      const r = compute([
        app({
          student_id: 1, fellowship_id: 10, application_year: 2026, stage_of_application: "Awarded",
          is_semi_finalist: true, is_finalist: true,
        }),
        app({
          student_id: 2, fellowship_id: 10, application_year: 2026, stage_of_application: "Finalist",
          is_semi_finalist: true, is_finalist: false,
        }),
        app({
          student_id: 3, fellowship_id: 10, application_year: 2026, stage_of_application: "Started",
          is_semi_finalist: true, is_finalist: false,
        }),
        app({ student_id: 4, fellowship_id: 10, application_year: 2026, stage_of_application: "Started", is_semi_finalist: false, is_finalist: false }),
      ]);
      expect(r.fellowshipsByFinalists).toEqual([
        {
          id: 10,
          name: "Fellowship — 2026",
          total: 4,
          semiFinalists: 3,
          finalists: 2,
          awarded: 1,
        },
      ]);
    });

    it("counts finalist/semi-finalist via flag OR matching stage", () => {
      const r = compute([
        app({ student_id: 1, fellowship_id: 10, stage_of_application: "Submitted", is_finalist: true, is_semi_finalist: false }),
        app({ student_id: 2, fellowship_id: 10, stage_of_application: "Finalist", is_finalist: false, is_semi_finalist: false }),
        app({ student_id: 3, fellowship_id: 10, stage_of_application: "Semi-Finalist", is_semi_finalist: false, is_finalist: false }),
      ]);
      expect(r.fellowshipsByFinalists[0]).toMatchObject({
        total: 3,
        semiFinalists: 1,
        finalists: 2,
        awarded: 0,
      });
    });

    it("falls back to `Fellowship {id}` when the relation is missing", () => {
      const r = compute([
        app({ student_id: 1, fellowship_id: 42, application_year: 2026, stage_of_application: "Awarded", fellowship: null }),
      ]);
      expect(r.fellowshipsByFinalists[0].name).toBe("Fellowship 42 — 2026");
    });

    it("sorts by finalists desc then awarded desc", () => {
      const r = compute([
        app({ student_id: 1, fellowship_id: 10, stage_of_application: "Finalist", is_finalist: true }),
        app({ student_id: 2, fellowship_id: 10, stage_of_application: "Awarded" }),
        app({ student_id: 3, fellowship_id: 11, stage_of_application: "Finalist", is_finalist: true }),
        app({ student_id: 4, fellowship_id: 11, stage_of_application: "Awarded" }),
        app({ student_id: 5, fellowship_id: 11, stage_of_application: "Awarded" }),
        app({ student_id: 6, fellowship_id: 12, stage_of_application: "Started" }),
      ]);
      expect(r.fellowshipsByFinalists.map((f) => f.id)).toEqual([11, 10, 12]);
    });

    it("limits results to the top 15 fellowships", () => {
      const applications: ReportApplicationRow[] = [];
      for (let i = 1; i <= 20; i++) {
        applications.push(
          app({ student_id: i, fellowship_id: i, stage_of_application: "Finalist", is_finalist: true }),
        );
      }
      const r = compute(applications);
      expect(r.fellowshipsByFinalists).toHaveLength(15);
      // Each has 1 finalist; ties fall back to first-seen (stable sort) order.
      expect(r.fellowshipsByFinalists.map((f) => f.id)).toEqual(
        Array.from({ length: 15 }, (_, i) => i + 1),
      );
    });

    it("groups the same fellowship by application year into distinct buckets", () => {
      const r = compute([
        app({ student_id: 1, fellowship_id: 10, application_year: 2026, stage_of_application: "Finalist", is_finalist: true }),
        app({ student_id: 2, fellowship_id: 10, application_year: 2027, stage_of_application: "Awarded", is_finalist: true }),
      ]);
      expect(r.fellowshipsByFinalists).toHaveLength(2);
      expect(r.fellowshipsByFinalists.map((f) => f.name)).toEqual([
        "Fellowship — 2027",
        "Fellowship — 2026",
      ]);
      expect(r.fellowshipsByFinalists.find((f) => f.name === "Fellowship — 2027")).toMatchObject({
        total: 1,
        finalists: 1,
        awarded: 1,
      });
      expect(r.fellowshipsByFinalists.find((f) => f.name === "Fellowship — 2026")).toMatchObject({
        total: 1,
        finalists: 1,
        awarded: 0,
      });
    });

    it("keeps a null application year in its own bucket labeled 'year unknown'", () => {
      const r = compute([
        app({ student_id: 1, fellowship_id: 10, application_year: 2026, stage_of_application: "Finalist", is_finalist: true }),
        app({ student_id: 2, fellowship_id: 10, application_year: null, stage_of_application: "Finalist", is_finalist: true }),
        app({ student_id: 3, fellowship_id: 10, stage_of_application: "Finalist", is_finalist: true }),
      ]);
      expect(r.fellowshipsByFinalists).toHaveLength(2);
      const known = r.fellowshipsByFinalists.find((f) => f.name === "Fellowship — 2026");
      const unknown = r.fellowshipsByFinalists.find((f) => f.name === "Fellowship — year unknown");
      expect(known).toBeDefined();
      expect(unknown).toBeDefined();
      expect(known).toMatchObject({ total: 1, finalists: 1 });
      expect(unknown).toMatchObject({ total: 2, finalists: 2 });
    });
  });

  // ── Report 3: Class Standing ─────────────────────────────────────────────

  describe("byClassStanding", () => {
    it("orders known standings per CLASS_ORDER and appends Unknown last", () => {
      const r = compute(
        [],
        [],
        [
          student({ student_id: 1, full_name: "A", class_standing: "Senior" }),
          student({ student_id: 2, full_name: "B", class_standing: "Freshman" }),
          student({ student_id: 3, full_name: "C", class_standing: null }),
          student({ student_id: 4, full_name: "D", class_standing: "Freshman" }),
          student({ student_id: 5, full_name: "E", class_standing: "Doctoral" }),
        ],
      );
      expect(r.byClassStanding).toEqual([
        { standing: "Freshman", count: 2 },
        { standing: "Senior", count: 1 },
        { standing: "Doctoral", count: 1 },
        { standing: "Unknown", count: 1 },
      ]);
    });

    it("treats null class_standing as Unknown and omits unlisted standings", () => {
      const r = compute(
        [],
        [],
        [
          student({ student_id: 1, full_name: "A", class_standing: null }),
          student({ student_id: 2, full_name: "B", class_standing: "Alumni" }),
        ],
      );
      expect(r.byClassStanding).toEqual([{ standing: "Unknown", count: 1 }]);
    });
  });

  // ── Report 4: Advisor Activity ───────────────────────────────────────────

  describe("advisorActivity", () => {
    it("aggregates meetings and no-shows per advisor", () => {
      const r = compute(
        [],
        [
          meeting({ student_id: 1, advisor_id: 5, no_show: false, advisor: { advisor_name: "Ada" } }),
          meeting({ student_id: 2, advisor_id: 5, no_show: true, advisor: { advisor_name: "Ada" } }),
          meeting({ student_id: 3, advisor_id: 5, no_show: true, advisor: { advisor_name: "Ada" } }),
        ],
      );
      expect(r.advisorActivity).toEqual([{ id: 5, name: "Ada", total: 3, noShows: 2 }]);
    });

    it("falls back to Unassigned for null advisor relation and keeps the advisor_id", () => {
      const r = compute(
        [],
        [
          meeting({ student_id: 1, advisor_id: 7, no_show: true, advisor: null }),
          meeting({ student_id: 2, advisor_id: 7, no_show: false, advisor: null }),
        ],
      );
      expect(r.advisorActivity).toEqual([{ id: 7, name: "Unassigned", total: 2, noShows: 1 }]);
    });

    it("groups null advisor_id meetings under a single Unassigned bucket with id null", () => {
      const r = compute(
        [],
        [
          meeting({ student_id: 1, advisor_id: null, no_show: true, advisor: null }),
          meeting({ student_id: 2, advisor_id: null, no_show: false, advisor: null }),
        ],
      );
      expect(r.advisorActivity).toEqual([{ id: null, name: "Unassigned", total: 2, noShows: 1 }]);
    });

    it("sorts advisors by meeting count descending", () => {
      const r = compute(
        [],
        [
          meeting({ student_id: 1, advisor_id: 1, advisor: { advisor_name: "One" } }),
          meeting({ student_id: 2, advisor_id: 1, advisor: { advisor_name: "One" } }),
          meeting({ student_id: 3, advisor_id: 2, advisor: { advisor_name: "Two" } }),
          meeting({ student_id: 4, advisor_id: 3, advisor: { advisor_name: "Three" } }),
          meeting({ student_id: 5, advisor_id: 3, advisor: { advisor_name: "Three" } }),
          meeting({ student_id: 6, advisor_id: 3, advisor: { advisor_name: "Three" } }),
        ],
      );
      expect(r.advisorActivity.map((a) => ({ name: a.name, total: a.total }))).toEqual([
        { name: "Three", total: 3 },
        { name: "One", total: 2 },
        { name: "Two", total: 1 },
      ]);
    });
  });

  // ── Report 5: No-Show Trend ──────────────────────────────────────────────

  describe("noShowTrend", () => {
    it("buckets by YYYY-MM and sorts ascending", () => {
      const r = compute(
        [],
        [
          meeting({ student_id: 1, no_show: true, meeting_date: "2026-03-10" }),
          meeting({ student_id: 2, no_show: false, meeting_date: "2026-01-20" }),
          meeting({ student_id: 3, no_show: true, meeting_date: "2026-01-21" }),
          meeting({ student_id: 4, no_show: false, meeting_date: "2026-03-11" }),
        ],
      );
      expect(r.noShowTrend).toEqual([
        { month: "2026-01", total: 2, noShows: 1 },
        { month: "2026-03", total: 2, noShows: 1 },
      ]);
    });

    it("keeps only the last six observed months (not a calendar window)", () => {
      // 8 distinct observed months; sorted asc -> trailing six are 2025-05 .. 2026-06
      const months = [
        "2025-01", "2025-03", "2025-05", "2025-07", "2025-09", "2025-11",
        "2026-02", "2026-06",
      ];
      const r = compute(
        [],
        months.map((m, i) => meeting({ student_id: i + 1, no_show: false, meeting_date: `${m}-15` })),
      );
      expect(r.noShowTrend.map((t) => t.month)).toEqual([
        "2025-05", "2025-07", "2025-09", "2025-11", "2026-02", "2026-06",
      ]);
    });

    it("returns all months when there are six or fewer", () => {
      const r = compute(
        [],
        [
          meeting({ student_id: 1, meeting_date: "2026-05-01" }),
          meeting({ student_id: 2, meeting_date: "2026-04-01" }),
          meeting({ student_id: 3, meeting_date: "2026-03-01" }),
        ],
      );
      expect(r.noShowTrend.map((t) => t.month)).toEqual(["2026-03", "2026-04", "2026-05"]);
    });
  });

  // ── Report 6: Advising but no application ────────────────────────────────

  describe("advisingNoApplication", () => {
    it("includes students with meetings but no applications, preserving student order", () => {
      const students = [
        student({ student_id: 1, full_name: "Applied", class_standing: "Senior" }),
        student({ student_id: 2, full_name: "Advised Only", class_standing: "Freshman" }),
        student({ student_id: 3, full_name: "Neither" }),
        student({ student_id: 4, full_name: "Advised Only 2" }),
      ];
      const r = compute(
        [app({ student_id: 1, fellowship_id: 10 })],
        [
          meeting({ student_id: 1, advisor_id: 5 }),
          meeting({ student_id: 2, advisor_id: 5 }),
          meeting({ student_id: 4, advisor_id: 5 }),
        ],
        students,
      );
      expect(r.advisingNoApplication.map((s) => s.full_name)).toEqual(["Advised Only", "Advised Only 2"]);
    });
  });

  // ── Report 7: FT funnel ───────────────────────────────────────────────────

  describe("FT funnel", () => {
    it("dedupes attendees and splits applied vs not-yet-applied students", () => {
      const students = [
        student({ student_id: 1, full_name: "Attendee + Applied" }),
        student({ student_id: 2, full_name: "Attendee Only" }),
        student({ student_id: 3, full_name: "Applied Only" }),
      ];
      const r = compute(
        [app({ student_id: 1, fellowship_id: 10 })],
        [],
        students,
        [
          ft({ student_id: 1, attended: true }),
          ft({ student_id: 1, attended: true }), // duplicate attendance row
          ft({ student_id: 2, attended: true }),
          ft({ student_id: 3, attended: false }), // did not attend
        ],
      );
      expect(r.ftThenApplied.map((s) => s.full_name)).toEqual(["Attendee + Applied"]);
      expect(r.ftNotYetApplied.map((s) => s.full_name)).toEqual(["Attendee Only"]);
      expect(r.totals.ftAttendees).toBe(2);
    });

    it("does not list attendees that are absent from the students table", () => {
      const r = compute(
        [],
        [],
        [student({ student_id: 1, full_name: "Known Student" })],
        [ft({ student_id: 1, attended: true }), ft({ student_id: 99, attended: true })],
      );
      expect(r.ftThenApplied).toEqual([]);
      expect(r.ftNotYetApplied).toEqual([{ student_id: 1, full_name: "Known Student", major: null, class_standing: null }]);
      expect(r.totals.ftAttendees).toBe(2); // count includes unknown student 99
    });
  });

  // ── Totals ───────────────────────────────────────────────────────────────

  describe("totals", () => {
    it("counts students, applications, meetings, unique attendees, and awarded", () => {
      const r = compute(
        [
          app({ student_id: 1, fellowship_id: 10, stage_of_application: "Awarded" }),
          app({ student_id: 2, fellowship_id: 10, stage_of_application: "Awarded" }),
          app({ student_id: 1, fellowship_id: 11, stage_of_application: "Started" }), // duplicate student
        ],
        [
          meeting({ student_id: 1 }),
          meeting({ student_id: 2 }),
          meeting({ student_id: 2 }),
        ],
        [
          student({ student_id: 1, full_name: "A" }),
          student({ student_id: 2, full_name: "B" }),
        ],
        [ft({ student_id: 1, attended: true }), ft({ student_id: 2, attended: true }), ft({ student_id: 2, attended: true })],
      );
      expect(r.totals).toEqual({ students: 2, applications: 3, meetings: 3, ftAttendees: 2, awarded: 2 });
    });
  });
});