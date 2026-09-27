/**
 * tests/unit/scripts/test-support/contract-env-guard.test.ts
 *
 * Amendment A3 — the contract lane's Vitest run must NEVER load any
 * repository `.env*` file:
 *
 *   - `vitest.contract.config.ts` sets `envDir: false`, which disables
 *     Vite/Vitest's env-file loading entirely, so no committed credential can
 *     be pulled from the repository into the contract test process;
 *   - the lane's child env for the Vitest run is built by
 *     `runtimeEnv(sanitizeEnv(base), runtime)`, and `sanitizeEnv` strips every
 *     credential-shaped variable, so even a hostile parent env cannot forward
 *     a credential to the contract suite.
 *
 * This file asserts both halves of the guard using ONLY synthetic hostile
 * environment fixtures and safe literal key names. It never opens, parses,
 * compares against, or references the repository's `.env`/`.env.example`
 * files, and it never touches `process.env`, so a failing assertion cannot
 * interpolate real process environment values into its output.
 */
import { describe, expect, it } from "vitest";
import contractConfig from "../../../../vitest.contract.config";
import { runtimeEnv, sanitizeEnv } from "../../../../scripts/test-support/supabase-isolation.mjs";

/**
 * Synthetic credential-shaped variables that a hostile parent env might carry.
 * All values are fabricated fixtures — they are NOT repository `.env` values
 * and must never leak through `sanitizeEnv`/`runtimeEnv`. Key names are safe
 * literals covering every stripping rule: the bare credential key set, the
 * `SUPABASE_*`/`NEXT_PUBLIC_*`/`POSTGRES_*`/`VITE_*`/`REACT_APP_*` prefix
 * families, and the `*_TOKEN`/`*_SECRET`/`*_KEY`/`*_PASSWORD`/`*_CREDENTIAL`
 * suffix families.
 */
const HOSTILE_CREDENTIALS: Record<string, string> = {
  // Bare canonical/credential keys.
  API_URL: "https://hostile-project.supabase.co",
  ANON_KEY: "hostile-anon-key",
  SERVICE_ROLE_KEY: "hostile-service-role-key",
  SERVICE_KEY: "hostile-service-key",
  DB_URL: "postgresql://hosted:secret@db.internal.example:5432/prod",
  JWT_SECRET: "hostile-jwt-secret",
  POSTGRES_URL: "postgresql://hosted:secret@db.internal.example:5432/prod",
  DATABASE_URL: "postgresql://hosted:secret@db.internal.example:5432/prod",
  PGHOST: "db.internal.example",
  PGPORT: "5432",
  PGUSER: "hosted",
  PGPASSWORD: "hostile-pg-password",
  SUPABASE_ACCESS_TOKEN: "sbp_hostile_token",
  // SUPABASE_* prefix family.
  SUPABASE_URL: "https://hostile-project.supabase.co",
  SUPABASE_ANON_KEY: "hostile-anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "hostile-service-role-key",
  SUPABASE_DB_URL: "postgresql://hosted:secret@db.internal.example:5432/prod",
  SUPABASE_JWT_SECRET: "hostile-jwt-secret",
  // NEXT_PUBLIC_* / VITE_* / REACT_APP_* prefix families.
  NEXT_PUBLIC_SUPABASE_URL: "https://hostile-project.supabase.co",
  NEXT_PUBLIC_ANON_KEY: "hostile-anon-key",
  VITE_SUPABASE_URL: "https://hostile-project.supabase.co",
  REACT_APP_API_KEY: "hostile-react-key",
  // *_KEY / *_TOKEN / *_SECRET / *_PASSWORD / *_CREDENTIAL suffix families.
  STRIPE_SECRET_KEY: "sk_live_hostile_stripe",
  GITHUB_TOKEN: "ghp_hostile_token",
  AWS_SECRET_ACCESS_KEY: "hostile-aws-secret",
  MY_APP_API_TOKEN: "hostile-api-token",
  DATABASE_PASSWORD: "hostile-db-password",
  OAUTH_CLIENT_SECRET: "hostile-oauth-secret",
  GCP_SA_CREDENTIAL: "hostile-gcp-credential",
};

