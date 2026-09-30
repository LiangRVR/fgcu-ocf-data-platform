/**
 * tests/e2e/operations.spec.ts
 *
 * Operational surfaces (advising, Fellowship Thursday attendance, scholarship
 * history, reports) against the Docker-local Supabase instance seeded by
 * scripts/e2e/run.mjs. Each surface gets one stability read (page heading plus
 * a seeded value) AND one real synthetic UI write — logging a meeting, adding
 * an attendance record, and recording a scholarship award — each asserted again
 * after a reload to prove the write went through the server, not just the
 * client state.
 *
 * Exactness: the reports test is FULLY SELF-CONTAINED. Every expectation is
 * EXACT absolute equality derived from the seed-exported totals
 * (`E2E_REPORT_TOTALS`) — no floors, no tolerances, and no cross-test or
 * cross-spec end-state totals. The test runs before any other write in this
 * spec, and it first neutralizes the only mutations other E2E specs can leave
 * behind that touch report metrics:
 *   - tests/e2e/application-workflow.spec.ts creates a student through the UI,
 *     so any student row that is not one of the two seeded students is removed
 *     first (making Total Students derive exactly from the seed export);
 *   - that same spec advances the seeded application's stage, so the seeded
 *     application is restored to its seed stage ("Submitted") first (making
 *     every displayed application-stage count equal the export's counts in
 *     either lane order).
 * The reports test then asserts all five report totals and EVERY application
 * stage from the export as exact absolute values. Its only write is the student
 * it creates through the UI (asserted as exactly +1 on Total Students, then
 * cleaned up), so the database is left in its seeded state.
 * The seeded student already has one OCF-sourced attendance record, so the
 * attendance write uses the "Honors College" source to stay distinguishable.
 */
