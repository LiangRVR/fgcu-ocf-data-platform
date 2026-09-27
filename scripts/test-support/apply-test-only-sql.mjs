#!/usr/bin/env node
/**
 * scripts/test-support/apply-test-only-sql.mjs
 *
 * Applies ONE test-only SQL file to the isolated Docker-local lane database
 * AFTER the normal production-equivalent migration chain has been applied by
 * `supabase db reset`. Used by the contract (`scripts/contract/run.mjs`) and
 * E2E (`scripts/e2e/run.mjs`) runners for the pipeline stage/flag invariant
 * (see `invariant-application-stage-flag.sql`). The SQL file deliberately
 * lives OUTSIDE `supabase/migrations/`: it is a test-lane schema extension,
 * never part of a deployable migration chain.
 *
 * Usage: node apply-test-only-sql.mjs <sql-file>
 * Env:   DB_URL — the loopback Postgres URL captured by the lane runner
 *        (never read from any `.env` file).
 *
 * Safety (loopback-only, disposable, no `.env`):
 *  - DB_URL must resolve to a loopback host (`isLoopbackDbUrl`); any other
 *    target is a hard failure — hosted/shared databases are impossible.
 *  - Credentials travel only inside the child env provided by the runner
 *    (sanitized + runtime env); nothing sensitive is logged or written to disk.
 *  - The SQL is executed in a single session; a failure exits non-zero.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { isLoopbackDbUrl } from "./supabase-isolation.mjs";

const DB_URL = process.env.DB_URL;
if (!DB_URL || !isLoopbackDbUrl(DB_URL)) {
  console.error(
    "[apply-test-only-sql] Refusing to apply test-only SQL: DB_URL is missing or is not a loopback URL."
  );
  process.exit(2);
}

const sqlFile = process.argv[2];
if (!sqlFile) {
  console.error("[apply-test-only-sql] Usage: apply-test-only-sql.mjs <sql-file>");
  process.exit(2);
}

let sql;
try {
  sql = readFileSync(sqlFile, "utf8");
} catch (caught) {
  console.error(`[apply-test-only-sql] Could not read ${sqlFile}: ${caught.message}`);
  process.exit(2);
}

const client = new pg.Client({ connectionString: DB_URL, ssl: false });
try {
  await client.connect();
  await client.query(sql);
  console.error(`[apply-test-only-sql] Applied ${path.basename(sqlFile)} to the isolated lane database.`);
} catch (caught) {
  console.error(`[apply-test-only-sql] Failed to apply ${path.basename(sqlFile)}: ${caught.message}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}