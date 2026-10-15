/**
 * tests/contract/generated-types.test.ts
 *
 * Generated-type drift contract.
 *
 * `types/database.ts` is GENERATED OUTPUT: it must be produced only by the
 * documented Supabase CLI generator from the final local schema, never hand
 * edited. This test runs inside the existing isolated Docker-local contract lane
 * (`scripts/contract/run.mjs`), which applies the exact Git migration chain to a
 * fresh disposable database and injects the loopback runtime env
 * (API_URL/DB_URL/keys). It re-runs the generator against THAT isolated database
 * and asserts the result is byte-for-byte identical to the committed
 * `types/database.ts`, so a later migration cannot silently omit a table, view,
 * function, column, or argument and still pass the release gate.
 *
 * Isolation / safety:
 *   - the DB URL comes from `getContractEnv()`, which refuses anything that is
 *     not a loopback (localhost/127.0.0.1/[::1]) target, so the generator can
 *     never talk to a hosted/shared database;
 *   - the generator is the repository-local `supabase` CLI (the same binary the
 *     contract lane already uses to start/reset the isolated stack);
 *   - the schema set (`public`, `graphql_public`) matches the isolated
 *     `config.toml` `[api].schemas`, so the output is identical to
 *     `supabase gen types --local` inside that project (`pnpm run db:types`);
 *   - the test writes no files and reads no row data — it only generates the
 *     TypeScript schema definition and compares it to the committed file.
 *
 * Coverage surface: the generated definition exposes exactly the public schema
 * objects the CLI emits, including `audit_event`, `audit_event_subject`, the
 * `audit_activity` view, `begin_legacy_baseline_import`, and every
 * versioned/lifecycle writer (`update_student_profile`, `update_fellowship`,
 * `update_application`, `update_my_advisor_profile`,
 * `update_advisor_profile_name`, `set_advisor_role`, `provision_advisor`,
 * `lifecycle_transition`). Any drift fails the equality assertion above.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getContractEnv } from "./helpers/setup";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TYPES_PATH = path.join(ROOT, "types", "database.ts");
const SUPABASE_BIN = path.join(ROOT, "node_modules", ".bin", "supabase");

/** The isolated config's `[api].schemas`, matching `supabase gen types --local`. */
const SCHEMAS = ["public", "graphql_public"];

const env = getContractEnv();

/**
 * Run the documented generator against the isolated lane database. Uses
 * `--db-url` (loopback-only, guarded by `getContractEnv`) because the test
 * process has no `--workdir`; the result is byte-identical to the
 * `supabase gen types --local` output for the same schema set.
 */
function generateTypes(dbUrl: string): string {
  if (!existsSync(SUPABASE_BIN)) {
    throw new Error(
      `Environment blocker: the supabase CLI is not available at ${SUPABASE_BIN}. ` +
        "The contract lane requires it (`pnpm install`)."
    );
  }
  return execFileSync(
    SUPABASE_BIN,
    [
      "gen",
      "types",
      "--db-url",
      dbUrl,
      ...SCHEMAS.flatMap((schema) => ["--schema", schema]),
    ],
    {
      encoding: "utf8",
      cwd: ROOT,
      env: process.env,
      timeout: 120_000,
      maxBuffer: 32 * 1024 * 1024,
    }
  );
}

describe("generated database types match the final local schema (drift check)", () => {
  it("reproduces the committed types/database.ts byte-for-byte from the isolated schema", () => {
    const committed = readFileSync(TYPES_PATH, "utf8");
    const generated = generateTypes(env.dbUrl);

    // Locate the first divergence for a readable failure (the whole generated
    // file is a schema definition — no row data or credentials).
    if (generated !== committed) {
      const max = Math.max(generated.length, committed.length);
      let at = 0;
      while (at < max && generated[at] === committed[at]) at += 1;
      const context = (text: string) => JSON.stringify(text.slice(at, at + 160));
      throw new Error(
        `Generated types drift from types/database.ts at offset ${at}.\n` +
          `  committed: ${context(committed)}\n` +
          `  generated: ${context(generated)}\n` +
          "Regenerate with `pnpm run db:types` against a clean local schema; never hand-edit types/database.ts."
      );
    }

    expect(generated).toBe(committed);
  });

  it("exposes the required public objects and versioned writers in the committed types", () => {
    const committed = readFileSync(TYPES_PATH, "utf8");
    for (const required of [
      "audit_event:",
      "audit_event_subject:",
      "audit_activity:",
      "begin_legacy_baseline_import:",
      "update_student_profile:",
      "update_fellowship:",
      "update_application:",
      "update_my_advisor_profile:",
      "update_advisor_profile_name:",
      "set_advisor_role:",
      "provision_advisor:",
      "lifecycle_transition:",
    ]) {
      expect(committed, `types/database.ts must expose ${required}`).toContain(required);
    }
  });
});
