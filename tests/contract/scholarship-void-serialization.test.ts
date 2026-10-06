/**
 * tests/contract/scholarship-void-serialization.test.ts
 *
 * Contract coverage for the terminal-Void concurrency remediation (migration
 * 20261009000001, review finding 3 of 2026-10-06-historical-integrity-
 * remediation).
 *
 * Migration 20261008000001 enforced "a Void is terminal" with a bare EXISTS
 * check in the BEFORE INSERT trigger, which is not serializable under READ
 * COMMITTED: two concurrent amendment INSERTs for the same award can each
 * observe "no Void yet" and both commit. This suite proves the database
 * boundary now serializes those writers on the parent `scholarship_history`
 * row, and that the declarative single-Void backstop index is present.
 *
 * The race is driven over the raw Postgres pool with explicit transactions: a
 * winner holds an uncommitted Void (thereby holding the parent-row lock), the
 * loser's INSERT is issued concurrently, the test waits until the loser is
 * genuinely parked on a lock, then the winner commits. The loser must then be
 * rejected rather than committing a second Void / a post-Void amendment.
 *
 * The local JWT subject is simulated with a transaction-local
 * `request.jwt.claim.sub` (the same technique as upgrade-path.test.ts) so the
 * SECURITY DEFINER trigger resolves the pre-bound active advisor from auth.uid().
 *
 * Run inside the isolated Docker-local contract lane (`scripts/contract/run.mjs`).
 * Service role is used strictly for fixture seeding and the pre-bind.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { createDbPool, createServiceRoleClient, getContractEnv } from "./helpers/setup";
import { seedCoreFixtures, syntheticName, type SeededCore } from "./helpers/fixtures";

const env = getContractEnv();
const service = createServiceRoleClient(env);
let pool: Pool;
let fixtures: SeededCore;

/** Synthetic auth subject bound to the seeded active advisor for this file. */
const BOUND_AUTH_UUID = "00000000-0000-4000-8000-00000000a0d1";

type AmendmentType = "Void" | "Correction";

interface AmendmentSpec {
  type: AmendmentType;
  reason: string;
  correctedFellowshipId?: number;
}

/** Fresh award so each race is isolated from every other assertion. */
async function freshHistory(): Promise<number> {
  const { data, error } = await service
    .from("scholarship_history")
    .insert({ student_id: fixtures.studentId, fellowship_id: fixtures.fellowshipId })
    .select("history_id")
    .single();
  if (error) throw new Error(`seed serialization award: ${error.message}`);
  return data!.history_id as number;
}

async function countVoids(historyId: number): Promise<number> {
  const { count, error } = await service
    .from("scholarship_history_amendment")
    .select("amendment_id", { count: "exact", head: true })
    .eq("history_id", historyId)
    .eq("amendment_type", "Void");
  if (error) throw new Error(`count void amendments: ${error.message}`);
  return count ?? 0;
}

/**
 * Bounded poll until `pid` is observably waiting on a lock. `observer` is the
 * winner's connection, which already holds the parent-row lock but can still
 * read catalogs from inside its open transaction.
 */
async function waitForBlocked(observer: PoolClient, pid: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const { rows } = await observer.query(
      `SELECT wait_event_type
         FROM pg_stat_activity
        WHERE pid = $1`,
      [pid]
    );
    if (rows[0]?.wait_event_type === "Lock") return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`concurrent writer ${pid} never blocked on the parent-row lock`);
}

/**
 * Run one serialized race: `winner` inserts (uncommitted) on behalf of the
 * bound advisor, `loser` inserts concurrently. Returns the loser's error, or
 * null if it unexpectedly committed.
 */
async function raceAmendment(
  historyId: number,
  winner: AmendmentSpec,
  loser: AmendmentSpec
): Promise<{ code?: string } | null> {
  const winnerClient = await pool.connect();
  const loserClient = await pool.connect();
  try {
    await winnerClient.query("BEGIN");
    await winnerClient.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [BOUND_AUTH_UUID]);
    const inserted = await winnerClient.query(
      `INSERT INTO public.scholarship_history_amendment
           (history_id, amendment_type, reason, corrected_fellowship_id)
       VALUES ($1, $2, $3, $4)
       RETURNING amendment_id`,
      [historyId, winner.type, winner.reason, winner.correctedFellowshipId ?? null]
    );
    expect(inserted.rows, "winner amendment must insert").toHaveLength(1);

    await loserClient.query("BEGIN");
    await loserClient.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [BOUND_AUTH_UUID]);
    const pidRow = await loserClient.query("SELECT pg_backend_pid() AS pid");
    const loserPid = pidRow.rows[0].pid as number;

    const loserPromise = loserClient.query(
      `INSERT INTO public.scholarship_history_amendment
           (history_id, amendment_type, reason, corrected_fellowship_id)
       VALUES ($1, $2, $3, $4)`,
      [historyId, loser.type, loser.reason, loser.correctedFellowshipId ?? null]
    );
    // Attach a handler immediately so a rejection that lands between COMMIT and
    // the assertion below is never reported as an unhandled rejection.
    loserPromise.catch(() => undefined);

    // Only release the winner once the loser is provably blocked, so the test
    // exercises serialization rather than a timing coincidence.
    await waitForBlocked(winnerClient, loserPid);
    await winnerClient.query("COMMIT");

    const outcome = await loserPromise.then(
      () => null,
      (error: { code?: string }) => error
    );
    return outcome;
  } finally {
    // Release any still-open transaction/parent lock before returning the
    // connections to the pool (a no-op after a clean COMMIT/ROLLBACK).
    await winnerClient.query("ROLLBACK").catch(() => undefined);
    await loserClient.query("ROLLBACK").catch(() => undefined);
    winnerClient.release();
    loserClient.release();
  }
}

