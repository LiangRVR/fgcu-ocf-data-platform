/**
 * tests/contract/signup-rejection.test.ts
 *
 * R11 identity-provisioning contract (regression matrix rows 13–14).
 *
 * With the committed signup-disabled configuration — `[auth] enable_signup =
 * false` while `[auth.email] enable_signup = true` remains so invited users can
 * still sign in/confirm — the PUBLIC auth `signUp` endpoint must reject every
 * self-service signup attempt against the lane instance:
 *
 *   - row 13: a brand-new synthetic email that has never existed here;
 *   - row 14: an email matching an existing `advisor` row (the former
 *     email-only takeover vector, superseded by invite/admin-only provisioning).
 *
 * A rejection is only proven when NO new auth identity exists afterwards. Each
 * assertion therefore: (1) asserts an explicit signup-disabled error from the
 * public endpoint, (2) asserts no user/session is returned, and (3) re-reads
 * `auth.users` through the local database and proves the email is absent — so
 * no real account is ever created. The service role / direct SQL are used
 * strictly for this local fixture + verification re-read (never asserted as a
 * feature), and every value is synthetic. The lane instance is throwaway
 * (`supabase stop --no-backup` + temp workdir), so no cross-run cleanup is
 * required.
 *
 * Green-only (config behavior, R11): this suite pins the fixed
 * signup-disabled configuration and never served as red evidence.
 *
 * Policy: if any assertion fails, this suite fails loudly and the lane still
 * tears down the local instance. No config is pushed and no hosted/deployed
 * environment is touched here.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createAnonClient, createDbPool, createServiceRoleClient, getContractEnv } from "./helpers/setup";
import { CONTRACT_TEST_PASSWORD, syntheticEmail, syntheticName } from "./helpers/fixtures";

const env = getContractEnv();
const service = createServiceRoleClient(env);
const anon = createAnonClient(env);
let pool: Pool;

let advisorEmail: string;
let freshEmail: string;

/**
 * Assert the public `signUp` endpoint rejects `email` and that NO auth identity
 * is created for it. The rejection must come from the signup-disabled guard
 * (message mentions "signup"), not from a password/validation error.
 */
async function expectSignUpRejected(email: string): Promise<void> {
  const { data, error } = await anon.auth.signUp({
    email,
    password: CONTRACT_TEST_PASSWORD,
  });

  expect(error, `public signUp for ${email} must be rejected`).not.toBeNull();
  expect(error!.message.toLowerCase(), "rejection must be the signup-disabled guard").toContain("signup");
  expect(data.user, "a rejected signUp must not return a user").toBeNull();
  expect(data.session, "a rejected signUp must not issue a session").toBeNull();

  // Prove the rejection is real: the email must not exist in auth.users even
  // under the service role / direct DB read (no identity was created).
  const { rows } = await pool.query<{ id: string }>(
    "SELECT id FROM auth.users WHERE lower(email) = lower($1)",
    [email]
  );
  expect(rows, `no auth.users row may exist for ${email}`).toHaveLength(0);
}

beforeAll(async () => {
  pool = createDbPool(env);

  // Row 14 fixture: a real advisor row whose email is the former takeover
  // vector. Synthetic only; seeded through the service role strictly to create
  // the fixture.
  advisorEmail = syntheticEmail("signup-takeover");
  const { data: advisor, error: advisorError } = await service
    .from("advisor")
    .insert({
      advisor_name: syntheticName("signup-takeover"),
      email: advisorEmail,
      is_active: false,
    })
    .select("advisor_id")
    .single();
  if (advisorError) throw new Error(`seed signup-takeover advisor: ${advisorError.message}`);
  expect(advisor).not.toBeNull();

  // Row 13 fixture: a brand-new email that has never been seen before.
  freshEmail = syntheticEmail("signup-fresh");
});

afterAll(async () => {
  if (pool) await pool.end();
});

describe("public signUp is rejected with signups disabled (R11)", () => {
  it("rejects signUp for a brand-new email and creates no auth identity (row 13)", async () => {
    // Sanity: this email is genuinely new — no advisor row or auth user uses it.
    const { rows: preExisting } = await pool.query(
      "SELECT id FROM auth.users WHERE lower(email) = lower($1)",
      [freshEmail]
    );
    expect(preExisting).toHaveLength(0);

    await expectSignUpRejected(freshEmail);
  });

  it("rejects signUp for an email matching an existing advisor row and creates no auth identity (row 14)", async () => {
    // Prove the advisor fixture actually exists before asserting the rejection.
    const { data: existing, error: reReadError } = await service
      .from("advisor")
      .select("advisor_id, email")
      .eq("email", advisorEmail)
      .maybeSingle();
    expect(reReadError).toBeNull();
    expect(existing, "the advisor fixture must exist").not.toBeNull();
    expect(existing!.email).toBe(advisorEmail);

    await expectSignUpRejected(advisorEmail);
  });
});