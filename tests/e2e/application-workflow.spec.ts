/**
 * tests/e2e/application-workflow.spec.ts
 *
 * Student + application flow through the real UI against the Docker-local
 * Supabase instance seeded by scripts/e2e/run.mjs. Exercises the stable dialog
 * selectors (#full_name / #email / #us_citizen / "Create Student") and advances
 * a seeded application through a pipeline stage via the edit dialog's
 * #app-stage select, verifying the advance persists across a reload.
 *
 * Fixture cleanup note: applications are historical records and the UI exposes
 * NO Delete control (the entity-lifecycle-archiving change removed it), so the
 * one test that creates an application cleans it up through the service role —
 * never through a destructive UI path.
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
const FELLOWSHIP_TWO_NAME = requireEnv("E2E_FELLOWSHIP_TWO_NAME");
const CYCLE_YEAR_OLD = requireEnv("E2E_CYCLE_YEAR_OLD");
const CYCLE_YEAR_NEW = requireEnv("E2E_CYCLE_YEAR_NEW");

let counter = 0;

function uniqueName(prefix: string): string {
  counter += 1;
  return `${prefix} ${Date.now()}-${counter}`;
}

/**
 * Service-role client for test-support fixture cleanup only (never the browser
 * under test). Used to remove rows the UI is deliberately forbidden to delete.
 */
