/**
 * tests/e2e/lifecycle.spec.ts
 *
 * Entity-lifecycle UI flows (plan Work 5 / R3-R5) against the Docker-local
 * Supabase instance seeded by scripts/e2e/run.mjs. The lane's ACTIVE advisor is
 * a trusted OCF administrator (Auth app_metadata.ocf_admin=true), which is what
 * lets the confirmation-backed Archive/Restore UI flows exercise the
 * admin-only `lifecycle_transition` RPC end-to-end through the browser.
 *
 * Covers, UI-first (semantic locators, auto-waiting assertions, no sleeps):
 *   - confirmation-backed Archive Student and Archive Fellowship: the dialog
 *     requires an explicit confirm, cancel leaves the row untouched, and the
 *     confirmed transition removes the record from the active roster;
 *   - restore from the explicit archive view (`?view=archived`): the archived
 *     row renders the "Archived since …" badge and a Restore action that
 *     returns it to the active roster;
 *   - active-workflow selector exclusion: an archived student/fellowship is
 *     never offered in the application creation form's selectors, while the
 *     active seeded records remain selectable;
 *   - historical archived context: an archived student's detail page keeps the
 *     Archived badge, its historical application, and a Restore action (child
 *     workflow actions hidden), and restore re-exposes the active actions;
 *   - the applications table offers NO Delete control (applications are
 *     historical records; the destructive delete control is removed by design).
 *
 * Fixture policy: every test seeds its OWN synthetic student/fellowship (and,
 * where needed, one application) through the service role, and cleans up in a
 * `finally` block through the service role — never through a destructive UI
 * path. Archive/restore lifecycle state is always returned to the seeded
 * baseline so the reports spec's exact totals and the other specs' seeded-name
 * assertions stay deterministic (the lane runs with `workers: 1`).
 */
