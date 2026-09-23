import { defineConfig, devices } from "@playwright/test";

// E2E orchestration (env control, server startup, Supabase lifecycle) lives in
// scripts/e2e/run.mjs, not here.
export default defineConfig({
  testDir: "tests/e2e",
  retries: 0,
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: process.env.APP_URL ?? "http://127.0.0.1:3000",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});