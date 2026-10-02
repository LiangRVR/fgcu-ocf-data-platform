/**
 * app/api/advisors/errors.ts
 *
 * Deterministic HTTP status mapping for the trusted provisioning adapter's
 * generic failure codes. Every mapped body is secret-free (the adapter never
 * echoes provider internals, emails, or keys) and never user-enumerating.
 */
import { NextResponse } from "next/server";
import type {
  ProvisionFailureCode,
  SetRoleFailureCode,
} from "@/lib/provisioning";

/** Provisioning failures → HTTP status. Upstream/provider failures are 502. */
function provisioningStatus(code: ProvisionFailureCode): number {
  switch (code) {
    case "advisor_not_found":
      return 404;
    case "already_bound":
      return 409;
    default:
      // invite_failed / create_failed / bind_failed / role_set_failed
      return 502;
  }
}

/** Role-change failures → HTTP status. The atomic `set_advisor_role` RPC
 * returns only these outcomes; an unknown RPC failure is a safe atomic
 * no-op-or-consistent-change and maps to 502. */
function setRoleStatus(code: SetRoleFailureCode): number {
  switch (code) {
    case "advisor_not_found":
      return 404;
    case "not_bound":
      return 409;
    default:
      // role_update_failed (atomic transaction: nothing changed, or fully
      // applied and consistent)
      return 502;
  }
}

export function provisioningFailureResponse(
  code: ProvisionFailureCode,
  message: string,
): NextResponse {
  return NextResponse.json({ error: message }, { status: provisioningStatus(code) });
}

export function setRoleFailureResponse(code: SetRoleFailureCode, message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: setRoleStatus(code) });
}