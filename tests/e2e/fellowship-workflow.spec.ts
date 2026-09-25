/**
 * tests/e2e/fellowship-workflow.spec.ts
 *
 * Fellowship catalog workflow against the Docker-local Supabase instance
 * seeded by scripts/e2e/run.mjs (hardening plan Work 6 / R5). UI-first:
 *
 *   1. Create a fellowship through the "Add Fellowship" dialog.
 *   2. Rename it through the row's "Edit fellowship" dialog, proven across a
 *      reload.
 *   3. Open its detail page from the renamed row and assert the program detail
 *      surface renders.
 *
 * All interactions use semantic selectors and auto-waiting assertions (no
 * sleeps). The created fellowship has no applications, so it cannot affect the
 * reports spec's exact student/application/meeting/FT/awarded totals.
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

async function signInAsActive(page: Page): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(ACTIVE_EMAIL);
  await page.locator("#password").fill(ACTIVE_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

test.describe("fellowship workflow", () => {
  test.setTimeout(60_000);

  test("an advisor can create, rename, and open a fellowship through the UI", async ({ page }) => {
    await signInAsActive(page);
    await page.goto("/fellowships");

    // ── Create ─────────────────────────────────────────────────────────────
    const createdName = `E2E UI Fellowship ${Date.now()}`;
    await page.getByRole("button", { name: "Add Fellowship" }).click();
    await page.locator("#new-fellowship-name").fill(createdName);
    await page.getByRole("dialog").getByRole("button", { name: "Add Fellowship" }).click();

    // The dialog closes only AFTER the insert resolves server-side — the
    // completion signal that lets a subsequent reload never race the write.
    await expect(page.getByRole("dialog")).toBeHidden();

    // The catalog table keeps its client-side state across the router.refresh()
    // the button triggers, so a full reload proves the create persisted
    // server-side AND surfaces the new row.
    await page.reload();
    let row = page.locator("table tbody tr", { hasText: createdName });
    await expect(row).toBeVisible();

    // ── Edit (rename) ──────────────────────────────────────────────────────
    const renamed = `${createdName} Renamed`;
    await row.getByTitle("Edit fellowship").click();
    await page.locator("#fellowship-name").fill(renamed);
    await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();

    // Same client-state caveat: reload to prove the rename persisted and to
    // surface the renamed row.
    await page.reload();
    row = page.locator("table tbody tr", { hasText: renamed });
    await expect(row).toBeVisible();

    // ── Detail ─────────────────────────────────────────────────────────────
    await page
      .getByRole("link", { name: renamed, exact: true })
      .filter({ visible: true })
      .first()
      .click();

    await expect(page).toHaveURL(/\/fellowships\/\d+$/);
    await expect(page.getByRole("heading", { name: renamed })).toBeVisible();
    await expect(page.getByText("Program Detail", { exact: true })).toBeVisible();
    // A fresh program has no applications yet.
    await expect(page.getByText("Total Applications", { exact: true })).toBeVisible();
    await expect(page.getByText("No applications yet", { exact: true })).toBeVisible();
  });
});