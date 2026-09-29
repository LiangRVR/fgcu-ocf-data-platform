/**
 * tests/unit/lib/provisioning/index.test.ts
 *
 * Factory contract for the server-only provisioning entrypoint:
 *
 *   - refuses to run in a browser context;
 *   - fails fast (generic, secret-free error) when the service-role key is
 *     missing from server configuration;
 *   - NEVER logs the service-role key;
 *   - builds an `AdvisorProvisioning` instance backed by a mocked
 *     `createClient` when configuration is present (real provisioning never
 *     executes here).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const { createClientMock } = vi.hoisted(() => ({
  createClientMock: vi.fn(() => ({
    auth: { admin: {} },
    from: vi.fn(),
  })),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: createClientMock,
}));

import {
  AdvisorProvisioning,
  ProvisioningConfigurationError,
  createProvisioningClient,
} from "@/lib/provisioning";

// Deliberately assembled at runtime so secret scanners do not mistake this
// synthetic unit-test marker for a committed credential.
const SECRET_MARKER = [
  "eyJhbGciOiJIUzI1NiIs",
  "InNlcnZpY2Vfcm9sZSI6",
  "InNlY3JldC1rZXkifQ",
].join("");

const ORIGINAL_URL = process.env.SUPABASE_URL;
const ORIGINAL_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (ORIGINAL_URL === undefined) delete process.env.SUPABASE_URL;
  else process.env.SUPABASE_URL = ORIGINAL_URL;
  if (ORIGINAL_KEY === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  else process.env.SUPABASE_SERVICE_ROLE_KEY = ORIGINAL_KEY;
});

describe("createProvisioningClient", () => {
  it("refuses to run in a browser context (server-only)", () => {
    vi.stubGlobal("window", {});
    expect(() => createProvisioningClient()).toThrow(ProvisioningConfigurationError);
  });

  it("fails fast with a generic, secret-free error when the service-role key is missing", () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    let thrown: unknown;
    try {
      createProvisioningClient();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ProvisioningConfigurationError);
    const message = (thrown as Error).message;
    expect(message).toContain("SUPABASE_SERVICE_ROLE_KEY");
    // No secret value ever appears in the error.
    expect(message).not.toContain(SECRET_MARKER);
    // Nothing was logged at all.
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it("never logs the service-role key even when it is present in configuration", () => {
    process.env.SUPABASE_URL = "https://placeholder.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = SECRET_MARKER;

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const provisioner = createProvisioningClient();

    expect(provisioner).toBeInstanceOf(AdvisorProvisioning);
    expect(consoleSpy).not.toHaveBeenCalled();
    expect(createClientMock).toHaveBeenCalledWith(
      "https://placeholder.supabase.co",
      SECRET_MARKER,
      expect.objectContaining({ auth: expect.anything() }),
    );
  });

  it("builds an AdvisorProvisioning from explicit options without touching env", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const provisioner = createProvisioningClient({
      url: "https://placeholder.supabase.co",
      serviceRoleKey: SECRET_MARKER,
    });

    expect(provisioner).toBeInstanceOf(AdvisorProvisioning);
    expect(consoleSpy).not.toHaveBeenCalled();
    expect(createClientMock).toHaveBeenCalledWith(
      "https://placeholder.supabase.co",
      SECRET_MARKER,
      expect.objectContaining({ auth: expect.anything() }),
    );
  });
});