/**
 * lib/provisioning/index.ts
 *
 * Server-only provisioning entrypoint. Re-exports the injectable
 * `AdvisorProvisioning` adapter and provides a factory that builds the
 * service-role Admin client from server configuration.
 *
 * Server-only by construction: the factory requires the Supabase service-role
 * secret (`SUPABASE_SERVICE_ROLE_KEY`), which exists only in server
 * configuration and is NEVER logged or exposed to the client. The core adapter
 * is injectable, so unit tests substitute a mocked Admin client and real
 * provisioning never executes in tests.
 */
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { AdvisorProvisioning } from "./advisor";

export { AdvisorProvisioning } from "./advisor";
export type {
  AdminClient,
  ProvisionAdvisorInput,
  ProvisionFailure,
  ProvisionFailureCode,
  ProvisionResult,
  ProvisionSuccess,
} from "./advisor";

/** Thrown when server configuration for provisioning is incomplete. */
export class ProvisioningConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProvisioningConfigurationError";
  }
}

export interface ProvisioningClientOptions {
  url?: string;
  serviceRoleKey?: string;
}

/**
 * Build an `AdvisorProvisioning` instance backed by the service-role client.
 *
 * Reads `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from server
 * configuration. Refuses to run in a browser context and fails fast when the
 * secret is missing — never logs it.
 */
export function createProvisioningClient(
  options: ProvisioningClientOptions = {},
): AdvisorProvisioning {
  if (typeof window !== "undefined") {
    throw new ProvisioningConfigurationError(
      "AdvisorProvisioning is server-only and cannot run in a browser context.",
    );
  }

  const url = options.url ?? process.env.SUPABASE_URL;
  const serviceRoleKey = options.serviceRoleKey ?? process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new ProvisioningConfigurationError(
      "Advisor provisioning requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY server configuration.",
    );
  }

  const admin = createClient<Database>(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  return new AdvisorProvisioning(admin);
}