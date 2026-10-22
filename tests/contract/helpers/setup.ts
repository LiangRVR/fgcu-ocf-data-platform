/**
 * tests/contract/helpers/setup.ts
 *
 * Runtime environment access and client factories for the contract-test lane.
 *
 * The contract lane runs ONLY against a fresh, isolated Docker-local Supabase
 * instance orchestrated by `scripts/contract/run.mjs` (which exports the
 * runtime env captured from `supabase status -o env`). These helpers refuse to
 * proceed against anything that is not a loopback (localhost) URL, so tests can
 * never accidentally read or mutate a hosted/shared database.
 *
 * Service role usage is restricted to local fixture creation/cleanup and to
 * constraint isolation (bypassing RLS so CHECK/FK/unique constraints are
 * asserted in isolation). Service-role access is never asserted as a feature.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Pool } from "pg";

export interface ContractEnv {
  apiUrl: string;
  dbUrl: string;
  anonKey: string;
  serviceRoleKey: string;
}

/** API URL must resolve to the local Docker host. */
const LOOPBACK_URL = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/;
/** DB URL must target the local Docker Postgres (userinfo is allowed, e.g. postgres:postgres@). */
const LOOPBACK_DB = /^postgres(?:ql)?:\/\/(?:[^/@:]+(?::[^/@]*)?@)?(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\//;

export function getContractEnv(): ContractEnv {
  const apiUrl = process.env.SUPABASE_URL ?? process.env.SUPABASE_API_URL ?? process.env.SUPABASE_PUBLIC_URL ?? "";
  const dbUrl = process.env.SUPABASE_DB_URL ?? "";
  const anonKey = process.env.SUPABASE_ANON_KEY ?? "";
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

  if (!apiUrl || !dbUrl || !anonKey || !serviceRoleKey) {
    throw new Error(
      "Contract tests require the Docker-local Supabase runtime environment.\n" +
        "Run them via `pnpm run test:contract`, which starts local Supabase (Docker),\n" +
        "captures `supabase status -o env`, resets migrations, and then runs this suite.\n" +
        "The contract lane does not fall back to hosted or shared databases."
    );
  }
  if (!LOOPBACK_URL.test(apiUrl)) {
    throw new Error(`Refusing to run contract tests against a non-local API URL: ${apiUrl}`);
  }
  if (!LOOPBACK_DB.test(dbUrl)) {
    throw new Error("Refusing to run contract tests against a non-local database URL.");
  }
  return { apiUrl, dbUrl, anonKey, serviceRoleKey };
}

/** Service-role client: local fixture creation/cleanup + constraint isolation only. */
export function createServiceRoleClient(env: ContractEnv = getContractEnv()): SupabaseClient {
  return createClient(env.apiUrl, env.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Anon client: used to assert that the anonymous role is denied. */
export function createAnonClient(env: ContractEnv = getContractEnv()): SupabaseClient {
  return createClient(env.apiUrl, env.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Attach a NON-THROWING, diagnostic `error` handler to a node-postgres Pool.
 *
 * node-postgres emits an `error` event on a Pool whenever the server
 * terminates one of the pool's (idle) connections — e.g. SQLSTATE 57P01
 * (admin_shutdown) from `DROP DATABASE ... WITH (FORCE)` reaping a scratch
 * database's lingering connection, or from the runner stopping the isolated
 * Postgres during teardown. With no listener, the unhandled EventEmitter
 * `error` event throws and crashes the whole Vitest process.
 *
 * The handler is deliberately non-throwing and diagnostic only. It does NOT
 * conceal normal test query failures: a rejected query never surfaces through
 * this event (the pool emits `error` only for connection-level / idle-client
 * failures; query errors still reject their own promises, so assertions keep
 * running unchanged).
 */
export function attachPoolErrorHandler(pool: Pool, label: string): Pool {
  pool.on("error", (err) => {
    const code = (err as { code?: string } | undefined)?.code;
    const message = err instanceof Error ? err.message : String(err);
    // Server-side connection termination expected during teardown: the
    // contract lane reaps scratch databases with FORCE and the runner stops
    // the isolated Postgres. Log the diagnostic and move on.
    if (code === "57P01" || code === "57P02" || code === "57P03" || code === "08006" || code === "08003") {
      console.warn(
        `[contract:${label}] pool connection terminated by the server during teardown (SQLSTATE ${code}): ${message}`
      );
      return;
    }
    // Any other idle-client error is unexpected: log it loudly (still without
    // throwing, so the diagnostic can never crash the suite) — and it remains
    // fully visible through the query's own rejected promise when a query was
    // involved.
    console.error(`[contract:${label}] unexpected idle-client pool error (SQLSTATE ${code ?? "n/a"}): ${message}`);
  });
  return pool;
}

/** Direct Postgres pool for inspecting the migrated schema/catalogs. */
export function createDbPool(env: ContractEnv = getContractEnv()): Pool {
  return attachPoolErrorHandler(
    new Pool({
      connectionString: env.dbUrl,
      max: 5,
      connectionTimeoutMillis: 10_000,
    }),
    "main-db"
  );
}