import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required E2E environment variable "${name}". ` +
        "Run the lane via `pnpm run test:e2e` (scripts/e2e/run.mjs), which seeds " +
        "the Docker-local Supabase instance and exports the seeded identities.",
    );
  }
  return value;
}

const ACTIVE_EMAIL = requireEnv("E2E_ACTIVE_EMAIL");
const ACTIVE_PASSWORD = requireEnv("E2E_ACTIVE_PASSWORD");
const STUDENT_NAME = requireEnv("E2E_STUDENT_NAME");
const STUDENT_TWO_NAME = requireEnv("E2E_STUDENT_TWO_NAME");
const FELLOWSHIP_NAME = requireEnv("E2E_FELLOWSHIP_NAME");
const FELLOWSHIP_TWO_NAME = requireEnv("E2E_FELLOWSHIP_TWO_NAME");
const APPLICATION_YEAR = requireEnv("E2E_APPLICATION_YEAR");
const CYCLE_YEAR_OLD = requireEnv("E2E_CYCLE_YEAR_OLD");
const CYCLE_YEAR_NEW = requireEnv("E2E_CYCLE_YEAR_NEW");

/**
 * Report totals computed by the seed from the fixtures it created (re-read
 * through the service role, mirroring lib/reports/metrics.ts). The reports
 * test asserts every value below as an EXACT absolute number from this export;
 * the only delta allowed is a write the reports test itself performs.
 */
const REPORT_TOTALS = JSON.parse(requireEnv("E2E_REPORT_TOTALS")) as {
  students: number;
  applications: number;
  meetings: number;
  ftAttendees: number;
  awarded: number;
  applicationsByStage: Record<string, number>;
};

/**
 * Service-role helpers for direct database mutations from the E2E process.
 * These are used only to simulate race conditions that are impossible to
 * trigger reliably through the UI (e.g., deleting an application while the
 * advising dialog already has it selected).
 */
function serviceClient() {
  const apiUrl = requireEnv("SUPABASE_URL");
  const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  return createClient(apiUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function findStudentIdByName(name: string): Promise<number> {
  const service = serviceClient();
  const { data, error } = await service
    .from("student")
    .select("student_id")
    .eq("full_name", name)
    .single();
  if (error) {
    throw new Error(`findStudentIdByName(${name}): ${error.message}`);
  }
  return data.student_id as number;
}

async function findFellowshipIdByName(name: string): Promise<number> {
  const service = serviceClient();
  const { data, error } = await service
    .from("fellowship")
    .select("fellowship_id")
    .eq("fellowship_name", name)
    .single();
  if (error) {
    throw new Error(`findFellowshipIdByName(${name}): ${error.message}`);
  }
  return data.fellowship_id as number;
}

async function createApplicationForStudent(props: {
  studentName: string;
  fellowshipName: string;
  year: string;
  stage: string;
}): Promise<number> {
  const service = serviceClient();
  const [studentId, fellowshipId] = await Promise.all([
    findStudentIdByName(props.studentName),
    findFellowshipIdByName(props.fellowshipName),
  ]);
  const { data, error } = await service
    .from("application")
    .insert({
      student_id: studentId,
      fellowship_id: fellowshipId,
      destination_country: "E2E Testland",
      application_year: props.year,
      stage_of_application: props.stage,
      // Early stages carry neither flag under the local stage/flag invariant.
      is_semi_finalist: false,
      is_finalist: false,
    })
    .select("application_id")
    .single();
  if (error) {
    throw new Error(`createApplicationForStudent: ${error.message}`);
  }
  return data.application_id as number;
}

async function deleteApplication(applicationId: number): Promise<void> {
  const service = serviceClient();
  const { error } = await service.from("application").delete().eq("application_id", applicationId);
  if (error) {
    throw new Error(`deleteApplication(${applicationId}): ${error.message}`);
  }
}

/**
 * The exact names of the two students the seed creates (see
 * tests/e2e/fixtures/seed.ts). The second name is derived from the exported
 * first name because both share the seed's single RUN_TOKEN. Any student row
 * that is not one of these two was created by another E2E spec and is removed
 * before the reports assertions so Total Students derives exactly from the
 * export (self-contained, order-independent).
 */
const SEEDED_STUDENT_NAMES = new Set([
  STUDENT_NAME,
  STUDENT_NAME.replace(/^E2E Student /, "E2E Student Two "),
]);

// Unique marker so the advising write can be told apart from the seeded meeting.
const MEETING_NOTE = `E2E UI meeting ${Date.now()}`;

async function signInAsActive(page: Page): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(ACTIVE_EMAIL);
  await page.locator("#password").fill(ACTIVE_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

/**
 * The seeded student name renders in both the desktop table and the hidden
 * mobile card list; restrict to a visible occurrence so the assertion is
 * layout-independent.
 */
function visibleStudentName(page: Page) {
  return page.getByText(STUDENT_NAME, { exact: true }).filter({ visible: true }).first();
}

/**
 * The reports page renders each System Totals stat as a value element
 * (`div.text-3xl`) in the same `.space-y-2` wrapper as its title. Scoping to
 * the "System Totals" section keeps titles like "FT Attendees" unambiguous
 * against the funnel section below.
 */
function statCardValue(page: Page, title: string) {
  return page
    .locator("section", { hasText: "System Totals" })
    .getByText(title, { exact: true })
    .locator("..")
    .locator("..")
    .locator("div.text-3xl");
}

/**
 * Delete one student row (by its unique name) through the desktop table's
 * trash action and the confirmation dialog. Used to remove student rows that
 * other E2E specs created and to clean up the reports test's own student.
 */
async function deleteStudentByName(page: Page, name: string): Promise<void> {
  const row = page.locator("table tbody tr", { hasText: name }).first();
  await expect(row).toBeVisible();
  await row.locator("button:has(svg.lucide-trash-2)").click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await expect(page.locator("table tbody tr", { hasText: name })).toHaveCount(0);
}

/**
 * Remove every student row that is not one of the two seeded students. The only
 * spec that creates students through the UI is application-workflow.spec.ts;
 * deleting those rows (when present) makes Total Students derive exactly from
 * the seed export whether or not that spec ran.
 */
async function deleteForeignStudents(page: Page): Promise<void> {
  await page.goto("/students");
  // Wait for the roster table to render before enumerating its rows.
  await expect(page.locator("table tbody tr").first()).toBeVisible();

  const rows = page.locator("table tbody tr");
  const count = await rows.count();
  const foreignNames: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const name = (await rows.nth(i).locator("td").first().innerText())?.trim() ?? "";
    if (!SEEDED_STUDENT_NAMES.has(name)) foreignNames.push(name);
  }
  for (const name of foreignNames) {
    await deleteStudentByName(page, name);
  }
}

/**
 * Restore the seeded application to its seed stage ("Submitted"). The
 * application-workflow spec advances it to "Under Review"; restoring it makes
 * every displayed application-stage count equal the export's counts in either
 * lane order. The write is idempotent (it also runs when the seed stage is
 * already present).
 */
async function restoreSeededApplicationStage(page: Page): Promise<void> {
  await page.goto("/applications");
  const seededApplicationRow = page.locator("table tbody tr", { hasText: STUDENT_NAME });
  await expect(seededApplicationRow).toBeVisible();

  await seededApplicationRow.getByTitle("Edit application").click();
  await page.locator("#app-stage").click();
  await page.getByRole("option", { name: "Submitted", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Save Changes" }).click();
  await expect(seededApplicationRow).toContainText("Submitted");

  // Reload → the restored stage is persisted server-side.
  await page.reload();
  await expect(seededApplicationRow).toContainText("Submitted");
}

/**
 * Delete one advising meeting row (by its unique notes marker) through the
 * desktop table's "Delete meeting" action and the confirmation dialog. The
 * advising write tests clean up after themselves so the reports test's EXACT
 * `Advising Meetings` total always derives from the seed export alone.
 */
async function deleteMeeting(page: Page, note: string): Promise<void> {
  const row = page.locator("table tbody tr", { hasText: note });
  await expect(row).toBeVisible();
  await row.getByTitle("Delete meeting").click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await expect(page.locator("table tbody tr", { hasText: note })).toHaveCount(0);
}

/**
 * Assert the reports page against the seed export EXACTLY: all five System
 * Totals, every application stage from `E2E_REPORT_TOTALS`, and the funnel's
 * stage-count consistency (only the exported stages displayed, summing to the
 * applications total). `expectedStudents` is the only parameterized value —
 * it carries the reports test's own +1 student write.
 */
async function assertReportsTotals(page: Page, expectedStudents: number): Promise<void> {
  await expect(page.getByRole("heading", { name: "Reports" })).toBeVisible();

  await expect(statCardValue(page, "Total Students")).toHaveText(String(expectedStudents));
  await expect(statCardValue(page, "Applications")).toHaveText(
    String(REPORT_TOTALS.applications),
  );
  await expect(statCardValue(page, "Advising Meetings")).toHaveText(
    String(REPORT_TOTALS.meetings),
  );
  await expect(statCardValue(page, "FT Attendees")).toHaveText(String(REPORT_TOTALS.ftAttendees));
  await expect(statCardValue(page, "Awards")).toHaveText(String(REPORT_TOTALS.awarded));

  // Every application stage from the seed export, asserted exactly.
  for (const [stage, count] of Object.entries(REPORT_TOTALS.applicationsByStage)) {
    await expect(page.locator("li", { hasText: stage }).getByRole("link")).toHaveText(
      String(count),
    );
  }

  // No stage besides those in the export is displayed, and the displayed
  // counts always sum to the applications total.
  const stageLinks = page.locator('a[href^="/applications?stage="]');
  await expect(stageLinks).toHaveCount(Object.keys(REPORT_TOTALS.applicationsByStage).length);
  const stageNumbers = await stageLinks.allTextContents();
  const stageSum = stageNumbers.reduce((sum, text) => sum + Number(text.trim()), 0);
  expect(stageSum).toBe(REPORT_TOTALS.applications);
}

test.describe("operational surfaces", () => {
  test.setTimeout(60_000);

  test("reports page shows exact absolute metrics derived only from the seed export and its own write", async ({ page }) => {
    await signInAsActive(page);

    // Fail loudly if the second seeded student's name could not be derived.
    expect(SEEDED_STUDENT_NAMES.size).toBe(2);

    // ── Self-containment: neutralize mutations other tests/specs can leave ──
    // Remove student rows created by other E2E specs (application-workflow
    // creates one through the UI) so Total Students derives exactly from the
    // seed export; only the two seeded students remain.
    await deleteForeignStudents(page);

    // Restore the seeded application to its seed stage ("Submitted") so the
    // application-stage funnel converges to the export's counts whether or not
    // application-workflow.spec.ts already advanced that same application.
    await restoreSeededApplicationStage(page);

    // ── Baseline: every report metric exactly at its seed-exported value ──
    await page.goto("/reports");
    await assertReportsTotals(page, REPORT_TOTALS.students);

    // ── The reports test's own write: create a student through the UI ──
    const studentName = `E2E Reports Student ${Date.now()}`;
    await page.goto("/students");
    await page.getByRole("button", { name: "Add Student" }).click();
    await page.locator("#full_name").fill(studentName);
    await page.locator("#email").fill(`e2e-reports-${Date.now()}@example.com`);
    await page.locator("#us_citizen").check();
    await page.getByRole("button", { name: "Create Student" }).click();
    await expect(page.locator("table tbody tr", { hasText: studentName })).toBeVisible();

    // Reload → the student is persisted server-side.
    await page.reload();
    await expect(page.locator("table tbody tr", { hasText: studentName })).toBeVisible();

    // ── Post-write: exactly the seed export plus this test's own +1 student ──
    await page.goto("/reports");
    await assertReportsTotals(page, REPORT_TOTALS.students + 1);

    // ── Clean up this test's own write so the database is left seeded ──
    await page.goto("/students");
    await deleteStudentByName(page, studentName);
  });

  test("advising page renders the seeded meeting", async ({ page }) => {
    await signInAsActive(page);

    await page.goto("/advising");
    await expect(page.getByRole("heading", { name: "Advising", exact: true })).toBeVisible();
    await expect(visibleStudentName(page)).toBeVisible();
  });

  test("an advisor can log an advising meeting that persists across a reload", async ({ page }) => {
    await signInAsActive(page);

    await page.goto("/advising");
    await page.getByRole("button", { name: "Log Meeting" }).click();

    await page.locator("#student_id").click();
    await page.getByRole("option", { name: STUDENT_NAME, exact: true }).click();
    await page.locator("#meeting_date").fill("2026-09-15");
    await page.locator("#meeting_mode").click();
    await page.getByRole("option", { name: "In-Person", exact: true }).click();
    await page.locator("#notes").fill(MEETING_NOTE);

    await page.getByRole("dialog").getByRole("button", { name: "Log Meeting" }).click();

    // The new row is the only one carrying the unique notes marker.
    const row = page.locator("table tbody tr", { hasText: MEETING_NOTE });
    await expect(row).toBeVisible();
    await expect(row).toContainText(STUDENT_NAME);

    // Reload → the meeting is persisted server-side.
    await page.reload();
    await expect(page.locator("table tbody tr", { hasText: MEETING_NOTE })).toBeVisible();
  });

  test("an advisor can log a General Advising meeting (null application) that persists across a reload", async ({ page }) => {
    await signInAsActive(page);

    const generalNote = `E2E General Advising ${Date.now()}`;

    await page.goto("/advising");
    await page.getByRole("button", { name: "Log Meeting" }).click();

    await page.locator("#student_id").click();
    await page.getByRole("option", { name: STUDENT_NAME, exact: true }).click();

    // With no application selected the form defaults to General Advising (null
    // application_id) — the trigger must show it, not a stale application.
    await expect(page.locator("#application_id")).toContainText("General Advising");

    await page.locator("#meeting_date").fill("2026-09-20");
    await page.locator("#meeting_mode").click();
    await page.getByRole("option", { name: "In-Person", exact: true }).click();
    await page.locator("#notes").fill(generalNote);

    await page.getByRole("dialog").getByRole("button", { name: "Log Meeting" }).click();

    // The new row renders General Advising in its Context cell.
    const row = page.locator("table tbody tr", { hasText: generalNote });
    await expect(row).toBeVisible();
    await expect(row).toContainText(STUDENT_NAME);
    await expect(row).toContainText("General Advising");
    await expect(row).not.toContainText("year unknown");

    // Reload → the General Advising context is persisted server-side.
    await page.reload();
    const rowAfterReload = page.locator("table tbody tr", { hasText: generalNote });
    await expect(rowAfterReload).toBeVisible();
    await expect(rowAfterReload).toContainText("General Advising");

    // Clean up so the reports totals stay at the seed export.
    await deleteMeeting(page, generalNote);
  });

  test("an advisor can log an application-scoped meeting whose cycle label persists across a reload", async ({ page }) => {
    await signInAsActive(page);

    const appMeetingNote = `E2E App-Scoped Meeting ${Date.now()}`;
    // The second student's CURRENT_CYCLE application on the second fellowship:
    // a cycle-aware label, never a bare fellowship name.
    const cycleLabel = `${FELLOWSHIP_TWO_NAME} — ${CYCLE_YEAR_NEW}`;

    await page.goto("/advising");
    await page.getByRole("button", { name: "Log Meeting" }).click();

    await page.locator("#student_id").click();
    await page.getByRole("option", { name: STUDENT_TWO_NAME, exact: true }).click();

    // The same-fellowship pair is offered cycle-aware and distinguishable.
    await page.locator("#application_id").click();
    await expect(
      page.getByRole("option", { name: `${FELLOWSHIP_TWO_NAME} — ${CYCLE_YEAR_OLD}`, exact: true }),
    ).toBeVisible();
    await page.getByRole("option", { name: cycleLabel, exact: true }).click();

    await page.locator("#meeting_date").fill("2026-09-21");
    await page.locator("#meeting_mode").click();
    await page.getByRole("option", { name: "Virtual", exact: true }).click();
    await page.locator("#notes").fill(appMeetingNote);

    await page.getByRole("dialog").getByRole("button", { name: "Log Meeting" }).click();

    // The row's Context cell shows the application's cycle label.
    const row = page.locator("table tbody tr", { hasText: appMeetingNote });
    await expect(row).toBeVisible();
    await expect(row).toContainText(STUDENT_TWO_NAME);
    await expect(row).toContainText(cycleLabel);

    // Reload → the application scoping persists server-side.
    await page.reload();
    const rowAfterReload = page.locator("table tbody tr", { hasText: appMeetingNote });
    await expect(rowAfterReload).toBeVisible();
    await expect(rowAfterReload).toContainText(cycleLabel);

    // Clean up so the reports totals stay at the seed export.
    await deleteMeeting(page, appMeetingNote);
  });

  test("changing the student in the Log Meeting dialog refreshes the application options, clears a stale selection, and persists General Advising after submit/reload", async ({ page }) => {
    await signInAsActive(page);

    await page.goto("/advising");
    await page.getByRole("button", { name: "Log Meeting" }).click();

    const dialog = page.getByRole("dialog");
    const firstStudentLabel = `${FELLOWSHIP_NAME} — ${APPLICATION_YEAR}`;
    const staleNote = `E2E stale-student switch ${Date.now()}`;

    // Select the seeded student and pick one of their applications.
    await dialog.locator("#student_id").click();
    await page.getByRole("option", { name: STUDENT_NAME, exact: true }).click();
    await dialog.locator("#application_id").click();
    await page.getByRole("option", { name: firstStudentLabel, exact: true }).click();
    await expect(dialog.locator("#application_id")).toContainText(firstStudentLabel);

    // Switch to the second student → the stale application selection must clear
    // back to General Advising (never carry another student's application over).
    await dialog.locator("#student_id").click();
    await page.getByRole("option", { name: STUDENT_TWO_NAME, exact: true }).click();
    await expect(dialog.locator("#application_id")).toContainText("General Advising");
    await expect(dialog.locator("#application_id")).not.toContainText(firstStudentLabel);

    // The option list is refreshed to the second student's applications: the
    // same-fellowship different-cycle pair renders as two distinct options.
    await dialog.locator("#application_id").click();
    await expect(
      page.getByRole("option", { name: `${FELLOWSHIP_TWO_NAME} — ${CYCLE_YEAR_OLD}`, exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("option", { name: `${FELLOWSHIP_TWO_NAME} — ${CYCLE_YEAR_NEW}`, exact: true }),
    ).toBeVisible();
    // The first student's application is no longer selectable for this student.
    await expect(page.getByRole("option", { name: firstStudentLabel, exact: true })).toHaveCount(0);

    // Complete and submit the meeting with the reset General Advising context.
    await page.keyboard.press("Escape");
    await page.locator("#meeting_date").fill("2026-09-22");
    await page.locator("#meeting_mode").click();
    await page.getByRole("option", { name: "Virtual", exact: true }).click();
    await page.locator("#notes").fill(staleNote);
    await page.getByRole("dialog").getByRole("button", { name: "Log Meeting" }).click();

    // The created row renders General Advising in its Context cell.
    const row = page.locator("table tbody tr", { hasText: staleNote });
    await expect(row).toContainText("General Advising");

    // Reload → the General Advising context is persisted server-side.
    await page.reload();
    const rowAfterReload = page.locator("table tbody tr", { hasText: staleNote });
    await expect(rowAfterReload).toContainText("General Advising");

    await deleteMeeting(page, staleNote);
  });

  test("submitting a stale application selection resets to General Advising, refreshes options, and removes the stale option after reload", async ({ page }) => {
    await signInAsActive(page);

    // ── Setup: create an application that will become stale mid-dialog ──────
    const staleApplicationLabel = `${FELLOWSHIP_TWO_NAME} — ${APPLICATION_YEAR}`;
    const staleApplicationId = await createApplicationForStudent({
      studentName: STUDENT_NAME,
      fellowshipName: FELLOWSHIP_TWO_NAME,
      year: APPLICATION_YEAR,
      stage: "Submitted",
    });

    const recoveryNote = `E2E stale-application recovery ${Date.now()}`;

    await page.goto("/advising");
    await page.getByRole("button", { name: "Log Meeting" }).click();

    const dialog = page.getByRole("dialog");

    // Select the seeded student and the freshly-created application.
    await dialog.locator("#student_id").click();
    await page.getByRole("option", { name: STUDENT_NAME, exact: true }).click();
    await dialog.locator("#application_id").click();
    await page.getByRole("option", { name: staleApplicationLabel, exact: true }).click();
    await expect(dialog.locator("#application_id")).toContainText(staleApplicationLabel);

    // ── Race: delete the application from under the dialog ──────────────────
    await deleteApplication(staleApplicationId);

    await page.locator("#meeting_date").fill("2026-09-23");
    await page.locator("#meeting_mode").click();
    await page.getByRole("option", { name: "In-Person", exact: true }).click();
    await page.locator("#notes").fill(recoveryNote);

    // Submitting with the now-invalid application must trigger server-side recovery.
    await page.getByRole("dialog").getByRole("button", { name: "Log Meeting" }).click();

    await expect(
      page.getByText("Selected application is no longer valid for this student. Reset to General Advising."),
    ).toBeVisible();
    await expect(dialog.locator("#application_id")).toContainText("General Advising");

    // The refresh should remove the stale option from the dropdown.
    await dialog.locator("#application_id").click();
    await expect(
      page.getByRole("option", { name: staleApplicationLabel, exact: true }),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");

    // Complete the meeting with the recovered General Advising context.
    await page.getByRole("dialog").getByRole("button", { name: "Log Meeting" }).click();

    const row = page.locator("table tbody tr", { hasText: recoveryNote });
    await expect(row).toBeVisible();
    await expect(row).toContainText(STUDENT_NAME);
    await expect(row).toContainText("General Advising");

    // Reload → the recovered General Advising context is persisted, and the
    // stale application option is still absent from the refreshed option list.
    await page.reload();
    const rowAfterReload = page.locator("table tbody tr", { hasText: recoveryNote });
    await expect(rowAfterReload).toContainText("General Advising");

    await page.getByRole("button", { name: "Log Meeting" }).click();
    await dialog.locator("#student_id").click();
    await page.getByRole("option", { name: STUDENT_NAME, exact: true }).click();
    await dialog.locator("#application_id").click();
    await expect(
      page.getByRole("option", { name: staleApplicationLabel, exact: true }),
    ).toHaveCount(0);
    // Close the dropdown, then close the dialog so table actions are reachable.
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");

    await deleteMeeting(page, recoveryNote);
  });

  test("an application belonging to another student cannot be selected in the advising dialog", async ({ page }) => {
    await signInAsActive(page);

    await page.goto("/advising");
    await page.getByRole("button", { name: "Log Meeting" }).click();

    const dialog = page.getByRole("dialog");
    const firstStudentLabel = `${FELLOWSHIP_NAME} — ${APPLICATION_YEAR}`;
    const secondStudentLabel = `${FELLOWSHIP_TWO_NAME} — ${CYCLE_YEAR_NEW}`;

    // For the second student, only their own applications (+ General Advising)
    // are offered — the first student's application must not appear at all.
    await dialog.locator("#student_id").click();
    await page.getByRole("option", { name: STUDENT_TWO_NAME, exact: true }).click();
    await dialog.locator("#application_id").click();
    await expect(page.getByRole("option", { name: "General Advising", exact: true })).toBeVisible();
    await expect(page.getByRole("option", { name: secondStudentLabel, exact: true })).toBeVisible();
    await expect(page.getByRole("option", { name: firstStudentLabel, exact: true })).toHaveCount(0);

    // Close the application dropdown, then check the reverse direction: the
    // first student's options never include the second student's applications.
    await page.keyboard.press("Escape");
    await dialog.locator("#student_id").click();
    await page.getByRole("option", { name: STUDENT_NAME, exact: true }).click();
    await dialog.locator("#application_id").click();
    await expect(page.getByRole("option", { name: firstStudentLabel, exact: true })).toBeVisible();
    await expect(page.getByRole("option", { name: secondStudentLabel, exact: true })).toHaveCount(0);
  });

  test("fellowship-thursday page renders the seeded attendance", async ({ page }) => {
    await signInAsActive(page);

    await page.goto("/fellowship-thursday");
    await expect(page.getByRole("heading", { name: "Fellowship Thursday" })).toBeVisible();
    await expect(visibleStudentName(page)).toBeVisible();
  });

  test("an advisor can add Fellowship Thursday attendance that persists across a reload", async ({ page }) => {
    await signInAsActive(page);

    await page.goto("/fellowship-thursday");
    await page.getByRole("button", { name: "Add Record" }).click();

    await page.locator("#ft_student_id").click();
    await page.getByRole("option", { name: STUDENT_NAME, exact: true }).click();

    // Explicitly set the attendance state to "not attended" so the created
    // record's state is asserted, not just its existence.
    const attendedBox = page.locator("#ft_attended");
    await expect(attendedBox).toBeChecked(); // dialog defaults to attended
    await attendedBox.uncheck();

    // source "HC" distinguishes this record from the seeded OCF-sourced one.
    await page.locator("#ft_source_info").click();
    await page.getByRole("option", { name: "Honors College", exact: true }).click();

    await page.getByRole("dialog").getByRole("button", { name: "Add Record" }).click();

    // The created record renders with the "not attended" state visible.
    const hcRow = page
      .locator("table tbody tr", { hasText: STUDENT_NAME })
      .filter({ hasText: "Honors College" });
    await expect(hcRow).toBeVisible();
    await expect(hcRow).toContainText("No");

    // Reload → the attendance record AND its state persist server-side.
    await page.reload();
    const hcRowAfterReload = page
      .locator("table tbody tr", { hasText: STUDENT_NAME })
      .filter({ hasText: "Honors College" });
    await expect(hcRowAfterReload).toBeVisible();
    await expect(hcRowAfterReload).toContainText("No");
  });

  test("scholarship-history page renders the seeded award record", async ({ page }) => {
    await signInAsActive(page);

    await page.goto("/scholarship-history");
    await expect(page.getByRole("heading", { name: "Scholarship History" })).toBeVisible();
    await expect(visibleStudentName(page)).toBeVisible();
  });

  test("an advisor can add scholarship history that persists across a reload", async ({ page }) => {
    await signInAsActive(page);

    await page.goto("/scholarship-history");
    await page.getByRole("button", { name: "Add Record" }).click();

    await page.locator("#sh_student_id").click();
    await page.getByRole("option", { name: STUDENT_NAME, exact: true }).click();
    await page.locator("#sh_fellowship_id").click();
    await page.getByRole("option", { name: FELLOWSHIP_NAME, exact: true }).click();

    await page.getByRole("dialog").getByRole("button", { name: "Add Record" }).click();

    // The seeded student now has 2 scholarship rows (the seeded award plus the
    // one just added through the UI).
    const studentRows = page.locator("table tbody tr", { hasText: STUDENT_NAME });
    await expect(studentRows).toHaveCount(2);

    // Reload → the new award record is persisted server-side.
    await page.reload();
    await expect(page.locator("table tbody tr", { hasText: STUDENT_NAME })).toHaveCount(2);
  });
});