function createServiceClient() {
  const apiUrl = requireEnv("SUPABASE_URL");
  const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  return createClient(apiUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function signInAsActive(page: Page): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(ACTIVE_EMAIL);
  await page.locator("#password").fill(ACTIVE_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

/**
 * Open the Add Student dialog, fill the required fields, submit, and assert the
 * new row renders in the students table.
 */
async function createStudent(page: Page): Promise<{ name: string; email: string }> {
  const name = uniqueName("E2E UI Student");
  const email = `e2e-ui-${Date.now()}-${counter}@example.com`;

  await page.goto("/students");
  await page.getByRole("button", { name: "Add Student" }).click();
  await page.locator("#full_name").fill(name);
  await page.locator("#email").fill(email);
  await page.locator("#us_citizen").check();
  await page.getByRole("button", { name: "Create Student" }).click();

  const row = page.locator("table tbody tr", { hasText: name });
  await expect(row).toBeVisible();

  return { name, email };
}

test.describe("application workflow", () => {
  test.setTimeout(60_000);

  test("an advisor can create a student through the dialog", async ({ page }) => {
    await signInAsActive(page);

    const { name } = await createStudent(page);

    // The row is visible (asserted in createStudent); confirm the stable cell.
    await expect(page.locator("table tbody tr", { hasText: name })).toContainText(name);
  });

  test("an advisor can advance a seeded application to Finalist (setting the flags), persist across a reload, and reverse to a non-finalist stage that clears the stale flags", async ({ page }) => {
    await signInAsActive(page);

    // The seed creates one application for the seeded student at "Submitted".
    await page.goto("/applications");
    const row = page.locator("table tbody tr", { hasText: STUDENT_NAME });
    await expect(row).toContainText("Submitted");

    // ── Advance through review into Finalist ────────────────────────────────
    // Finalist is the strongest flag-carrying stage: selecting it via the edit
    // dialog auto-sets BOTH the semi-finalist and finalist flags (the desktop
    // table's "Semi-Fin." / "Finalist" columns render a "Yes" badge each).
    await row.getByTitle("Edit application").click();
    await page.locator("#app-stage").click();
    await page.getByRole("option", { name: "Under Review", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Save Changes" }).click();
    await expect(page.locator("table tbody tr", { hasText: STUDENT_NAME })).toContainText(
      "Under Review",
    );

    // Advance to Finalist → both flags set.
    await page.locator("table tbody tr", { hasText: STUDENT_NAME }).getByTitle("Edit application").click();
    await page.locator("#app-stage").click();
    await page.getByRole("option", { name: "Finalist", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Save Changes" }).click();

    const finalistRow = page.locator("table tbody tr", { hasText: STUDENT_NAME });
    await expect(finalistRow).toContainText("Finalist");
    // Both flag columns ("Semi-Fin." and "Finalist") render "Yes".
    await expect(finalistRow.getByText("Yes", { exact: true })).toHaveCount(2);

    // Reload → the Finalist stage AND both flags persist server-side.
    await page.reload();
    const finalistRowAfterReload = page.locator("table tbody tr", { hasText: STUDENT_NAME });
    await expect(finalistRowAfterReload).toContainText("Finalist");
    await expect(finalistRowAfterReload.getByText("Yes", { exact: true })).toHaveCount(2);

    // ── Reverse to a non-finalist stage → stale flags must clear ────────────
    // Selecting "Submitted" auto-derives both flags to false in the form, and
    // the saved row must no longer render any "Yes" flag badge.
    await finalistRowAfterReload.getByTitle("Edit application").click();
    await page.locator("#app-stage").click();
    await page.getByRole("option", { name: "Submitted", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Save Changes" }).click();

    const revertedRow = page.locator("table tbody tr", { hasText: STUDENT_NAME });
    await expect(revertedRow).toContainText("Submitted");
    await expect(revertedRow.getByText("Yes", { exact: true })).toHaveCount(0);

    // Reload → the reverse transition and cleared flags persist server-side.
    await page.reload();
    const revertedRowAfterReload = page.locator("table tbody tr", { hasText: STUDENT_NAME });
    await expect(revertedRowAfterReload).toContainText("Submitted");
    await expect(revertedRowAfterReload.getByText("Yes", { exact: true })).toHaveCount(0);
  });

  test("the stage selector offers Did Not Submit and Withdrawn and each terminal stage persists with cleared flags", async ({ page }) => {
    await signInAsActive(page);

    await page.goto("/applications");
    const seededRow = page.locator("table tbody tr", { hasText: STUDENT_NAME });
    await expect(seededRow).toContainText("Submitted");

    // Both non-finalist terminal stages are offered by the stage select, and
    // each persists server-side with neither boolean flag set.
    const setStage = async (stage: string): Promise<void> => {
      await page
        .locator("table tbody tr", { hasText: STUDENT_NAME })
        .getByTitle("Edit application")
        .click();
      await page.locator("#app-stage").click();
      await expect(page.getByRole("option", { name: "Did Not Submit", exact: true })).toBeVisible();
      await expect(page.getByRole("option", { name: "Withdrawn", exact: true })).toBeVisible();
      await page.getByRole("option", { name: stage, exact: true }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Save Changes" }).click();
      await expect(page.locator("table tbody tr", { hasText: STUDENT_NAME })).toContainText(stage);
    };

    await setStage("Did Not Submit");
    await expect(
      page
        .locator("table tbody tr", { hasText: STUDENT_NAME })
        .getByText("Yes", { exact: true }),
    ).toHaveCount(0);
    await page.reload();
    await expect(page.locator("table tbody tr", { hasText: STUDENT_NAME })).toContainText(
      "Did Not Submit",
    );

    await setStage("Withdrawn");
    await expect(
      page
        .locator("table tbody tr", { hasText: STUDENT_NAME })
        .getByText("Yes", { exact: true }),
    ).toHaveCount(0);
    await page.reload();
    await expect(page.locator("table tbody tr", { hasText: STUDENT_NAME })).toContainText(
      "Withdrawn",
    );

    // Restore the seed stage so the reports spec's exact stage counts stay
    // deterministic in either lane order.
    await setStage("Submitted");
  });

  test("the seeded same-fellowship pair renders distinct cycle labels across different years", async ({ page }) => {
    await signInAsActive(page);

    // The seed creates TWO applications for the second student on the SAME
    // fellowship (E2E_FELLOWSHIP_TWO_NAME) with EXPLICIT different cycles
    // (CYCLE_YEAR_OLD / CYCLE_YEAR_NEW). They must render as two distinct
    // "{fellowship} — {year}" labels — never collapse into one bare name.
    const oldLabel = `${FELLOWSHIP_TWO_NAME} — ${CYCLE_YEAR_OLD}`;
    const newLabel = `${FELLOWSHIP_TWO_NAME} — ${CYCLE_YEAR_NEW}`;
    expect(oldLabel).not.toBe(newLabel);

    await page.goto("/applications");

    const oldRow = page.locator("table tbody tr", { hasText: oldLabel });
    const newRow = page.locator("table tbody tr", { hasText: newLabel });
    await expect(oldRow).toBeVisible();
    await expect(newRow).toBeVisible();

    // Exactly one row per cycle label, and both belong to the second student.
    await expect(page.locator("table tbody tr", { hasText: FELLOWSHIP_TWO_NAME })).toHaveCount(2);
    await expect(oldRow).toContainText(STUDENT_TWO_NAME);
    await expect(newRow).toContainText(STUDENT_TWO_NAME);
  });

  test("an advisor can create an application with an explicit application year and the cycle label persists across a reload", async ({ page }) => {
    await signInAsActive(page);

    const createdYear = "2024";
    const createdLabel = `${FELLOWSHIP_TWO_NAME} — ${createdYear}`;
    // A unique destination marker lets the service role find exactly the row
    // this test created (the seed never uses it) for safe fixture cleanup.
    const destinationCountry = `E2E cycle ${Date.now()}`;

    await page.goto("/applications");
    await page.getByRole("button", { name: "New Application" }).click();

    await page.locator("#app-student").click();
    await page.getByRole("option", { name: STUDENT_TWO_NAME, exact: true }).click();
    await page.locator("#app-fellowship").click();
    await page.getByRole("option", { name: FELLOWSHIP_TWO_NAME, exact: true }).click();
    await page.locator("#app-year").fill(createdYear);
    await page.locator("#app-country").fill(destinationCountry);

    await page.getByRole("dialog").getByRole("button", { name: "Create Application" }).click();

    // The new row renders the cycle-aware label (fellowship + year).
    const row = page.locator("table tbody tr", { hasText: createdLabel });
    await expect(row).toBeVisible();
    await expect(row).toContainText(STUDENT_TWO_NAME);

    // Reload → the explicit application year persists server-side.
    await page.reload();
    const rowAfterReload = page.locator("table tbody tr", { hasText: createdLabel });
    await expect(rowAfterReload).toBeVisible();

    // Clean up the created application so the reports spec's exact totals keep
    // deriving from the seed export alone. Applications are historical records:
    // the UI deliberately exposes NO Delete control (entity-lifecycle-archiving
    // removes it), so cleanup goes through the service role — the same
    // test-support path the operations spec uses.
    const service = createServiceClient();
    const { data: createdApp, error: findError } = await service
      .from("application")
      .select("application_id")
      .eq("destination_country", destinationCountry)
      .maybeSingle();
    if (findError) throw new Error(`find created application for cleanup: ${findError.message}`);
    expect(createdApp, "the created application must exist for cleanup").not.toBeNull();

    const { error: deleteError } = await service
      .from("application")
      .delete()
      .eq("application_id", createdApp!.application_id);
    if (deleteError) throw new Error(`cleanup created application: ${deleteError.message}`);

    // The UI row is gone after a reload (server loader no longer returns it).
    await page.reload();
    await expect(page.locator("table tbody tr", { hasText: createdLabel })).toHaveCount(0);
  });
});