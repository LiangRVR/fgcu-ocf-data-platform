/**
 * tests/e2e/application-workflow.spec.ts
 *
 * Student + application flow through the real UI against the Docker-local
 * Supabase instance seeded by scripts/e2e/run.mjs. Exercises the stable dialog
 * selectors (#full_name / #email / #us_citizen / "Create Student") and advances
 * a seeded application through a pipeline stage via the edit dialog's
 * #app-stage select, verifying the advance persists across a reload.
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

let counter = 0;

function uniqueName(prefix: string): string {
  counter += 1;
  return `${prefix} ${Date.now()}-${counter}`;
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

  test("an advisor can advance a seeded application through a stage that persists across a reload", async ({ page }) => {
    await signInAsActive(page);

    // The seed creates one application for the seeded student at "Submitted".
    await page.goto("/applications");
    const row = page.locator("table tbody tr", { hasText: STUDENT_NAME });
    await expect(row).toContainText("Submitted");

    // Open the edit dialog for that application and advance it one stage.
    await row.getByTitle("Edit application").click();
    await page.locator("#app-stage").click();
    await page.getByRole("option", { name: "Under Review", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Save Changes" }).click();

    // Row renders with the advanced stage.
    await expect(page.locator("table tbody tr", { hasText: STUDENT_NAME })).toContainText(
      "Under Review",
    );

    // Reload → the stage change is persisted server-side.
    await page.reload();
    await expect(page.locator("table tbody tr", { hasText: STUDENT_NAME })).toContainText(
      "Under Review",
    );
  });
});