import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // The contract lane runs against an ISOLATED loopback Supabase instance
  // whose runtime values (API_URL/ANON_KEY/SERVICE_ROLE_KEY/DB_URL) are
  // injected by the runner through the child env. The repository's `.env*`
  // files must therefore never be loaded into the test process:
  // `envDir: false` disables Vite/Vitest's env-file loading entirely, so no
  // committed credential can leak into the contract suite. The runner's child
  // env is already `sanitizeEnv(process.env)` + the captured runtime values.
  envDir: false,
  test: {
    environment: "node",
    include: ["tests/contract/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
});