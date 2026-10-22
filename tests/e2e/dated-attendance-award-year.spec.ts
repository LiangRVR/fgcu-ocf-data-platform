import { test, expect, type Page } from "@playwright/test";

const email = process.env.E2E_ACTIVE_EMAIL!;
const password = process.env.E2E_ACTIVE_PASSWORD!;

async function signIn(page: Page) {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

test.describe("dated attendance and scholarship year", () => {
  test("Fellowship Thursday creation requires a calendar date", async ({ page }) => {
    await signIn(page);
    await page.goto("/fellowship-thursday");
    await page.getByRole("button", { name: "Add Record" }).first().click();
    const date = page.locator("#ft_event_date");
    await expect(date).toHaveAttribute("type", "date");
    await expect(date).toHaveAttribute("required", "");
  });

  test("Scholarship History creation constrains the award year", async ({ page }) => {
    await signIn(page);
    await page.goto("/scholarship-history");
    await page.getByRole("button", { name: "Add Record" }).first().click();
    const year = page.locator("#sh_award_year");
    await expect(year).toHaveAttribute("type", "number");
    await expect(year).toHaveAttribute("min", "1000");
    await expect(year).toHaveAttribute("max", "9999");
    await expect(year).toHaveAttribute("required", "");
  });
});
