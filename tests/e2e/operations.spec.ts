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
const FELLOWSHIP_NAME = requireEnv("E2E_FELLOWSHIP_NAME");

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