beforeAll(async () => {
  fixtures = await seedCoreFixtures(service);
  // Pre-bind the seeded active advisor to a synthetic auth subject so the
  // trigger resolves an active creator from the simulated JWT.
  const { error } = await service
    .from("advisor")
    .update({ auth_user_id: BOUND_AUTH_UUID })
    .eq("advisor_id", fixtures.advisorSelfId)
    .select("advisor_id");
  if (error) throw new Error(`bind serialization advisor: ${error.message}`);
  pool = createDbPool(env);
}, 60_000);

afterAll(async () => {
  await pool.end();
});

describe("scholarship terminal-Void serialization (migration 20261009000001)", () => {
  it("serializes the trigger on the parent award row and declares the single-Void backstop index", async () => {
    const fn = await pool.query(
      `SELECT pg_get_functiondef(p.oid) AS definition
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = 'set_scholarship_history_amendment_metadata'`
    );
    expect(fn.rows, "amendment metadata function exists").toHaveLength(1);
    const definition = String(fn.rows[0].definition);
    expect(definition, "parent-row lock present").toMatch(/FOR UPDATE/i);
    expect(definition, "lock targets the parent award table").toContain("scholarship_history");
    expect(definition, "terminal Void guard present").toMatch(/already voided/);

    const index = await pool.query(
      `SELECT indexdef
         FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = 'uidx_scholarship_history_amendment_single_void'`
    );
    expect(index.rows, "single-Void backstop index exists").toHaveLength(1);
    const indexdef = String(index.rows[0].indexdef);
    expect(indexdef, "backstop is UNIQUE").toMatch(/UNIQUE/i);
    expect(indexdef, "backstop is partial (has a WHERE predicate)").toMatch(/\bWHERE\b/i);

    // `pg_get_indexdef` renders the predicate with PostgreSQL type-cast noise
    // (e.g. `WHERE ((amendment_type)::text = 'Void'::text)` for this
    // `character varying` column), so a raw `amendment_type[^)]*Void` regex is
    // brittle. Strip casts/grouping/quotes, then assert the predicate scopes
    // the unique index to exactly `amendment_type = 'Void'` — and nothing else.
    const predicate = indexdef.slice(indexdef.search(/\bWHERE\b/i) + "WHERE".length);
    const normalizedPredicate = predicate
      .replace(/::\s*[a-z_][a-z0-9_.]*(?:\s+[a-z_][a-z0-9_.]*)*/gi, " ") // strip type casts
      .replace(/[()'"]/g, " ") // drop grouping, quotes
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    expect(normalizedPredicate, "backstop predicate applies only to Void amendments").toBe(
      "amendment_type = void"
    );
  });

  it("commits exactly one of two concurrent Voids for the same award (the loser is rejected)", async () => {
    const historyId = await freshHistory();

    const loserError = await raceAmendment(
      historyId,
      { type: "Void", reason: syntheticName("first-void") },
      { type: "Void", reason: syntheticName("second-void") }
    );

    expect(loserError, "the second concurrent Void must be rejected").not.toBeNull();
    // The trigger guard (42501) is the documented path; the partial unique
    // index (23505) is an equivalent declarative backstop.
    expect(["42501", "23505"]).toContain(loserError!.code);
    expect(await countVoids(historyId), "exactly one Void may commit").toBe(1);
  });

  it("rejects a concurrent Correction racing a Void for the same award (Void stays terminal)", async () => {
    const historyId = await freshHistory();

    const loserError = await raceAmendment(
      historyId,
      { type: "Void", reason: syntheticName("terminal-void") },
      { type: "Correction", reason: syntheticName("post-void-correction"), correctedFellowshipId: fixtures.fellowshipId }
    );

    expect(loserError, "a Correction racing a Void must be rejected").not.toBeNull();
    // A non-Void amendment is only blocked by the trigger's terminal check.
    expect(loserError!.code).toBe("42501");

    const { count } = await service
      .from("scholarship_history_amendment")
      .select("amendment_id", { count: "exact", head: true })
      .eq("history_id", historyId);
    expect(count, "only the winner's Void may commit").toBe(1);
  });

  it("still allows the legitimate sequential append flow (Correction then Void)", async () => {
    const historyId = await freshHistory();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [BOUND_AUTH_UUID]);
      await client.query(
        `INSERT INTO public.scholarship_history_amendment
             (history_id, amendment_type, reason, corrected_fellowship_id)
         VALUES ($1, 'Correction', $2, $3)`,
        [historyId, syntheticName("sequential-correction"), fixtures.fellowshipId]
      );
      await client.query(
        `INSERT INTO public.scholarship_history_amendment
             (history_id, amendment_type, reason)
         VALUES ($1, 'Void', $2)`,
        [historyId, syntheticName("sequential-void")]
      );
      await client.query("COMMIT");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }

    const { count, error } = await service
      .from("scholarship_history_amendment")
      .select("amendment_id", { count: "exact", head: true })
      .eq("history_id", historyId);
    if (error) throw new Error(`count sequential amendments: ${error.message}`);
    expect(count, "Correction then Void remain appendable").toBe(2);
    expect(await countVoids(historyId)).toBe(1);
  });
});