import { test, expect, type Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

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

async function signInAsActive(page: Page): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(ACTIVE_EMAIL);
  await page.locator("#password").fill(ACTIVE_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

/** Service-role client for synthetic fixture setup/cleanup only. */
function serviceClient(): SupabaseClient {
  const apiUrl = requireEnv("SUPABASE_URL");
  const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  return createClient(apiUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** Seed a fresh active student; returns its id. */
async function seedStudent(name: string): Promise<number> {
  const service = serviceClient();
  const { data, error } = await service
    .from("student")
    .insert({ full_name: name, email: `e2e-lifecycle-${Date.now()}-${name}@example.com`, us_citizen: true })
    .select("student_id")
    .single();
  if (error) throw new Error(`seed student ${name}: ${error.message}`);
  return data.student_id as number;
}

/** Seed a fresh active fellowship; returns its id. */
async function seedFellowship(name: string): Promise<number> {
  const service = serviceClient();
  const { data, error } = await service
    .from("fellowship")
    .insert({ fellowship_name: name })
    .select("fellowship_id")
    .single();
  if (error) throw new Error(`seed fellowship ${name}: ${error.message}`);
  return data.fellowship_id as number;
}

/** Seed one application linking the student/fellowship pair. */
async function seedApplication(studentId: number, fellowshipId: number): Promise<number> {
  const service = serviceClient();
  const { data, error } = await service
    .from("application")
    .insert({
      student_id: studentId,
      fellowship_id: fellowshipId,
      destination_country: "E2E Lifecycle",
      application_year: 2024,
      stage_of_application: "Submitted",
      is_semi_finalist: false,
      is_finalist: false,
    })
    .select("application_id")
    .single();
  if (error) throw new Error(`seed application for student ${studentId}: ${error.message}`);
  return data.application_id as number;
}

/**
 * Set archive state through the service role (fixture setup only). The RPC is
 * admin-only and the UI flows under test drive the real confirmation path;
 * direct service-role writes are used solely to stage/clean an archive state
 * for the selector- and detail-page assertions.
 */
async function setStudentArchived(studentId: number, archived: boolean): Promise<void> {
  const service = serviceClient();
  const { error } = await service
    .from("student")
    .update({ archived_at: archived ? new Date().toISOString() : null })
    .eq("student_id", studentId);
  if (error) throw new Error(`set student ${studentId} archived=${archived}: ${error.message}`);
}

async function setFellowshipArchived(fellowshipId: number, archived: boolean): Promise<void> {
  const service = serviceClient();
  const { error } = await service
    .from("fellowship")
    .update({ archived_at: archived ? new Date().toISOString() : null })
    .eq("fellowship_id", fellowshipId);
  if (error) throw new Error(`set fellowship ${fellowshipId} archived=${archived}: ${error.message}`);
}

async function deleteStudent(studentId: number): Promise<void> {
  const service = serviceClient();
  const { error } = await service.from("student").delete().eq("student_id", studentId);
  if (error) throw new Error(`cleanup student ${studentId}: ${error.message}`);
}

async function deleteFellowship(fellowshipId: number): Promise<void> {
  const service = serviceClient();
  const { error } = await service.from("fellowship").delete().eq("fellowship_id", fellowshipId);
  if (error) throw new Error(`cleanup fellowship ${fellowshipId}: ${error.message}`);
}

async function deleteApplication(applicationId: number): Promise<void> {
  const service = serviceClient();
  const { error } = await service.from("application").delete().eq("application_id", applicationId);
  if (error) throw new Error(`cleanup application ${applicationId}: ${error.message}`);
}

test.describe("entity lifecycle", () => {
  test.setTimeout(60_000);

  test("confirmation-backed Archive Student removes the row from the active roster; the archived view shows Restore and Restore returns it", async ({ page }) => {
    const name = `E2E Lifecycle Student ${Date.now()}`;
    const studentId = await seedStudent(name);
    try {
      await signInAsActive(page);
      await page.goto("/students");

      // The fresh student renders in the active roster.
      const row = page.locator("table tbody tr", { hasText: name });
      await expect(row).toBeVisible();

      // Cancel leaves the row untouched (confirmation is required).
      await row.getByRole("button", { name: "Archive Student" }).click();
      const dialog = page.getByRole("alertdialog");
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("heading", { name: "Archive Student" })).toBeVisible();
      await expect(dialog).toContainText(name);
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(dialog).toBeHidden();

      // A fresh server render proves cancel did NOT archive the student.
      await page.goto("/students");
      await expect(page.locator("table tbody tr", { hasText: name })).toBeVisible();

      // Confirming archives: the row leaves the ACTIVE roster on the server.
      await page
        .locator("table tbody tr", { hasText: name })
        .getByRole("button", { name: "Archive Student" })
        .click();
      await page.getByRole("alertdialog").getByRole("button", { name: "Archive Student" }).click();
      await expect(page.getByRole("alertdialog")).toBeHidden();
      await page.goto("/students");
      await expect(page.locator("table tbody tr", { hasText: name })).toHaveCount(0);

      // The explicit archive view shows the archived row with its Restore
      // affordance (the "Archived since …" badge renders on the detail page,
      // covered by the historical-context test below).
      await page.goto("/students?view=archived");
      const archivedRow = page.locator("table tbody tr", { hasText: name });
      await expect(archivedRow).toBeVisible();
      await expect(archivedRow.getByRole("button", { name: "Restore Student" })).toBeVisible();

      // Restore from the archive view returns the student to the active roster.
      await archivedRow.getByRole("button", { name: "Restore Student" }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "Restore Student" }).click();
      await expect(page.getByRole("alertdialog")).toBeHidden();
      await page.goto("/students?view=archived");
      await expect(page.locator("table tbody tr", { hasText: name })).toHaveCount(0);

      await page.goto("/students");
      await expect(page.locator("table tbody tr", { hasText: name })).toBeVisible();
    } finally {
      await deleteStudent(studentId);
    }
  });

  test("confirmation-backed Archive Fellowship removes the row from the active catalog; the archived view shows Restore and Restore returns it", async ({ page }) => {
    const name = `E2E Lifecycle Fellowship ${Date.now()}`;
    const fellowshipId = await seedFellowship(name);
    try {
      await signInAsActive(page);
      await page.goto("/fellowships");

      const row = page.locator("table tbody tr", { hasText: name });
      await expect(row).toBeVisible();

      // Cancel leaves the row untouched.
      await row.getByRole("button", { name: "Archive Fellowship" }).click();
      const dialog = page.getByRole("alertdialog");
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("heading", { name: "Archive Fellowship" })).toBeVisible();
      await expect(dialog).toContainText(name);
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(dialog).toBeHidden();

      // A fresh server render proves cancel did NOT archive the fellowship.
      await page.goto("/fellowships");
      await expect(page.locator("table tbody tr", { hasText: name })).toBeVisible();

      // Confirming archives: the row leaves the ACTIVE catalog on the server.
      await page
        .locator("table tbody tr", { hasText: name })
        .getByRole("button", { name: "Archive Fellowship" })
        .click();
      await page.getByRole("alertdialog").getByRole("button", { name: "Archive Fellowship" }).click();
      await expect(page.getByRole("alertdialog")).toBeHidden();
      await page.goto("/fellowships");
      await expect(page.locator("table tbody tr", { hasText: name })).toHaveCount(0);

      // The explicit archive view shows the archived row with its Restore
      // affordance.
      await page.goto("/fellowships?view=archived");
      const archivedRow = page.locator("table tbody tr", { hasText: name });
      await expect(archivedRow).toBeVisible();
      await expect(archivedRow.getByRole("button", { name: "Restore Fellowship" })).toBeVisible();

      // Restore from the archive view returns the fellowship to the active catalog.
      await archivedRow.getByRole("button", { name: "Restore Fellowship" }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "Restore Fellowship" }).click();
      await expect(page.getByRole("alertdialog")).toBeHidden();
      await page.goto("/fellowships?view=archived");
      await expect(page.locator("table tbody tr", { hasText: name })).toHaveCount(0);

      await page.goto("/fellowships");
      await expect(page.locator("table tbody tr", { hasText: name })).toBeVisible();
    } finally {
      await deleteFellowship(fellowshipId);
    }
  });

  test("an archived student is excluded from the active application creation selector", async ({ page }) => {
    const name = `E2E Lifecycle Archived Student ${Date.now()}`;
    const studentId = await seedStudent(name);
    try {
      // Fixture staging: the student is archived before the selector is opened.
      await setStudentArchived(studentId, true);

      await signInAsActive(page);
      await page.goto("/applications");
      await page.getByRole("button", { name: "New Application" }).click();

      await page.locator("#app-student").click();
      // The archived student is never offered; the seeded active students are.
      await expect(page.getByRole("option", { name, exact: true })).toHaveCount(0);
      await expect(page.getByRole("option", { name: STUDENT_NAME, exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
    } finally {
      await deleteStudent(studentId);
    }
  });

  test("an archived fellowship is excluded from the active application creation selector", async ({ page }) => {
    const name = `E2E Lifecycle Archived Fellowship ${Date.now()}`;
    const fellowshipId = await seedFellowship(name);
    try {
      await setFellowshipArchived(fellowshipId, true);

      await signInAsActive(page);
      await page.goto("/applications");
      await page.getByRole("button", { name: "New Application" }).click();

      await page.locator("#app-fellowship").click();
      await expect(page.getByRole("option", { name, exact: true })).toHaveCount(0);
      await expect(page.getByRole("option", { name: FELLOWSHIP_NAME, exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
    } finally {
      await deleteFellowship(fellowshipId);
    }
  });

  test("an archived student's detail page keeps the badge, historical application, and Restore, and restore re-exposes the active actions", async ({ page }) => {
    const name = `E2E Lifecycle History Student ${Date.now()}`;
    const studentId = await seedStudent(name);
    const fellowshipId = await seedFellowship(`${name} Fellowship`);
    const applicationId = await seedApplication(studentId, fellowshipId);
    try {
      await setStudentArchived(studentId, true);

      await signInAsActive(page);
      await page.goto(`/students/${studentId}`);
      await expect(page.getByRole("heading", { name })).toBeVisible();

      // Historical archived context: the badge and the historical application
      // still render, while the child workflow action is hidden. The badge
      // carries the explicit "Student Archived" lifecycle label (R9) and no
      // destructive Delete control exists on the archived detail surface.
      await expect(page.getByText(/Archived since/)).toBeVisible();
      await expect(page.getByText(/Student Archived since/)).toBeVisible();
      await expect(page.getByRole("button", { name: "Restore Student" })).toBeVisible();
      await expect(page.getByRole("link", { name: "Add Application" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Delete" })).toHaveCount(0);

      // The archived student's application is a historical join that survives:
      // the cycle-aware fellowship label still links from the detail surface.
      await expect(
        page.getByRole("link", { name: `${name} Fellowship — 2024`, exact: true }).filter({ visible: true }).first(),
      ).toBeVisible();

      // Restore from the detail page re-exposes the active workflow actions
      // (the page renders both the header action and the empty/section
      // affordance, so scope to the first visible occurrence).
      await page.getByRole("button", { name: "Restore Student" }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "Restore Student" }).click();
      await expect(page.getByRole("link", { name: "Add Application" }).first()).toBeVisible();
      await expect(page.getByText(/Archived since/)).toHaveCount(0);
    } finally {
      await deleteApplication(applicationId);
      await deleteFellowship(fellowshipId);
      await deleteStudent(studentId);
    }
  });

  test("the applications table offers no Delete control (historical records)", async ({ page }) => {
    await signInAsActive(page);
    await page.goto("/applications");
    await expect(page.getByRole("heading", { name: "Applications" })).toBeVisible();

    // No destructive control on rows, no Delete dialog anywhere.
    await expect(page.getByTitle("Delete application")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Delete" })).toHaveCount(0);
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    // Editing remains the only mutation path.
    await expect(page.getByTitle("Edit application").first()).toBeVisible();
  });
});