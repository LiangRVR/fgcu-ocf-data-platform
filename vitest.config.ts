import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
    coverage: {
      // V8 provider, version-matched to vitest (@vitest/coverage-v8 5.x).
      provider: "v8",
      // Coverage is scoped to production logic (R6): the app's library code
      // (`lib/**`) and API routes (`app/api/**`). Everything outside that
      // scope — generated types, UI components/pages, scripts, and test
      // infrastructure — is intentionally not measured. UI behavior is the
      // Playwright E2E lane's job, not unit coverage.
      include: ["lib/**", "app/api/**"],
      exclude: [
        "**/node_modules/**",
        "**/coverage/**",
        "**/*.d.ts",
        "**/*.d.cts",
        "**/*.d.mts",
        "**/*.test.ts",
        "**/*.spec.ts",
        "tests/**",
        // Framework glue: Supabase SSR/browser client factories need the
        // Next.js runtime; they are exercised by the app + E2E lane.
        "lib/supabase/**",
        // Configuration: static navigation data and server origin config.
        "lib/config/**",
      ],
      // `text` prints the summary to terminal/CI logs; `json-summary` writes
      // coverage/coverage-summary.json for artifact upload and machine reads.
      reporter: ["text", "json-summary"],
      // Keep the report available even when thresholds fail, so a CI failure
      // shows exactly what dropped below the baseline.
      reportOnFailure: true,
      // Baseline-driven thresholds, measured 2026-09-25 on the initial scoped
      // run (lines 98.72, statements 98.40, functions 95.74, branches 96.66).
      // Rounded down ~3-6 points to absorb minor refactors while still
      // protecting meaningful logic from silent regression.
      thresholds: {
        statements: 95,
        branches: 90,
        functions: 92,
        lines: 95,
      },
    },
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
});