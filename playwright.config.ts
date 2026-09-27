import { defineConfig, devices } from "@playwright/test";

// E2E orchestration (env control, server startup, Supabase lifecycle) lives in
// scripts/e2e/run.mjs, not here.
//
// Browser decision (hardening plan Work 8 / R8):
//   - "chromium" (Desktop Chrome) is the FULL E2E lane — every spec runs here.
//   - "mobile-chromium" (Pixel 7) is a meaningful responsive smoke lane: it
//     reuses the same locally provisioned Chromium executable (no extra browser
//     install) and runs only tests/e2e/mobile.spec.ts at a mobile viewport to
//     prove the roster/catalog/detail surfaces render as card lists.
//   - WebKit/Safari is DEFERRED: there is no evidence of OCF usage on Safari
//     that would justify its CI cost, and the mobile Chromium profile already
//     covers the responsive gap. If OCF usage data later shows meaningful
//     Safari traffic, add WebKit as a targeted smoke project (testMatch a
//     dedicated spec), never as an indiscriminate full-matrix lane.
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
    {
      name: "mobile-chromium",
      use: { ...devices["Pixel 7"] },
      testMatch: /mobile\.spec\.ts/,
    },
  ],
});