/** Synthetic benign (non-credential) variables that must survive sanitization. */
const BENIGN_VARS: Record<string, string> = {
  HOME: "/home/dev",
  LANG: "en_US.UTF-8",
  USER: "dev",
  SHELL: "/bin/zsh",
  CI: "true",
  NODE_ENV: "test",
  TMPDIR: "/tmp",
  CONTRACT_LABEL: "contract",
};

describe("contract Vitest cannot load repository env files (amendment A3)", () => {
  it("disables Vite/Vitest env-file loading in the contract config (envDir: false)", () => {
    expect(contractConfig.envDir).toBe(false);
    // The runtime values the suite needs are injected by the runner through
    // the child env (sanitized base + captured loopback values), never through
    // a repository `.env` file.
    expect(contractConfig.test?.environment).toBe("node");
  });

  it("strips every credential-shaped variable from a hostile inherited parent env", () => {
    const hostile = { ...BENIGN_VARS, ...HOSTILE_CREDENTIALS };
    const clean = sanitizeEnv(hostile);
    for (const key of Object.keys(HOSTILE_CREDENTIALS)) {
      expect(clean[key], `${key} must be stripped by sanitizeEnv`).toBeUndefined();
    }
  });

  it("preserves non-credential inherited variables through sanitizeEnv", () => {
    const hostile = { ...BENIGN_VARS, ...HOSTILE_CREDENTIALS };
    const clean = sanitizeEnv(hostile);
    for (const [key, value] of Object.entries(BENIGN_VARS)) {
      expect(clean[key], `${key} must survive sanitizeEnv`).toBe(value);
    }
  });

  it("builds the contract test env from sanitized base + injected runtime values only", () => {
    const runtime = {
      apiUrl: "http://127.0.0.1:54321",
      dbUrl: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
      anonKey: "eyJhbGciOiJIUzI1NiJ9.hostile-anon",
      serviceRoleKey: "eyJhbGciOiJIUzI1NiJ9.hostile-service",
      jwtSecret: "s3cret",
    };
    const env = runtimeEnv(sanitizeEnv({ ...BENIGN_VARS, ...HOSTILE_CREDENTIALS }), runtime);
    // Canonical runtime values are present (the lane's loopback instance).
    expect(env.API_URL).toBe(runtime.apiUrl);
    expect(env.ANON_KEY).toBe(runtime.anonKey);
    expect(env.SERVICE_ROLE_KEY).toBe(runtime.serviceRoleKey);
    expect(env.DB_URL).toBe(runtime.dbUrl);
    expect(env.JWT_SECRET).toBe(runtime.jwtSecret);
    expect(env.SUPABASE_URL).toBe(runtime.apiUrl);
    expect(env.SUPABASE_ANON_KEY).toBe(runtime.anonKey);
    expect(env.SUPABASE_SERVICE_ROLE_KEY).toBe(runtime.serviceRoleKey);
    expect(env.SUPABASE_DB_URL).toBe(runtime.dbUrl);
    // Names injected by `runtimeEnv` carry the loopback runtime value — never
    // the hostile inherited value.
    const runtimeInjected = new Set([
      "API_URL",
      "ANON_KEY",
      "SERVICE_ROLE_KEY",
      "DB_URL",
      "JWT_SECRET",
      "SUPABASE_URL",
      "SUPABASE_API_URL",
      "SUPABASE_PUBLIC_URL",
      "SUPABASE_DB_URL",
      "SUPABASE_ANON_KEY",
      "SUPABASE_SERVICE_ROLE_KEY",
      "SUPABASE_JWT_SECRET",
    ]);
    for (const key of Object.keys(HOSTILE_CREDENTIALS)) {
      if (runtimeInjected.has(key)) {
        expect(env[key], `${key} must carry the injected runtime value`).not.toBe(HOSTILE_CREDENTIALS[key]);
      } else {
        expect(env[key], `${key} must not survive into the contract env`).toBeUndefined();
      }
    }
    // Benign inherited variables survive sanitization and injection.
    for (const [key, value] of Object.entries(BENIGN_VARS)) {
      expect(env[key], `${key} must survive into the contract env`).toBe(value);
    }
  });
});