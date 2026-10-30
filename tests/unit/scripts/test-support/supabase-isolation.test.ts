/**
 * tests/unit/scripts/test-support/supabase-isolation.test.ts
 *
 * Unit coverage for the shared runner helpers in
 * `scripts/test-support/supabase-isolation.mjs`:
 *
 *   - `parseSupabaseStatus` maps real `supabase status -o env` output
 *     (bare `API_URL`/`ANON_KEY`/`SERVICE_ROLE_KEY`/`DB_URL` + aliases,
 *     quoted/exported values, CRLF, noise lines, pretty-label fallback,
 *     backslash escapes and inline comments);
 *   - `parseSupabaseStatusJson` maps `supabase status -o json` output
 *     (flat object, camelCase keys, array wrapper) through the same table;
 *   - `mergeRuntimeMaps`/`hasRequiredRuntime` merge partial captures and
 *     detect the four required values;
 *   - `captureRuntimeEnv` bounds the `status -o env` capture, retrying
 *     transient failures and completing partial captures via `-o json`;
 *   - `runtimeEnv` injects captured values under canonical names plus
 *     `SUPABASE_*` aliases;
 *   - `sanitizeEnv` strips every credential-shaped variable (bare keys,
 *     `SUPABASE_*`, `NEXT_PUBLIC_*`, `POSTGRES_*`, `VITE_*`, `REACT_APP_*`,
 *     and `*_KEY`/`*_TOKEN`/`*_SECRET`/`*_PASSWORD`/`*_CREDENTIAL` suffixes)
 *     while preserving ONLY the exact non-secret
 *     `SUPABASE_INTERNAL_IMAGE_REGISTRY` registry-routing key, and only when
 *     its value is a plain safely validated registry host;
 *   - `redactSensitiveOutput` masks JWTs, URL userinfo, credential
 *     assignments, and known runtime values (sentinel redaction) in captured
 *     command output, plus secret-bearing CLI table rows (`Publishable`/
 *     `Secret`/`Access Key`/`Secret Key` compact, pipe, and box-drawing
 *     formats), their wrapped continuation cells (bordered and compact
 *     unbordered), bare `sb_publishable_*`/`sb_secret_*` and AWS/S3-style
 *     tokens, long key-shaped token runs, and bare JWT fragments;
 *   - `createRedactTransform`/`pipeRedacted` stream-redact child output so no
 *     sentinel reaches a terminal or artifact;
 *   - `killChildGracefully` stops a child with an awaited SIGTERM that
 *     escalates to SIGKILL;
 *   - `isLoopbackHttpUrl`/`isLoopbackDbUrl`/`presenceSummary`/`findFreePorts`
 *     behave as the runners rely on;
 *   - `isTransientRegistryStartFailure` is narrowly positive and locality-bound:
 *     only a registry/image-pull context combined with a transient network
 *     transport error ON THE SAME LINE is retryable; deterministic pull errors,
 *     non-registry failures, and pull text followed by an unrelated transport
 *     error are not;
 *   - `confirmTeardownBeforeRetry` permits a retry only after an explicitly
 *     confirmed isolated teardown (missing/false/throw fails closed);
 *   - `startFailureDiagnosticExcerpt` redacts captured startup output before
 *     bounding it by line/character count;
 *   - `startFailureSummary` surfaces a fixed summary, exit/attempt metadata,
 *     and only that bounded REDACTED excerpt — never raw captured output, even
 *     when it contains credentials.
 *   - `stopIsolatedSupabase` runs the `supabase stop` teardown with FULL
 *     containment: hostile inherited credentials (bare and `SUPABASE_*`) are
 *     never passed into the child env, and captured labelled-secret /
 *     credential-assignment output is redacted before it can be emitted.
 */
import { describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  REPOSITORY_PROJECT_ID,
  SUPABASE_PROJECT_LABEL,
  activeChildCount,
  assertSafeProjectId,
  captureRuntimeEnv,
  completeRetryableTeardown,
  confirmTeardownBeforeRetry,
  createRedactTransform,
  createScopedLaneTeardown,
  dockerScopedListArgs,
  dockerScopedRemoveArgs,
  findFreePorts,
  hasRequiredRuntime,
  installSignalTeardown,
  isLoopbackDbUrl,
  isLoopbackHttpUrl,
  isPortConflictOutput,
  isPortFree,
  isSafeProjectId,
  isTransientRegistryStartFailure,
  killChildGracefully,
  laneRecoverySummary,
  mergeRuntimeMaps,
  parseDockerIds,
  parseSupabaseStatus,
  parseSupabaseStatusJson,
  pipeRedacted,
  presenceSummary,
  reapScopedDockerResources,
  redactSensitiveOutput,
  runtimeEnv,
  runProbe,
  runTeardownSubprocess,
  runTrackedSubprocess,
  sanitizeEnv,
  startFailureDiagnosticExcerpt,
  startFailureSummary,
  stopIsolatedSupabase,
  terminateAllChildren,
  trackChild,
  untrackChild,
} from "../../../../scripts/test-support/supabase-isolation.mjs";

describe("parseSupabaseStatus", () => {
  it("maps bare CLI env keys (this CLI generation)", () => {
    const status = parseSupabaseStatus(
      [
        'API_URL="http://127.0.0.1:54321"',
        'ANON_KEY="eyJanon"',
        'SERVICE_ROLE_KEY="eyJservice"',
        'DB_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres"',
        'JWT_SECRET="super-secret-jwt-token-with-at-least-32-characters-x"',
      ].join("\n")
    );
    expect(status.apiUrl).toBe("http://127.0.0.1:54321");
    expect(status.anonKey).toBe("eyJanon");
    expect(status.serviceRoleKey).toBe("eyJservice");
    expect(status.dbUrl).toBe("postgresql://postgres:postgres@127.0.0.1:54322/postgres");
    expect(status.jwtSecret).toBe("super-secret-jwt-token-with-at-least-32-characters-x");
  });

  it("accepts SUPABASE_* aliases and export prefixes", () => {
    const status = parseSupabaseStatus(
      [
        'export SUPABASE_URL="http://127.0.0.1:54321"',
        'export SUPABASE_ANON_KEY="eyJanon"',
        'SUPABASE_SERVICE_ROLE_KEY="eyJservice"',
        'SUPABASE_DB_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres"',
      ].join("\n")
    );
    expect(status.apiUrl).toBe("http://127.0.0.1:54321");
    expect(status.anonKey).toBe("eyJanon");
    expect(status.serviceRoleKey).toBe("eyJservice");
    expect(status.dbUrl).toBe("postgresql://postgres:postgres@127.0.0.1:54322/postgres");
  });

  it("ignores noise lines and CRLF line endings", () => {
    const status = parseSupabaseStatus(
      [
        "Using workdir /tmp/ocf-contract-abc123",
        'API_URL="http://127.0.0.1:54321"',
        'ANON_KEY="eyJanon"',
        'SERVICE_ROLE_KEY="eyJservice"',
        'DB_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres"',
        "Stopped services: [\"studio\"]",
      ].join("\r\n")
    );
    expect(status.apiUrl).toBe("http://127.0.0.1:54321");
    expect(status.serviceRoleKey).toBe("eyJservice");
  });

  it("falls back to pretty Label: value lines when env keys are missing", () => {
    const status = parseSupabaseStatus(
      [
        "         API URL: http://127.0.0.1:54321",
        "         DB URL: postgresql://postgres:postgres@127.0.0.1:54322/postgres",
        "         anon key: eyJanon",
        "service_role key: eyJservice",
      ].join("\n")
    );
    expect(status.apiUrl).toBe("http://127.0.0.1:54321");
    expect(status.dbUrl).toBe("postgresql://postgres:postgres@127.0.0.1:54322/postgres");
    expect(status.anonKey).toBe("eyJanon");
    expect(status.serviceRoleKey).toBe("eyJservice");
  });

  it("parses a verbatim actual-style `supabase status` table (real labels + noise)", () => {
    // This is the exact shape the Supabase CLI prints for `supabase status`
    // (no `-o` flag): a banner line, space-padded mixed-case labels, URL and
    // non-secret noise lines the parser must ignore, and the JWT secret label.
    const status = parseSupabaseStatus(
      [
        "Started supabase local development setup.",
        "",
        "         API URL: http://127.0.0.1:54321",
        "      GraphQL URL: http://127.0.0.1:54321/graphql/v1",
        "   S3 Storage URL: http://127.0.0.1:54321/storage/v1/s3",
        "          DB URL: postgresql://postgres:postgres@127.0.0.1:54322/postgres",
        "      Studio URL: http://127.0.0.1:54323",
        "    Inbucket URL: http://127.0.0.1:54324",
        "     JWT secret: super-secret-jwt-token-with-at-least-32-characters-long",
        "       anon key: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0",
        "      service_role key: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGsYpvnqTvhK6pS3nRvB-sLxHN7FAE7mN6JPb3T7Buc",
        "        S3 Access Key: AKIATESTACCESSKEY",
        "        S3 Secret Key: s3secretvaluethatmustneverleak",
        "         S3 Region: us-east-1",
      ].join("\n")
    );
    expect(status.apiUrl).toBe("http://127.0.0.1:54321");
    expect(status.dbUrl).toBe("postgresql://postgres:postgres@127.0.0.1:54322/postgres");
    expect(status.anonKey).toBe(
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0"
    );
    expect(status.serviceRoleKey).toBe(
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGsYpvnqTvhK6pS3nRvB-sLxHN7FAE7mN6JPb3T7Buc"
    );
    expect(status.jwtSecret).toBe("super-secret-jwt-token-with-at-least-32-characters-long");
  });

  it("returns undefined fields for incomplete output", () => {
    const status = parseSupabaseStatus('API_URL="http://127.0.0.1:54321"\nANON_KEY="eyJanon"');
    expect(status.apiUrl).toBe("http://127.0.0.1:54321");
    expect(status.anonKey).toBe("eyJanon");
    expect(status.dbUrl).toBeUndefined();
    expect(status.serviceRoleKey).toBeUndefined();
  });

  it("decodes backslash escapes and strips inline comments after quotes", () => {
    const status = parseSupabaseStatus(
      [
        'API_URL="http://127.0.0.1:54321" # trailing comment',
        'ANON_KEY=\'eyJanon\'',
        'SERVICE_ROLE_KEY="eyJ\\"escaped\\"quote"',
        'DB_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres"',
        'JWT_SECRET="line1\\nline2"',
      ].join("\n")
    );
    expect(status.apiUrl).toBe("http://127.0.0.1:54321");
    expect(status.anonKey).toBe("eyJanon");
    expect(status.serviceRoleKey).toBe('eyJ"escaped"quote');
    expect(status.dbUrl).toBe("postgresql://postgres:postgres@127.0.0.1:54322/postgres");
    expect(status.jwtSecret).toBe("line1\nline2");
  });

  it("tolerates empty values without misparsing neighbors", () => {
    const status = parseSupabaseStatus(
      ['API_URL="http://127.0.0.1:54321"', 'EMPTY=""', "ANON_KEY="].join("\n")
    );
    expect(status.apiUrl).toBe("http://127.0.0.1:54321");
    expect(status.anonKey).toBeUndefined();
  });
});

describe("parseSupabaseStatusJson", () => {
  it("parses a flat JSON object with canonical keys", () => {
    const status = parseSupabaseStatusJson(
      JSON.stringify({
        API_URL: "http://127.0.0.1:54321",
        ANON_KEY: "eyJanon",
        SERVICE_ROLE_KEY: "eyJservice",
        DB_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
      })
    );
    expect(status.apiUrl).toBe("http://127.0.0.1:54321");
    expect(status.anonKey).toBe("eyJanon");
    expect(status.serviceRoleKey).toBe("eyJservice");
    expect(status.dbUrl).toBe("postgresql://postgres:postgres@127.0.0.1:54322/postgres");
  });

  it("accepts camelCase keys and an array wrapper", () => {
    const status = parseSupabaseStatusJson(
      JSON.stringify([
        {
          apiUrl: "http://127.0.0.1:54321",
          anonKey: "eyJanon",
          serviceRoleKey: "eyJservice",
          dbUrl: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
        },
      ])
    );
    expect(status.apiUrl).toBe("http://127.0.0.1:54321");
    expect(status.serviceRoleKey).toBe("eyJservice");
    expect(status.dbUrl).toBe("postgresql://postgres:postgres@127.0.0.1:54322/postgres");
  });

  it("returns an empty mapping for malformed JSON", () => {
    expect(parseSupabaseStatusJson("not-json")).toEqual({});
    expect(parseSupabaseStatusJson("42")).toEqual({});
  });
});

describe("mergeRuntimeMaps and hasRequiredRuntime", () => {
  it("fills missing canonical fields from later maps (first non-empty wins)", () => {
    const merged = mergeRuntimeMaps(
      { apiUrl: "http://127.0.0.1:54321", dbUrl: undefined },
      { anonKey: "eyJanon", serviceRoleKey: "eyJservice", dbUrl: "postgresql://postgres:postgres@127.0.0.1:54322/postgres" },
      { anonKey: "should-not-win" }
    );
    expect(merged).toEqual({
      apiUrl: "http://127.0.0.1:54321",
      dbUrl: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
      anonKey: "eyJanon",
      serviceRoleKey: "eyJservice",
    });
  });

  it("merges only non-empty string values", () => {
    expect(mergeRuntimeMaps({ apiUrl: "" }, { apiUrl: "http://127.0.0.1:54321" })).toEqual({
      apiUrl: "http://127.0.0.1:54321",
    });
    expect(mergeRuntimeMaps(undefined, null)).toEqual({});
  });

  it("detects the four required runtime values", () => {
    expect(
      hasRequiredRuntime({ apiUrl: "a", dbUrl: "b", anonKey: "c", serviceRoleKey: "d" })
    ).toBe(true);
    expect(hasRequiredRuntime({ apiUrl: "a", dbUrl: "b", anonKey: "c" })).toBe(false);
    expect(hasRequiredRuntime({ apiUrl: "", dbUrl: "b", anonKey: "c", serviceRoleKey: "d" })).toBe(false);
    expect(hasRequiredRuntime(undefined)).toBe(false);
  });
});

describe("captureRuntimeEnv", () => {
  const completeEnv = [
    'API_URL="http://127.0.0.1:54321"',
    'ANON_KEY="eyJanon"',
    'SERVICE_ROLE_KEY="eyJservice"',
    'DB_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres"',
  ].join("\n");

  it("succeeds on the first env capture", async () => {
    const calls: string[] = [];
    const capture = await captureRuntimeEnv({
      run: (format) => {
        calls.push(format);
        return { status: 0, stdout: completeEnv, stderr: "" };
      },
    });
    expect(capture.ok).toBe(true);
    if (!capture.ok) return;
    expect(capture.source).toBe("env");
    expect(capture.runtime.apiUrl).toBe("http://127.0.0.1:54321");
    expect(calls).toEqual(["env"]);
  });

  it("retries bounded on a transient non-zero exit", async () => {
    const calls: string[] = [];
    const capture = await captureRuntimeEnv({
      run: (format) => {
        calls.push(format);
        if (format === "env" && calls.length === 1) {
          return { status: 1, stdout: "", stderr: "container warming up" };
        }
        return { status: 0, stdout: completeEnv, stderr: "" };
      },
      attempts: 3,
      retryDelayMs: 0,
    });
    expect(capture.ok).toBe(true);
    if (!capture.ok) return;
    expect(capture.source).toBe("env");
    expect(calls).toEqual(["env", "env"]);
  });

  it("retries bounded on an incomplete env parse, then completes via -o json", async () => {
    const calls: string[] = [];
    const partialEnv = 'API_URL="http://127.0.0.1:54321"\nANON_KEY="eyJanon"';
    const capture = await captureRuntimeEnv({
      run: (format) => {
        calls.push(format);
        if (format === "env") return { status: 0, stdout: partialEnv, stderr: "" };
        return {
          status: 0,
          stdout: JSON.stringify({
            API_URL: "http://127.0.0.1:54321",
            ANON_KEY: "eyJanon",
            SERVICE_ROLE_KEY: "eyJservice",
            DB_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
          }),
          stderr: "",
        };
      },
      attempts: 2,
      retryDelayMs: 0,
    });
    expect(capture.ok).toBe(true);
    if (!capture.ok) return;
    expect(capture.source).toBe("json-merged");
    expect(capture.runtime.serviceRoleKey).toBe("eyJservice");
    expect(capture.runtime.dbUrl).toBe("postgresql://postgres:postgres@127.0.0.1:54322/postgres");
    expect(calls).toEqual(["env", "env", "json"]);
  });

  it("reports an environment blocker when all retries and the json fallback fail", async () => {
    const capture = await captureRuntimeEnv({
      run: () => ({ status: 1, stdout: "", stderr: "nope" }),
      attempts: 2,
      retryDelayMs: 0,
    });
    expect(capture.ok).toBe(false);
    if (capture.ok) return;
    expect(presenceSummary(capture.runtime)).toContain("missing");
  });

  it("redacts the runner failure-path diagnostics so a sentinel never reaches the log", async () => {
    const sentinel = "SENTINEL_1b2c3d";
    const capture = await captureRuntimeEnv({
      run: (format) => {
        if (format === "env") {
          return {
            status: 0,
            stdout: `API_URL="http://127.0.0.1:54321"\nSERVICE_ROLE_KEY="${sentinel}"`,
            stderr: "",
          };
        }
        return { status: 1, stdout: "", stderr: "boom" };
      },
      attempts: 2,
      retryDelayMs: 0,
    });
    expect(capture.ok).toBe(false);
    if (capture.ok) return;
    const diagnostics = [
      capture.envResult?.stderr?.trim(),
      capture.envResult?.stdout?.trim(),
      capture.jsonResult?.stderr?.trim(),
      capture.jsonResult?.stdout?.trim(),
    ]
      .filter(Boolean)
      .join("\n");
    const printed = redactSensitiveOutput(diagnostics, { runtime: capture.runtime });
    expect(printed).not.toContain(sentinel);
    expect(printed).toContain("SERVICE_ROLE_KEY=[REDACTED]");
  });
});

describe("runtimeEnv", () => {
  it("injects canonical names as authoritative plus SUPABASE_* aliases", () => {
    const env = runtimeEnv(
      { PATH: "/usr/bin", HOME: "/home/user" },
      {
        apiUrl: "http://127.0.0.1:54321",
        dbUrl: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
        anonKey: "eyJanon",
        serviceRoleKey: "eyJservice",
        jwtSecret: "s3cret",
      }
    );
    expect(env.API_URL).toBe("http://127.0.0.1:54321");
    expect(env.ANON_KEY).toBe("eyJanon");
    expect(env.SERVICE_ROLE_KEY).toBe("eyJservice");
    expect(env.DB_URL).toBe("postgresql://postgres:postgres@127.0.0.1:54322/postgres");
    expect(env.JWT_SECRET).toBe("s3cret");
    expect(env.SUPABASE_URL).toBe(env.API_URL);
    expect(env.SUPABASE_API_URL).toBe(env.API_URL);
    expect(env.SUPABASE_PUBLIC_URL).toBe(env.API_URL);
    expect(env.SUPABASE_DB_URL).toBe(env.DB_URL);
    expect(env.SUPABASE_ANON_KEY).toBe(env.ANON_KEY);
    expect(env.SUPABASE_SERVICE_ROLE_KEY).toBe(env.SERVICE_ROLE_KEY);
    expect(env.SUPABASE_JWT_SECRET).toBe(env.JWT_SECRET);
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/user");
  });

  it("does not clobber unrelated base variables", () => {
    const env = runtimeEnv({ PATH: "/usr/bin", HOME: "/home/user" }, { apiUrl: "a", dbUrl: "b", anonKey: "c", serviceRoleKey: "d" });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/user");
  });
});

describe("sanitizeEnv", () => {
  it("strips bare credential keys and SUPABASE_*/NEXT_PUBLIC_* prefixes", () => {
    const clean = sanitizeEnv({
      API_URL: "http://127.0.0.1:54321",
      ANON_KEY: "eyJanon",
      SERVICE_ROLE_KEY: "eyJservice",
      DB_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
      SUPABASE_URL: "http://127.0.0.1:54321",
      SUPABASE_SERVICE_ROLE_KEY: "eyJservice",
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "eyJanon",
      PATH: "/usr/bin",
      HOME: "/home/user",
    });
    expect(clean.API_URL).toBeUndefined();
    expect(clean.ANON_KEY).toBeUndefined();
    expect(clean.SERVICE_ROLE_KEY).toBeUndefined();
    expect(clean.DB_URL).toBeUndefined();
    expect(clean.SUPABASE_URL).toBeUndefined();
    expect(clean.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
    expect(clean.NEXT_PUBLIC_SUPABASE_URL).toBeUndefined();
    expect(clean.NEXT_PUBLIC_SUPABASE_ANON_KEY).toBeUndefined();
    expect(clean.PATH).toBe("/usr/bin");
    expect(clean.HOME).toBe("/home/user");
  });

  it("preserves only the exact non-secret registry-routing key among SUPABASE_* variables", () => {
    const clean = sanitizeEnv({
      // The documented non-secret Supabase CLI image-registry route (CI sets it
      // to Docker Hub) must survive so the lane's CLI child can use it.
      SUPABASE_INTERNAL_IMAGE_REGISTRY: "docker.io",
      // Every other SUPABASE_* value — including credentials/tokens and
      // near-miss lookalikes built from the allowed key — stays stripped.
      SUPABASE_URL: "https://hosted-project.supabase.co",
      SUPABASE_ACCESS_TOKEN: "sbp_hostile_token",
      SUPABASE_SERVICE_ROLE_KEY: "eyJservice",
      SUPABASE_DB_URL: "postgresql://hosted:secret@db.internal.example:5432/prod",
      SUPABASE_INTERNAL_IMAGE_REGISTRY_TOKEN: "hostile-registry-token",
      SUPABASE_INTERNAL_IMAGE_REGISTRY_SECRET: "hostile-registry-secret",
      SUPABASE_INTERNAL_IMAGE_REGISTRY_CREDENTIAL: "hostile-registry-credential",
      SUPABASE_INTERNAL_IMAGE_REGISTRY_PASSWORD: "hostile-registry-password",
      SUPABASE_INTERNAL_IMAGE_REGISTRY_API_KEY: "hostile-registry-key",
      // Case-variant keys are not the CLI's exact key and are not exempted.
      supabase_internal_image_registry: "docker.io",
      PATH: "/usr/bin",
    });
    expect(clean.SUPABASE_INTERNAL_IMAGE_REGISTRY).toBe("docker.io");
    for (const key of [
      "SUPABASE_URL",
      "SUPABASE_ACCESS_TOKEN",
      "SUPABASE_SERVICE_ROLE_KEY",
      "SUPABASE_DB_URL",
      "SUPABASE_INTERNAL_IMAGE_REGISTRY_TOKEN",
      "SUPABASE_INTERNAL_IMAGE_REGISTRY_SECRET",
      "SUPABASE_INTERNAL_IMAGE_REGISTRY_CREDENTIAL",
      "SUPABASE_INTERNAL_IMAGE_REGISTRY_PASSWORD",
      "SUPABASE_INTERNAL_IMAGE_REGISTRY_API_KEY",
      "supabase_internal_image_registry",
    ]) {
      expect(clean[key], `${key} must be stripped by sanitizeEnv`).toBeUndefined();
    }
    expect(clean.PATH).toBe("/usr/bin");
  });

  it("preserves ordinary safe Docker registry host values", () => {
    for (const value of [
      "docker.io",
      "registry.example.com",
      "ghcr.io",
      "public.ecr.aws",
      "localhost:5000",
      "host.docker.internal:5000",
      "REGISTRY.EXAMPLE.COM:443",
    ]) {
      const clean = sanitizeEnv({ SUPABASE_INTERNAL_IMAGE_REGISTRY: value });
      expect(clean.SUPABASE_INTERNAL_IMAGE_REGISTRY, `${value} must survive`).toBe(value);
    }
  });

  it("removes registry values with credential-bearing URLs, schemes, paths, or unsafe syntax", () => {
    for (const value of [
      // Credential-bearing URL / userinfo.
      "https://user:token@registry.example",
      "user:token@registry.example.com",
      // Scheme-only URL.
      "https://registry.example.com",
      // Paths, query strings, and fragments.
      "registry.example.com/supabase",
      "registry.example.com:5000/team",
      "registry.example.com?token=abc",
      "registry.example.com#fragment",
      // Whitespace.
      " docker.io",
      "docker.io ",
      "docker .io",
      "docker.io\n",
      // Unsafe host syntax.
      "-registry.example.com",
      "registry-.example.com",
      "registry_example.com",
      ".registry.example.com",
      "registry.example.com.",
      // Out-of-range or non-numeric ports.
      "docker.io:0",
      "docker.io:65536",
      "docker.io:99999",
      "docker.io:abc",
      // Empty value.
      "",
    ]) {
      const clean = sanitizeEnv({ SUPABASE_INTERNAL_IMAGE_REGISTRY: value });
      expect(
        clean.SUPABASE_INTERNAL_IMAGE_REGISTRY,
        `unsafe value ${JSON.stringify(value)} must be removed`
      ).toBeUndefined();
    }
  });

  it("strips POSTGRES_*/PG* and suffix-marked credential variables", () => {
    const clean = sanitizeEnv({
      PGHOST: "127.0.0.1",
      PGPORT: "54322",
      PGUSER: "postgres",
      PGPASSWORD: "postgres",
      POSTGRES_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
      DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
      MY_API_KEY: "abc123",
      AWS_SECRET_ACCESS_KEY: "secret",
      DB_PASSWORD: "hunter2",
      SOME_TOKEN: "tok",
      FOO_CREDENTIAL: "cred",
      BUILD_DIR: "/tmp/build",
      E2E_APP_PORT: "3100",
    });
    expect(clean.PGHOST).toBeUndefined();
    expect(clean.PGPORT).toBeUndefined();
    expect(clean.PGUSER).toBeUndefined();
    expect(clean.PGPASSWORD).toBeUndefined();
    expect(clean.POSTGRES_URL).toBeUndefined();
    expect(clean.DATABASE_URL).toBeUndefined();
    expect(clean.MY_API_KEY).toBeUndefined();
    expect(clean.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(clean.DB_PASSWORD).toBeUndefined();
    expect(clean.SOME_TOKEN).toBeUndefined();
    expect(clean.FOO_CREDENTIAL).toBeUndefined();
    expect(clean.BUILD_DIR).toBe("/tmp/build");
    expect(clean.E2E_APP_PORT).toBe("3100");
  });
});

describe("redactSensitiveOutput", () => {
  it("redacts JWT-shaped tokens", () => {
    const redacted = redactSensitiveOutput(
      "token eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.signature leaked here"
    );
    expect(redacted).not.toContain("eyJhbGci");
    expect(redacted).toContain("[REDACTED]");
  });

  it("redacts credentials embedded in postgres URLs", () => {
    const redacted = redactSensitiveOutput(
      "postgresql://postgres:supersecret@127.0.0.1:54322/postgres"
    );
    expect(redacted).not.toContain("supersecret");
    expect(redacted).toContain("postgresql://postgres:[REDACTED]@127.0.0.1:54322/postgres");
  });

  it("redacts userinfo credentials from arbitrary URL schemes", () => {
    const redacted = redactSensitiveOutput(
      'Get "https://ci-user:registry-sentinel@registry.example.test/v2/": 503 Service Unavailable'
    );
    expect(redacted).not.toContain("registry-sentinel");
    expect(redacted).toContain("https://ci-user:[REDACTED]@registry.example.test/v2/");
  });

  it("redacts credential assignments while preserving the key name", () => {
    const redacted = redactSensitiveOutput(
      ['SERVICE_ROLE_KEY="eyJservice"', "JWT_SECRET=abc", 'ANON_KEY="eyJanon"', "SUPABASE_URL=http://127.0.0.1:54321"].join("\n")
    );
    expect(redacted).toContain("SERVICE_ROLE_KEY=[REDACTED]");
    expect(redacted).toContain("JWT_SECRET=[REDACTED]");
    expect(redacted).toContain("ANON_KEY=[REDACTED]");
    expect(redacted).toContain("SUPABASE_URL=[REDACTED]");
    expect(redacted).not.toContain("eyJservice");
    expect(redacted).not.toContain("abc");
  });

  it("redacts known runtime values when provided", () => {
    const redacted = redactSensitiveOutput("runtime captured: http://127.0.0.1:54321 and eyJanon", {
      runtime: { apiUrl: "http://127.0.0.1:54321", anonKey: "eyJanon" },
    });
    expect(redacted).not.toContain("127.0.0.1:54321");
    expect(redacted).not.toContain("eyJanon");
  });

  it("redacts the E2E seed JSON line that embeds seeded passwords", () => {
    const seedLine =
      'E2E_SEED_JSON={"activeAdvisorPassword":"E2eLocalPass!2026","reportTotals":{"students":2}}';
    const redacted = redactSensitiveOutput(seedLine);
    expect(redacted).toContain("E2E_SEED_JSON=[REDACTED]");
    expect(redacted).not.toContain("E2eLocalPass!2026");
  });

  it("redacts a known sentinel value so it can never reach the terminal/artifact", () => {
    const sentinel = "SENTINEL_9f3a7c42";
    const redacted = redactSensitiveOutput(`runtime captured: ${sentinel}`, {
      runtime: { anonKey: sentinel },
    });
    expect(redacted).not.toContain(sentinel);
    expect(redacted).toContain("[REDACTED]");
  });

  it("redacts sentinel values on every matching runtime field", () => {
    const apiSentinel = "http://127.0.0.1:59999";
    const dbSentinel = "postgresql://postgres:hunter2@127.0.0.1:59998/postgres";
    const redacted = redactSensitiveOutput(`api=${apiSentinel} db=${dbSentinel}`, {
      runtime: { apiUrl: apiSentinel, dbUrl: dbSentinel },
    });
    expect(redacted).not.toContain(apiSentinel);
    expect(redacted).not.toContain(dbSentinel);
  });

  it("redacts labelled pre-runtime CLI secret lines (pretty Label: value) even without a runtime map", () => {
    // A failed capture prints `status` output before any runtime values exist,
    // so the pretty `Label: value` form must be scrubbed on its own.
    const sentinel = "s3secretvaluethatmustneverleak";
    const redacted = redactSensitiveOutput(
      [
        "         API URL: http://127.0.0.1:54321",
        "         anon key: eyJanon",
        "      service_role key: eyJservice",
        "     JWT secret: super-secret-jwt-token-with-at-least-32-characters-long",
        "        S3 Access Key: AKIATESTACCESSKEY",
        `        S3 Secret Key: ${sentinel}`,
      ].join("\n")
    );
    expect(redacted).toContain("API URL: [REDACTED]");
    expect(redacted).toContain("anon key: [REDACTED]");
    expect(redacted).toContain("service_role key: [REDACTED]");
    expect(redacted).toContain("JWT secret: [REDACTED]");
    expect(redacted).toContain("S3 Access Key: [REDACTED]");
    expect(redacted).toContain("S3 Secret Key: [REDACTED]");
    expect(redacted).not.toContain("eyJservice");
    expect(redacted).not.toContain(sentinel);
  });

  it("preserves non-secret pretty labels and their values", () => {
    const redacted = redactSensitiveOutput(
      [
        "      GraphQL URL: http://127.0.0.1:54321/graphql/v1",
        "      Studio URL: http://127.0.0.1:54323",
        "         S3 Region: us-east-1",
      ].join("\n")
    );
    expect(redacted).toContain("GraphQL URL: http://127.0.0.1:54321/graphql/v1");
    expect(redacted).toContain("Studio URL: http://127.0.0.1:54323");
    expect(redacted).toContain("S3 Region: us-east-1");
  });

  it("redacts compact `supabase start` table rows with Publishable/Secret labels", () => {
    // Compact table rows (label padded to a column) the CLI prints before the
    // runtime is captured. The values here are NOT JWT-shaped, so the JWT
    // pass alone can never catch them — the label must drive the redaction.
    const redacted = redactSensitiveOutput(
      [
        "Publishable  sb_publishable_local_key_abcdef123456",
        "Secret       sb_secret_local_key_abcdef123456",
      ].join("\n")
    );
    expect(redacted).not.toContain("sb_publishable");
    expect(redacted).not.toContain("sb_secret");
    expect(redacted).toContain("Publishable  [REDACTED]");
    expect(redacted).toContain("Secret       [REDACTED]");
  });

  it("redacts compact Access Key / Secret Key table rows (S3-style bare values)", () => {
    const redacted = redactSensitiveOutput(
      ["Access Key   AKIATESTACCESSKEY", "Secret Key   s3secretvaluethatmustneverleak"].join("\n")
    );
    expect(redacted).not.toContain("AKIATESTACCESSKEY");
    expect(redacted).not.toContain("s3secretvaluethatmustneverleak");
    expect(redacted).toContain("Access Key   [REDACTED]");
    expect(redacted).toContain("Secret Key   [REDACTED]");
  });

  it("redacts box-drawing and pipe table rows", () => {
    const redacted = redactSensitiveOutput(
      [
        "│ Secret      │ bare-s3-secret-value-here │",
        "| Publishable | eyJanonValueThatIsNotJwt |",
        "│ anon key    │ eyJanon │",
      ].join("\n")
    );
    expect(redacted).not.toContain("bare-s3-secret-value-here");
    expect(redacted).not.toContain("eyJanonValueThatIsNotJwt");
    expect(redacted).not.toContain("eyJanon");
    expect(redacted).toContain("│ Secret      │ [REDACTED] │");
    expect(redacted).toContain("| Publishable | [REDACTED] |");
    expect(redacted).toContain("│ anon key    │ [REDACTED] │");
  });

  it("redacts the wrapped continuation cells that follow a secret table row", () => {
    const redacted = redactSensitiveOutput(
      [
        "│ Secret │ s3secretvaluethatmustneverleak",
        "│        │ more-of-the-same-secret-value │",
      ].join("\n")
    );
    expect(redacted).not.toContain("s3secretvaluethatmustneverleak");
    expect(redacted).not.toContain("more-of-the-same-secret-value");
    expect(redacted).toContain("│ Secret │ [REDACTED]");
    expect(redacted).toContain("│        [REDACTED] │");
  });

  it("redacts indented unbordered continuation lines after a compact secret row", () => {
    const redacted = redactSensitiveOutput(
      [
        "Secret       sb_secret_local_key_abcdef123456",
        "             sb_secret_local_key_wrapped_more_value",
        "             more-wrapped-secret-fragment-here",
        "Access Key   AKIATESTACCESSKEY",
        "             AKIATESTACCESSKEY-wrapped-fragment",
      ].join("\n")
    );
    expect(redacted).not.toContain("sb_secret_local_key");
    expect(redacted).not.toContain("more-wrapped-secret-fragment-here");
    expect(redacted).not.toContain("AKIATESTACCESSKEY");
    expect(redacted).toContain("Secret       [REDACTED]");
    expect(redacted).toContain("Access Key   [REDACTED]");
    // Every indented continuation line is masked, preserving its indentation.
    expect(redacted).toContain("             [REDACTED]");
  });

  it("stops masking compact continuations when the table context ends", () => {
    const redacted = redactSensitiveOutput(
      [
        "Secret       sb_secret_local_key_abcdef123456",
        "",
        "             not a secret continuation (blank line ended the table)",
        "        Storage URL: http://127.0.0.1:54321/storage/v1/s3",
      ].join("\n")
    );
    expect(redacted).toContain("not a secret continuation (blank line ended the table)");
    expect(redacted).toContain("Storage URL: http://127.0.0.1:54321/storage/v1/s3");
    expect(redacted).not.toContain("sb_secret_local_key");
  });

  it("stops masking compact continuations when a new non-secret labelled row appears", () => {
    const redacted = redactSensitiveOutput(
      [
        "Secret       sb_secret_local_key_abcdef123456",
        "        Storage URL: http://127.0.0.1:54321/storage/v1/s3",
      ].join("\n")
    );
    expect(redacted).toContain("Storage URL: http://127.0.0.1:54321/storage/v1/s3");
    expect(redacted).not.toContain("sb_secret_local_key");
  });

  it("redacts bare sb_publishable_*/sb_secret_* tokens in standalone error text", () => {
    const redacted = redactSensitiveOutput(
      [
        "Error: failed to persist sb_publishable_local_key_abcdef123456",
        "Error: sb_secret_local_key_abcdef123456 could not be loaded",
        "sb_publishable_local_key_abcdef123456",
      ].join("\n")
    );
    expect(redacted).not.toContain("local_key_abcdef123456");
    expect(redacted).toContain("Error: failed to persist sb_publishable_[REDACTED]");
    expect(redacted).toContain("Error: sb_secret_[REDACTED] could not be loaded");
    expect(redacted).toContain("sb_publishable_[REDACTED]");
  });

  it("redacts bare AWS/S3-style access key IDs in standalone error text", () => {
    const redacted = redactSensitiveOutput("Error: storage access key AKIATESTACCESSKEY is invalid");
    expect(redacted).not.toContain("AKIATESTACCESSKEY");
    expect(redacted).toContain("Error: storage access key [REDACTED] is invalid");
  });

  it("redacts bare long non-JWT key-shaped tokens in standalone error text", () => {
    const secret = "a1B2c3D4e5F6g7H8i9J0kL1mN2oP3qR4sT5uV6wX7yZ8";
    const redacted = redactSensitiveOutput(
      `Error: dumped storage secret "${secret}" was rejected`
    );
    expect(redacted).not.toContain(secret);
    expect(redacted).toContain('Error: dumped storage secret "[REDACTED]" was rejected');
  });

  it("redacts standalone conventional S3 secret-key shaped tokens (base64 with /, +, and trailing =)", () => {
    // The canonical AWS example secret access key is 40 chars of STANDARD
    // base64 (letters, digits, `+`, `/`, and trailing `=` padding) — none of
    // which the base64url-only token rule above allows.
    const slashKey = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    const plusKey = "aBcDeFgHiJkLmNoPqRsTuVwXyZ+aBcDeFgHiJkLmNoPqRsTuVwXyZ";
    const paddedKey = "aBcDeFgHiJkLmNoPqRsTuVwXyZaBcDeFgHiJkLmNoPqRsTuVwXyZ==";
    const redacted = redactSensitiveOutput(
      [
        `Error: invalid storage secret "${slashKey}"`,
        `dumped s3 secret ${slashKey}.`,
        `value ${plusKey}`,
        `key ${paddedKey}`,
      ].join("\n")
    );
    expect(redacted).not.toContain(slashKey);
    expect(redacted).not.toContain(plusKey);
    expect(redacted).not.toContain(paddedKey);
    expect(redacted).toContain('Error: invalid storage secret "[REDACTED]"');
    expect(redacted).toContain("dumped s3 secret [REDACTED].");
    expect(redacted).toContain("value [REDACTED]");
    expect(redacted).toContain("key [REDACTED]");
  });

  it("preserves non-secret diagnostics and identifier-shaped long tokens", () => {
    const containerId = "a".repeat(64);
    const digest = "b".repeat(64);
    const redacted = redactSensitiveOutput(
      [
        "Error: port 54321 is already in use.",
        "Error response from daemon: pull access denied for supabase/postgres",
        `/tmp/ocf-contract-abc12345`,
        `/var/lib/docker/containers/abc123`,
        `https://registry.example.com/supabase/postgres`,
        `sha256:${digest}`,
        `Error: container ${containerId} failed to start`,
        "        Storage URL: http://127.0.0.1:54321/storage/v1/s3",
      ].join("\n")
    );
    expect(redacted).toContain("Error: port 54321 is already in use.");
    expect(redacted).toContain("supabase/postgres");
    expect(redacted).toContain("/tmp/ocf-contract-abc12345");
    expect(redacted).toContain("/var/lib/docker/containers/abc123");
    expect(redacted).toContain("https://registry.example.com/supabase/postgres");
    expect(redacted).toContain(`sha256:${digest}`);
    expect(redacted).toContain(`Error: container ${containerId} failed to start`);
    expect(redacted).toContain("Storage URL: http://127.0.0.1:54321/storage/v1/s3");
  });

  it("redacts bare JWT fragments that a wrapped table cell split out of a full token", () => {
    const redacted = redactSensitiveOutput(
      "│        │ eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0"
    );
    expect(redacted).not.toContain("eyJhbGci");
    expect(redacted).not.toContain("eyJpc3Mi");
    expect(redacted).toContain("[REDACTED]");
  });

  it("redacts a representative full `supabase start` table end-to-end", () => {
    const startOutput = [
      "Started supabase local development setup.",
      "",
      "         API URL: http://127.0.0.1:54321",
      "      GraphQL URL: http://127.0.0.1:54321/graphql/v1",
      "          DB URL: postgresql://postgres:postgres@127.0.0.1:54322/postgres",
      "      Studio URL: http://127.0.0.1:54323",
      "    Inbucket URL: http://127.0.0.1:54324",
      "     JWT secret: super-secret-jwt-token-with-at-least-32-characters-long",
      "       anon key: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0",
      "      service_role key: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGsYpvnqTvhK6pS3nRvB-sLxHN7FAE7mN6JPb3T7Buc",
      "        S3 Access Key: AKIATESTACCESSKEY",
      "        S3 Secret Key: s3secretvaluethatmustneverleak",
      "         S3 Region: us-east-1",
      "",
      "┌────────────────────────────┬────────────────────────────────────────────┐",
      "│ Publishable               │ eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.anon   │",
      "│ Secret                    │ eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.svc    │",
      "└────────────────────────────┴────────────────────────────────────────────┘",
    ].join("\n");
    const redacted = redactSensitiveOutput(startOutput);
    // No credential value of any shape survives — labelled or table-row.
    expect(redacted).not.toContain("postgres:postgres@");
    expect(redacted).not.toContain("super-secret-jwt-token");
    expect(redacted).not.toContain("CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0");
    expect(redacted).not.toContain("EGsYpvnqTvhK6pS3nRvB-sLxHN7FAE7mN6JPb3T7Buc");
    expect(redacted).not.toContain("AKIATESTACCESSKEY");
    expect(redacted).not.toContain("s3secretvaluethatmustneverleak");
    // Labels and non-secret rows survive for diagnostics.
    expect(redacted).toContain("anon key: [REDACTED]");
    expect(redacted).toContain("JWT secret: [REDACTED]");
    expect(redacted).toContain("S3 Access Key: [REDACTED]");
    expect(redacted).toMatch(/│ Publishable\s+│ \[REDACTED\]\s*│/);
    expect(redacted).toMatch(/│ Secret\s+│ \[REDACTED\]\s*│/);
    expect(redacted).toContain("GraphQL URL: http://127.0.0.1:54321/graphql/v1");
    expect(redacted).toContain("Studio URL: http://127.0.0.1:54323");
    expect(redacted).toContain("S3 Region: us-east-1");
  });
});

describe("streaming redaction", () => {
  const collect = async (transform: NodeJS.ReadWriteStream, input: string) => {
    let out = "";
    transform.on("data", (chunk) => {
      out += chunk.toString();
    });
    await new Promise<void>((resolve) => {
      transform.on("end", () => resolve());
      transform.end(input);
    });
    return out;
  };

  it("redacts a sentinel across a chunk boundary (no split-token leak)", async () => {
    const sentinel = "SENTINEL_ab12cd34";
    const transform = createRedactTransform({ runtime: { serviceRoleKey: sentinel } });
    let out = "";
    transform.on("data", (chunk) => {
      out += chunk.toString();
    });
    await new Promise<void>((resolve) => {
      transform.on("end", () => resolve());
      // Feed the line in two chunks that split the value; the transform must
      // buffer to the newline before redacting.
      transform.write(`SERVICE_ROLE_KEY="${sentinel.slice(0, 8)}`);
      transform.end(`${sentinel.slice(8)}"\n`);
    });
    expect(out).not.toContain(sentinel);
    expect(out).toContain("SERVICE_ROLE_KEY=[REDACTED]");
  });

  it("preserves newlines and redacts assignments in a multi-line stream", async () => {
    const transform = createRedactTransform({ runtime: { anonKey: "eyJanon" } });
    const out = await collect(
      transform,
      `line one\nANON_KEY="eyJanon"\nline three\n`
    );
    expect(out).toBe("line one\nANON_KEY=[REDACTED]\nline three\n");
  });

  it("pipeRedacted routes redacted output into a writable destination", async () => {
    const sentinel = "eyJstreamSentinel";
    const chunks: Buffer[] = [];
    const writable = new Writable({
      write(chunk: Buffer, _enc: unknown, cb: () => void) {
        chunks.push(Buffer.from(chunk));
        cb();
      },
    });
    const input = new Readable({
      read() {
        this.push(`ANON_KEY="${sentinel}"\n`);
        this.push(null);
      },
    });
    pipeRedacted(input, writable, { runtime: { anonKey: sentinel } });
    await new Promise<void>((resolve) => {
      writable.on("finish", () => resolve());
    });
    const out = Buffer.concat(chunks).toString();
    expect(out).not.toContain(sentinel);
    expect(out).toContain("ANON_KEY=[REDACTED]");
  });

  /**
   * Feed `text` through `createRedactTransform` split into two chunks at
   * `split` (every feasible byte position), collecting every emitted chunk.
   */
  const feedSplit = async (text: string, split: number) => {
    const transform = createRedactTransform();
    const emitted: string[] = [];
    transform.on("data", (chunk) => emitted.push(chunk.toString()));
    await new Promise<void>((resolve) => {
      transform.on("end", () => resolve());
      transform.write(text.slice(0, split));
      transform.end(text.slice(split));
    });
    return emitted;
  };

  it("carries the bordered-table continuation state across chunk boundaries", async () => {
    // A secret-bearing row whose wrapped continuation cell arrives in a LATER
    // chunk must still be fully masked (amendment A3). Split the pair at every
    // feasible point: inside the label, inside the value, between the rows,
    // and inside the continuation cell.
    const row = "│ Secret │ s3secretvaluethatmustneverleak\n";
    const continuation = "│        │ more-of-the-same-secret-value │\n";
    const full = row + continuation;
    for (let split = 1; split < full.length; split += 1) {
      const emitted = await feedSplit(full, split);
      const out = emitted.join("");
      expect(out).not.toContain("s3secretvaluethatmustneverleak");
      expect(out).not.toContain("more-of-the-same-secret-value");
      expect(out).toMatch(/│ Secret\s+│ \[REDACTED\]/);
      expect(out).toMatch(/│\s+\[REDACTED\]\s*│/); // continuation cell masked
      for (const chunk of emitted) {
        expect(chunk).not.toContain("s3secretvaluethatmustneverleak");
        expect(chunk).not.toContain("more-of-the-same-secret-value");
      }
    }
  });

  it("carries the compact-unbordered continuation state across chunk boundaries", async () => {
    const row = "Secret       sb_secret_local_key_abcdef123456\n";
    const continuation = "             sb_secret_local_key_wrapped_more_value\n";
    const full = row + continuation;
    for (let split = 1; split < full.length; split += 1) {
      const emitted = await feedSplit(full, split);
      const out = emitted.join("");
      expect(out).not.toContain("sb_secret_local_key");
      expect(out).toMatch(/Secret\s+\[REDACTED\]/);
      expect(out).toMatch(/^\s+\[REDACTED\]/m); // indented continuation masked
      for (const chunk of emitted) {
        expect(chunk).not.toContain("sb_secret_local_key");
      }
    }
  });

  it("does not leak a secret whose value is split mid-token across chunks", async () => {
    // The classic split-token leak: the value fragment itself straddles the
    // chunk boundary. The partial line must be buffered to its newline before
    // any redaction (and any emission), so no fragment ever reaches output.
    const sentinel = "sb_secret_mid_token_abcdefghijklmnop";
    const line = `Secret       ${sentinel}\n`;
    for (let split = 1; split < line.length; split += 1) {
      const emitted = await feedSplit(line, split);
      const out = emitted.join("");
      expect(out).not.toContain(sentinel);
      expect(out).toMatch(/Secret\s+\[REDACTED\]/);
      for (const chunk of emitted) {
        expect(chunk).not.toContain("sb_secret_mid_token");
      }
    }
  });

  it("carries the CRLF continuation state across a \r/\n chunk split (bordered, short fragments)", async () => {
    // The row terminator `\r\n` is split BETWEEN the `\r` and the `\n` across
    // two chunks. The trailing `\r` must be retained until the `\n` resolves
    // it, so the CRLF stays on the row line and the continuation cell in the
    // next line is masked as a continuation. SHORT fragments are used on
    // purpose: `abc123`/`def456` are below every value-shape heuristic, so
    // the only thing that can mask them is the label-driven row redaction +
    // the carried continuation state — a `\r`/`\n` reset would leak them.
    const row = "│ Secret │ abc123\r\n";
    const continuation = "│        │ def456 │\r\n";
    const full = row + continuation;
    for (let split = 1; split < full.length; split += 1) {
      const emitted = await feedSplit(full, split);
      const out = emitted.join("");
      expect(out).not.toContain("abc123");
      expect(out).not.toContain("def456");
      expect(out).toMatch(/│ Secret\s+│ \[REDACTED\]/);
      expect(out).toMatch(/│\s+\[REDACTED\]\s*│/); // continuation cell masked
      for (const chunk of emitted) {
        expect(chunk).not.toContain("abc123");
        expect(chunk).not.toContain("def456");
      }
    }
  });

  it("carries the compact CRLF continuation state across a \r/\n chunk split (short fragments)", async () => {
    const row = "Secret       abc123\r\n";
    const continuation = "             def456\r\n";
    const full = row + continuation;
    for (let split = 1; split < full.length; split += 1) {
      const emitted = await feedSplit(full, split);
      const out = emitted.join("");
      expect(out).not.toContain("abc123");
      expect(out).not.toContain("def456");
      expect(out).toMatch(/Secret\s+\[REDACTED\]/);
      expect(out).toMatch(/^\s+\[REDACTED\]/m); // indented continuation masked
      for (const chunk of emitted) {
        expect(chunk).not.toContain("abc123");
        expect(chunk).not.toContain("def456");
      }
    }
  });

  it("retains a trailing lone \r across chunks until the next character resolves it", async () => {
    // A chunk that ends with a bare `\r` (a possible CRLF half) is not flushed
    // until the next character decides whether it is a CRLF or a standalone
    // CR. A `\r` followed by `\n` must complete the SAME line, never become a
    // separate bare-`\n` line that would reset the continuation state.
    const row = "│ Secret │ abc123\r";
    const rest = "\n│        │ def456 │\n";
    const emitted = await feedSplit(row + rest, row.length);
    const out = emitted.join("");
    expect(out).not.toContain("abc123");
    expect(out).not.toContain("def456");
    expect(out).toMatch(/│ Secret\s+│ \[REDACTED\]/);
    expect(out).toMatch(/│\s+\[REDACTED\]\s*│/);
  });
});

describe("killChildGracefully", () => {
  it("stops a child on SIGTERM within the grace window", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const started = Date.now();
    const code = await killChildGracefully(child, { graceMs: 2_000 });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(2_000);
    expect(child.exitCode).toBeNull(); // terminated by signal, not exit
    expect(child.signalCode).toBe("SIGTERM");
    expect(code).toBeNull();
  });

  it("escalates to SIGKILL when the child ignores SIGTERM", async () => {
    const child = spawn(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000)"],
      { stdio: ["ignore", "ignore", "ignore", "ipc"] }
    );
    // Wait for the child's IPC "ready" message — sent only AFTER the SIGTERM
    // handler is registered in the same synchronous script — so SIGTERM is
    // genuinely ignored and only the SIGKILL escalation can kill it. A stdout
    // readiness line cannot prove the handler is installed: the child's
    // `console.log` write can reach the parent before its synchronous
    // `process.on("SIGTERM", ...)` registration runs, letting a SIGTERM land
    // with default disposition. IPC ordering removes that race.
    await new Promise<void>((resolve) => {
      child.once("message", () => resolve());
    });
    const started = Date.now();
    await killChildGracefully(child, { graceMs: 300 });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(3_000);
    // Wait for the OS to reap the child so signalCode reflects the SIGKILL.
    const deadline = Date.now() + 2_000;
    while (child.signalCode === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(child.signalCode).toBe("SIGKILL");
  });

  it("resolves immediately for an already-exited child", async () => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));
    const code = await killChildGracefully(child, { graceMs: 1_000 });
    expect(code).toBe(0);
  });
});

describe("loopback guards", () => {
  it("accepts only loopback http(s) URLs", () => {
    expect(isLoopbackHttpUrl("http://127.0.0.1:54321")).toBe(true);
    expect(isLoopbackHttpUrl("http://localhost:54321")).toBe(true);
    expect(isLoopbackHttpUrl("https://example-org.supabase.co")).toBe(false);
    expect(isLoopbackHttpUrl("not-a-url")).toBe(false);
  });

  it("accepts only loopback postgres URLs", () => {
    expect(isLoopbackDbUrl("postgresql://postgres:postgres@127.0.0.1:54322/postgres")).toBe(true);
    expect(isLoopbackDbUrl("postgres://postgres:postgres@localhost:54322/postgres")).toBe(true);
    expect(isLoopbackDbUrl("postgresql://db.internal:5432/postgres")).toBe(false);
    expect(isLoopbackDbUrl("http://127.0.0.1:54321")).toBe(false);
  });
});

describe("presenceSummary", () => {
  it("reports presence without leaking values", () => {
    const summary = presenceSummary({
      apiUrl: "http://127.0.0.1:54321",
      dbUrl: undefined,
      anonKey: "eyJanon",
      serviceRoleKey: "eyJservice",
    });
    expect(summary).toBe("api=ok db=missing anon=ok service-role=ok");
    expect(summary).not.toContain("127.0.0.1");
    expect(summary).not.toContain("eyJ");
  });
});

describe("findFreePorts", () => {
  it("reserves distinct free loopback ports", async () => {
    const ports = await findFreePorts(3);
    expect(new Set(ports).size).toBe(3);
    for (const port of ports) {
      expect(Number.isInteger(port)).toBe(true);
      expect(port).toBeGreaterThan(0);
      expect(port).toBeLessThanOrEqual(65_535);
    }
  });

  it("throws a bounded-attempts blocker when no port can be reserved", async () => {
    // Binding a socket on every port is impractical; instead verify that the
    // bounded-attempt guard rejects with a clear blocker for an unusable host.
    await expect(findFreePorts(1, { host: "203.0.113.1", maxAttempts: 2 })).rejects.toThrow(
      /Could not find 1 free port/
    );
  });
});

describe("isPortConflictOutput", () => {
  it("detects real CLI/Docker port-conflict messages", () => {
    expect(isPortConflictOutput("Error: Port 54321 is already in use. Please kill the process.")).toBe(true);
    expect(
      isPortConflictOutput(
        'Error response from daemon: driver failed programming external connectivity on endpoint: bind: address already in use'
      )
    ).toBe(true);
    expect(isPortConflictOutput("listen tcp4 127.0.0.1:54321: bind: address already in use")).toBe(true);
    expect(isPortConflictOutput("port is already allocated")).toBe(true);
  });

  it("does not misclassify unrelated failures as port conflicts", () => {
    expect(isPortConflictOutput("failed to pull image supabase/postgres:latest: not found")).toBe(false);
    expect(isPortConflictOutput("")).toBe(false);
    expect(isPortConflictOutput(null as unknown as string)).toBe(false);
    expect(isPortConflictOutput("Docker daemon is not running")).toBe(false);
  });
});

describe("isTransientRegistryStartFailure", () => {
  it("recognizes real transient registry/image-pull failures", () => {
    expect(
      isTransientRegistryStartFailure(
        'failed to solve: failed to resolve source metadata for docker.io/supabase/postgres:15.8.1.085: failed to do request: Head "https://registry-1.docker.io/v2/supabase/postgres/manifests/15.8.1.085": net/http: TLS handshake timeout'
      )
    ).toBe(true);
    expect(
      isTransientRegistryStartFailure(
        'Error response from daemon: Get "https://registry-1.docker.io/v2/": net/http: TLS handshake timeout'
      )
    ).toBe(true);
    expect(
      isTransientRegistryStartFailure(
        'failed to pull image "supabase/postgres:15.8.1.085": read tcp 10.0.0.1:54321->1.2.3.4:443: read: connection reset by peer'
      )
    ).toBe(true);
    expect(
      isTransientRegistryStartFailure(
        "Error response from daemon: toomanyrequests: You have reached your pull rate limit."
      )
    ).toBe(true);
    expect(
      isTransientRegistryStartFailure(
        "failed to register layer: unexpected EOF"
      )
    ).toBe(true);
  });

  it("requires registry context and transport error on the SAME line", () => {
    expect(
      isTransientRegistryStartFailure(
        'failed to pull image "supabase/postgres:15.8.1.085": connection refused'
      )
    ).toBe(true);
    expect(
      isTransientRegistryStartFailure(
        [
          "Pulling supabase/postgres:15.8.1.085",
          "progress: 45%",
          "database connection refused",
        ].join("\n")
      )
    ).toBe(false);
    expect(
      isTransientRegistryStartFailure(
        [
          "failed to pull image supabase/postgres:latest",
          "listen tcp 127.0.0.1:54322: connect: connection refused",
        ].join("\n")
      )
    ).toBe(false);
  });

  it("rejects deterministic pull failures and non-registry failures", () => {
    expect(
      isTransientRegistryStartFailure("failed to pull image supabase/postgres:latest: not found")
    ).toBe(false);
    expect(
      isTransientRegistryStartFailure(
        "Error response from daemon: pull access denied for supabase/postgres, repository does not exist"
      )
    ).toBe(false);
    expect(
      isTransientRegistryStartFailure(
        "failed to resolve source metadata for docker.io/supabase/postgres: manifest unknown"
      )
    ).toBe(false);
    expect(isTransientRegistryStartFailure("Error: Port 54321 is already in use.")).toBe(false);
    expect(isTransientRegistryStartFailure("Docker daemon is not running")).toBe(false);
    expect(
      isTransientRegistryStartFailure(
        'failed to solve: process "/bin/sh -c apk add curl" did not complete successfully: network is unreachable'
      )
    ).toBe(false);
    expect(isTransientRegistryStartFailure("")).toBe(false);
    expect(isTransientRegistryStartFailure(null as unknown as string)).toBe(false);
  });
});

describe("startFailureDiagnosticExcerpt", () => {
  it("redacts credentials and labelled secret rows before surfacing anything", () => {
    const sentinel = "SENTINEL_CREDENTIAL_9f3a7c42";
    const excerpt = startFailureDiagnosticExcerpt(
      [
        "Error response from daemon: Get \"https://registry-1.docker.io/v2/\": net/http: TLS handshake timeout",
        `SERVICE_ROLE_KEY="${sentinel}"`,
        `Secret  ${sentinel}`,
        "Publishable  sb_publishable_local_key_abcdef123456",
        `DB_URL="postgresql://postgres:${sentinel}@127.0.0.1:54322/postgres"`,
        'Get "https://ci-user:registry-sentinel@registry.example.test/v2/": 503 Service Unavailable',
      ].join("\n")
    );
    expect(excerpt).toContain("TLS handshake timeout");
    expect(excerpt).not.toContain(sentinel);
    expect(excerpt).not.toContain("sb_publishable_local_key_abcdef123456");
    expect(excerpt).not.toContain("registry-sentinel");
    expect(excerpt).toContain("[REDACTED]");
  });

  it("keeps only a bounded tail of lines and marks the truncation", () => {
    const output = Array.from({ length: 50 }, (_, index) => `pull progress line ${index}`).join("\n");
    const excerpt = startFailureDiagnosticExcerpt(output, { maxLines: 5, maxChars: 1_000 });
    expect(excerpt).toContain("[...truncated...]");
    expect(excerpt).toContain("pull progress line 49");
    expect(excerpt).not.toContain("pull progress line 0");
    expect(excerpt.length).toBeLessThanOrEqual(1_000);
    expect(excerpt.trim().split(/\r?\n/)).toHaveLength(6); // marker + 5 lines
  });

  it("bounds a long single line by characters", () => {
    const excerpt = startFailureDiagnosticExcerpt("pull error ".repeat(500), { maxChars: 200 });
    expect(excerpt.length).toBeLessThanOrEqual(200);
    expect(excerpt).toContain("[...truncated...]");
  });

  it("returns an empty string for empty or non-string input", () => {
    expect(startFailureDiagnosticExcerpt("")).toBe("");
    expect(startFailureDiagnosticExcerpt("   \n\t")).toBe("");
    expect(startFailureDiagnosticExcerpt(null as unknown as string)).toBe("");
  });
});

describe("startFailureSummary bounded redacted start surfacing", () => {
  it("surfaces only redacted, bounded evidence and never the captured credentials", () => {
    const sentinel = "SENTINEL_CREDENTIAL_9f3a7c42";
    const output = [
      "Error: docker failed to provision",
      `SERVICE_ROLE_KEY="${sentinel}"`,
      `Secret  ${sentinel}`,
      "Publishable  sb_publishable_local_key_abcdef123456",
    ].join("\n");
    const retryable = startFailureSummary({
      exitCode: 1,
      attempt: 1,
      maxAttempts: 3,
      retryable: true,
      reason: "transient registry/image pull failure",
      output,
    });
    // The summary is fixed text + exit/attempt metadata + a REDACTED excerpt;
    // the captured credential values must never be surfaced.
    expect(retryable).not.toContain(sentinel);
    expect(retryable).not.toContain("sb_publishable_local_key_abcdef123456");
    expect(retryable).toContain("[REDACTED]");
    expect(retryable).toContain("docker failed to provision");
    expect(retryable).toContain("attempt 1/3");
    expect(retryable).toContain("exit code 1");
    expect(retryable).toContain("transient registry/image pull failure");
    expect(retryable).toContain("retrying");

    const final = startFailureSummary({
      exitCode: 1,
      attempt: 3,
      maxAttempts: 3,
      output,
    });
    expect(final).not.toContain(sentinel);
    expect(final).toContain("[REDACTED]");
    expect(final).toContain("attempt 3/3");
    expect(final).toContain("exit code 1");
    expect(final).not.toContain("retrying");
  });

  it("emits a fixed non-retryable summary with exit/attempt metadata only when there is no output", () => {
    const summary = startFailureSummary({
      exitCode: 2,
      attempt: 2,
      maxAttempts: 3,
    });
    expect(summary).toBe("`supabase start` failed on attempt 2/3, exit code 2.");
  });

  it("bounds the surfaced excerpt", () => {
    const summary = startFailureSummary({
      exitCode: 1,
      attempt: 1,
      maxAttempts: 3,
      output: Array.from({ length: 200 }, (_, index) => `diagnostic line ${index}`).join("\n"),
      maxLines: 4,
      maxChars: 180,
    });
    expect(summary).toContain("[...truncated...]");
    expect(summary).not.toContain("diagnostic line 0");
    expect(summary.length).toBeLessThanOrEqual(180 + 200);
  });
});

describe("isPortFree", () => {
  it("reports an occupied port as taken", async () => {
    const { createServer } = await import("node:net");
    const srv = createServer();
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const port = (srv.address() as AddressInfo).port;
    try {
      expect(await isPortFree(port)).toBe(false);
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
    // Once released, the same port probes as free again.
    expect(await isPortFree(port)).toBe(true);
  });
});

describe("spawned-child registry", () => {
  const sleeper = (): ChildProcess =>
    spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });

  it("tracks, untracks, and terminates every registered child", async () => {
    const child = trackChild(sleeper())!;
    expect(activeChildCount()).toBe(1);
    untrackChild(child);
    expect(activeChildCount()).toBe(0);
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
  });

  it("auto-unregisters children once they close", async () => {
    const child = trackChild(sleeper())!;
    expect(activeChildCount()).toBe(1);
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("close", resolve));
    expect(activeChildCount()).toBe(0);
  });

  it("terminates every tracked child on demand (signal-driven teardown)", async () => {
    const children = [trackChild(sleeper())!, trackChild(sleeper())!];
    expect(activeChildCount()).toBe(2);
    await terminateAllChildren({ graceMs: 1_000 });
    expect(activeChildCount()).toBe(0);
    for (const child of children) {
      expect(child.exitCode ?? child.signalCode).not.toBeNull();
    }
  });
});

describe("stopIsolatedSupabase teardown containment", () => {
  /** Write a throwaway fake `supabase` executable used as the stop target. */
  function makeFakeSupabaseBin(
    dir: string,
    { stdout = "", stderr = "", exitCode = 0, argvDump = false } = {}
  ) {
    const script = [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      "const dump = process.env.TEST_ENV_DUMP;",
      "if (dump) fs.writeFileSync(dump, JSON.stringify(process.env));",
      "const argvDumpFile = process.env.TEST_ARGV_DUMP;",
      "if (argvDumpFile) fs.writeFileSync(argvDumpFile, JSON.stringify(process.argv.slice(2)));",
      `process.stdout.write(${JSON.stringify(stdout)});`,
      `process.stderr.write(${JSON.stringify(stderr)});`,
      `process.exit(${exitCode});`,
    ].join("\n");
    const bin = path.join(dir, `fake-supabase-${randomBytes(4).toString("hex")}.cjs`);
    writeFileSync(bin, script, { mode: 0o755 });
    return bin;
  }

  const HOSTILE_KEYS = [
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_ANON_KEY",
    "SUPABASE_ACCESS_TOKEN",
    "ANON_KEY",
    "SERVICE_ROLE_KEY",
    "DB_URL",
    "NEXT_PUBLIC_SUPABASE_URL",
  ];

  it("issues ONLY the workdir-scoped stop: `stop --workdir <wd> --no-backup --yes` (scope via the isolated config)", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ocf-stop-"));
    try {
      const argvDump = path.join(dir, "argv.json");
      const bin = makeFakeSupabaseBin(dir, { argvDump: true });
      const workdir = path.join(dir, "workdir");
      const result = await stopIsolatedSupabase(bin, workdir, {
        env: { ...process.env, PATH: process.env.PATH ?? "", TEST_ARGV_DUMP: argvDump },
      });
      expect(result.status).toBe(0);
      expect(result.confirmed).toBe(true);
      const args = JSON.parse(readFileSync(argvDump, "utf8")) as string[];
      // The stop is scoped to the isolated workdir (whose config.toml carries
      // the lane's unique project id) — the repository project is never a target.
      const workdirAt = args.indexOf("--workdir");
      expect(workdirAt).toBeGreaterThanOrEqual(0);
      expect(args[workdirAt + 1]).toBe(workdir);
      // The normal stop path carries exactly the design flags, once.
      expect(args.filter((arg) => arg === "stop")).toHaveLength(1);
      expect(args).toContain("--no-backup");
      expect(args).toContain("--yes");
      // The CLI's `stop` does not accept --project-id; scope comes from
      // --workdir, and a global all-projects stop is never emitted either.
      expect(args).not.toContain("--project-id");
      expect(args).not.toContain("--all");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never passes hostile inherited credentials into the `supabase stop` child env", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ocf-stop-"));
    try {
      const dumpFile = path.join(dir, "child-env.json");
      const bin = makeFakeSupabaseBin(dir);
      const hostileEnv = {
        ...process.env,
        PATH: process.env.PATH ?? "",
        SUPABASE_SERVICE_ROLE_KEY: "hostile-service-role-key",
        SUPABASE_ANON_KEY: "hostile-anon-key",
        SUPABASE_ACCESS_TOKEN: "sbp_hostile_token",
        ANON_KEY: "hostile-anon-key",
        SERVICE_ROLE_KEY: "hostile-service-role-key",
        DB_URL: "postgresql://hosted:secret@db.internal.example:5432/prod",
        NEXT_PUBLIC_SUPABASE_URL: "https://hostile-project.supabase.co",
        TEST_ENV_DUMP: dumpFile,
      };
      const result = await stopIsolatedSupabase(bin, path.join(dir, "workdir"), {
        env: hostileEnv,
      });
      expect(result.status).toBe(0);
      const childEnv = JSON.parse(readFileSync(dumpFile, "utf8"));
      for (const key of HOSTILE_KEYS) {
        expect(childEnv[key]).toBeUndefined();
      }
      // Non-credential lane env still reaches the child (PATH is needed to run).
      expect(childEnv.PATH).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sanitizes the inherited parent env by default when no env is supplied", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ocf-stop-"));
    try {
      const dumpFile = path.join(dir, "child-env.json");
      const bin = makeFakeSupabaseBin(dir);
      process.env.TEST_ENV_DUMP = dumpFile;
      process.env.SUPABASE_SERVICE_ROLE_KEY = "hostile-inherited-role";
      process.env.ANON_KEY = "hostile-inherited-anon";
      try {
        const result = await stopIsolatedSupabase(bin, path.join(dir, "workdir"));
        expect(result.status).toBe(0);
        const childEnv = JSON.parse(readFileSync(dumpFile, "utf8"));
        expect(childEnv.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
        expect(childEnv.ANON_KEY).toBeUndefined();
        expect(childEnv.TEST_ENV_DUMP).toBe(dumpFile);
      } finally {
        delete process.env.SUPABASE_SERVICE_ROLE_KEY;
        delete process.env.ANON_KEY;
        delete process.env.TEST_ENV_DUMP;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("redacts labelled secrets and credential assignments emitted by `supabase stop`", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ocf-stop-"));
    try {
      const bin = makeFakeSupabaseBin(dir, {
        stdout: [
          "Stopping services...",
          "         anon key: eyJhostileAnon",
          "      service_role key: eyJhostileServiceRole",
          "     JWT secret: hostile-jwt-secret-value",
          'SERVICE_ROLE_KEY="eyJassignmentForm"',
        ].join("\n"),
      });
      const result = await stopIsolatedSupabase(bin, path.join(dir, "workdir"), {
        env: { ...process.env, PATH: process.env.PATH ?? "" },
      });
      expect(result.status).toBe(0);
      expect(result.output).not.toContain("eyJhostileAnon");
      expect(result.output).not.toContain("eyJhostileServiceRole");
      expect(result.output).not.toContain("hostile-jwt-secret-value");
      expect(result.output).not.toContain("eyJassignmentForm");
      expect(result.output).toContain("anon key: [REDACTED]");
      expect(result.output).toContain("service_role key: [REDACTED]");
      expect(result.output).toContain("JWT secret: [REDACTED]");
      expect(result.output).toContain("SERVICE_ROLE_KEY=[REDACTED]");
      // Non-secret noise passes through for diagnostics.
      expect(result.output).toContain("Stopping services...");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a non-zero stop exit (unconfirmed) and redacts its captured stderr", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ocf-stop-"));
    try {
      const bin = makeFakeSupabaseBin(dir, {
        stderr: 'Error: failed to stop stack\nSERVICE_ROLE_KEY="eyJstderrSecret"',
        exitCode: 1,
      });
      const result = await stopIsolatedSupabase(bin, path.join(dir, "workdir"), {
        env: { ...process.env, PATH: process.env.PATH ?? "" },
      });
      expect(result.status).toBe(1);
      expect(result.confirmed).toBe(false);
      expect(result.output).not.toContain("eyJstderrSecret");
      expect(result.output).toContain("SERVICE_ROLE_KEY=[REDACTED]");
      expect(result.output).toContain("Error: failed to stop stack");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runTeardownSubprocess teardown auxiliary containment", () => {
  /** Write a throwaway fake auxiliary probe executable (e.g. `docker info`). */
  function makeFakeProbeBin(dir: string, { stdout = "", stderr = "", exitCode = 0 } = {}) {
    const script = [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      "const dump = process.env.TEST_ENV_DUMP;",
      "if (dump) fs.writeFileSync(dump, JSON.stringify(process.env));",
      `process.stdout.write(${JSON.stringify(stdout)});`,
      `process.stderr.write(${JSON.stringify(stderr)});`,
      `process.exit(${exitCode});`,
    ].join("\n");
    const bin = path.join(dir, `fake-probe-${randomBytes(4).toString("hex")}.cjs`);
    writeFileSync(bin, script, { mode: 0o755 });
    return bin;
  }

  const HOSTILE_KEYS = [
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_ANON_KEY",
    "SUPABASE_ACCESS_TOKEN",
    "ANON_KEY",
    "SERVICE_ROLE_KEY",
    "DB_URL",
    "NEXT_PUBLIC_SUPABASE_URL",
  ];

  it("runs a teardown Docker availability probe with the sanitized env and captured + redacted output", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ocf-probe-"));
    try {
      const dumpFile = path.join(dir, "child-env.json");
      const bin = makeFakeProbeBin(dir, {
        stdout: 'Server Version: 27.0.0\nANON_KEY="eyJprobeSentinel"',
      });
      const hostileEnv = {
        ...process.env,
        PATH: process.env.PATH ?? "",
        SUPABASE_SERVICE_ROLE_KEY: "hostile-service-role-key",
        SUPABASE_ANON_KEY: "hostile-anon-key",
        SUPABASE_ACCESS_TOKEN: "sbp_hostile_token",
        ANON_KEY: "hostile-anon-key",
        SERVICE_ROLE_KEY: "hostile-service-role-key",
        DB_URL: "postgresql://hosted:secret@db.internal.example:5432/prod",
        NEXT_PUBLIC_SUPABASE_URL: "https://hostile-project.supabase.co",
        TEST_ENV_DUMP: dumpFile,
      };
      const result = runTeardownSubprocess(bin, ["info"], { env: hostileEnv });
      expect(result.status).toBe(0);
      // The probe child never inherited the hostile credential env.
      const childEnv = JSON.parse(readFileSync(dumpFile, "utf8"));
      for (const key of HOSTILE_KEYS) {
        expect(childEnv[key]).toBeUndefined();
      }
      expect(childEnv.PATH).toBeDefined();
      // Output is captured (not inherited raw) and already redacted.
      expect(result.output).toContain("Server Version: 27.0.0");
      expect(result.output).not.toContain("eyJprobeSentinel");
      expect(result.output).toContain("ANON_KEY=[REDACTED]");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sanitizes the inherited parent env by default when no env is supplied", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ocf-probe-"));
    try {
      const dumpFile = path.join(dir, "child-env.json");
      const bin = makeFakeProbeBin(dir);
      process.env.TEST_ENV_DUMP = dumpFile;
      process.env.SUPABASE_SERVICE_ROLE_KEY = "hostile-inherited-role";
      process.env.ANON_KEY = "hostile-inherited-anon";
      try {
        const result = runTeardownSubprocess(bin, ["info"]);
        expect(result.status).toBe(0);
        const childEnv = JSON.parse(readFileSync(dumpFile, "utf8"));
        expect(childEnv.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
        expect(childEnv.ANON_KEY).toBeUndefined();
        expect(childEnv.TEST_ENV_DUMP).toBe(dumpFile);
      } finally {
        delete process.env.SUPABASE_SERVICE_ROLE_KEY;
        delete process.env.ANON_KEY;
        delete process.env.TEST_ENV_DUMP;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a non-zero probe exit and a failed spawn without throwing or emitting raw output", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ocf-probe-"));
    try {
      const failing = makeFakeProbeBin(dir, {
        stderr:
          'Error response from daemon: Cannot connect to the Docker daemon\nSERVICE_ROLE_KEY="eyJstderrSentinel"',
        exitCode: 1,
      });
      const failed = runTeardownSubprocess(failing, ["info"], {
        env: { ...process.env, PATH: process.env.PATH ?? "" },
      });
      expect(failed.status).toBe(1);
      expect(failed.output).toContain("Cannot connect to the Docker daemon");
      expect(failed.output).not.toContain("eyJstderrSentinel");
      expect(failed.output).toContain("SERVICE_ROLE_KEY=[REDACTED]");

      // A missing binary is a spawn failure (status null + error), not a throw.
      const missing = runTeardownSubprocess(path.join(dir, "does-not-exist"), ["info"], {
        env: { PATH: process.env.PATH ?? "" },
      });
      expect(missing.status).toBeNull();
      expect(missing.error).not.toBeNull();
      expect(missing.output).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runProbe preflight containment (amendment A3)", () => {
  /** Write a throwaway fake preflight executable that dumps its env. */
  function makeFakeProbeBin(dir: string, { exitCode = 0 } = {}) {
    const script = [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      "const dump = process.env.TEST_ENV_DUMP;",
      "if (dump) fs.writeFileSync(dump, JSON.stringify(process.env));",
      `process.exit(${exitCode});`,
    ].join("\n");
    const bin = path.join(dir, `fake-preflight-${randomBytes(4).toString("hex")}.cjs`);
    writeFileSync(bin, script, { mode: 0o755 });
    return bin;
  }

  const HOSTILE_KEYS = [
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_ANON_KEY",
    "SUPABASE_ACCESS_TOKEN",
    "ANON_KEY",
    "SERVICE_ROLE_KEY",
    "DB_URL",
    "NEXT_PUBLIC_SUPABASE_URL",
    "PGPASSWORD",
    "MY_API_TOKEN",
  ];

  it("never passes hostile inherited credentials into a preflight probe child", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ocf-preflight-"));
    try {
      const dumpFile = path.join(dir, "child-env.json");
      const bin = makeFakeProbeBin(dir);
      const hostileEnv = {
        ...process.env,
        PATH: process.env.PATH ?? "",
        SUPABASE_SERVICE_ROLE_KEY: "hostile-service-role-key",
        SUPABASE_ANON_KEY: "hostile-anon-key",
        SUPABASE_ACCESS_TOKEN: "sbp_hostile_token",
        ANON_KEY: "hostile-anon-key",
        SERVICE_ROLE_KEY: "hostile-service-role-key",
        DB_URL: "postgresql://hosted:secret@db.internal.example:5432/prod",
        NEXT_PUBLIC_SUPABASE_URL: "https://hostile-project.supabase.co",
        PGPASSWORD: "hostile-pg-password",
        MY_API_TOKEN: "hostile-api-token",
        TEST_ENV_DUMP: dumpFile,
      };
      const result = runProbe(bin, ["--version"], { env: hostileEnv });
      expect(result.ok).toBe(true);
      const childEnv = JSON.parse(readFileSync(dumpFile, "utf8"));
      for (const key of HOSTILE_KEYS) {
        expect(childEnv[key]).toBeUndefined();
      }
      // Non-credential probe env still reaches the child (PATH is needed).
      expect(childEnv.PATH).toBeDefined();
      expect(childEnv.TEST_ENV_DUMP).toBe(dumpFile);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sanitizes the inherited parent env by default when no env is supplied", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ocf-preflight-"));
    try {
      const dumpFile = path.join(dir, "child-env.json");
      const bin = makeFakeProbeBin(dir);
      process.env.TEST_ENV_DUMP = dumpFile;
      process.env.SUPABASE_SERVICE_ROLE_KEY = "hostile-inherited-role";
      process.env.NEXT_PUBLIC_SUPABASE_URL = "https://hostile-project.supabase.co";
      try {
        const result = runProbe(bin, ["--version"]);
        expect(result.ok).toBe(true);
        const childEnv = JSON.parse(readFileSync(dumpFile, "utf8"));
        expect(childEnv.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
        expect(childEnv.NEXT_PUBLIC_SUPABASE_URL).toBeUndefined();
        expect(childEnv.TEST_ENV_DUMP).toBe(dumpFile);
      } finally {
        delete process.env.SUPABASE_SERVICE_ROLE_KEY;
        delete process.env.NEXT_PUBLIC_SUPABASE_URL;
        delete process.env.TEST_ENV_DUMP;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a hostile inherited env never reaching probe output either", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ocf-preflight-"));
    try {
      const sentinel = "SENTINEL_PROBE_9f3a7c42";
      const bin = makeFakeProbeBin(dir);
      const hostileEnv = {
        ...process.env,
        PATH: process.env.PATH ?? "",
        SERVICE_ROLE_KEY: sentinel,
      };
      const result = runProbe(bin, [], { env: hostileEnv, captureOutput: true });
      expect(result.ok).toBe(true);
      // The probe printed nothing, and the hostile value is not echoed back.
      expect(result.stdout).not.toContain(sentinel);
      expect(result.stderr).not.toContain(sentinel);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bounds a hung probe with a bounded timeout (a blocker, never a hang)", () => {
    const started = Date.now();
    const result = runProbe(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 400 });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(10_000);
    expect(result.ok).toBe(false);
    expect(result.status).toBeNull();
    expect(result.error?.code).toBe("ETIMEDOUT");
  });

  it("hard-SIGKILLs a probe that deliberately ignores SIGTERM (deadline escalation)", () => {
    // A retained SYNCHRONOUS probe must never hang the lane even when the
    // child traps/ignores SIGTERM: the bounded timeout enforces a HARD SIGKILL
    // at the deadline, so the probe reports a blocker and returns.
    const started = Date.now();
    const result = runProbe(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
      { timeoutMs: 400 }
    );
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(10_000);
    expect(result.ok).toBe(false);
    expect(result.status).toBeNull();
    expect(result.signal).toBe("SIGKILL"); // SIGTERM was ignored; SIGKILL landed
    expect(result.error?.code).toBe("ETIMEDOUT");
  });
});

describe("SIGTERM signal-driven teardown (amendment A3)", () => {
  const waitFor = async (predicate: () => boolean, timeoutMs = 5_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return false;
  };

  it("terminates every registered child on SIGTERM and completes teardown without orphans", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ocf-sigterm-"));
    try {
      const moduleUrl = new URL(
        "../../../../scripts/test-support/supabase-isolation.mjs",
        import.meta.url
      ).href;
      const teardownMarker = path.join(dir, "teardown-done");
      const orphanMarker = path.join(dir, "orphan-exited");
      // The wrapper process mirrors a lane's SIGTERM handler: it registers a
      // sleeper child, then on SIGTERM terminates every registered child and
      // runs teardown before exiting.
      const script = `
        import(${JSON.stringify(moduleUrl)}).then(async ({ trackChild, terminateAllChildren }) => {
          const { spawn } = require("node:child_process");
          const fs = require("node:fs");
          const orphan = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
          orphan.on("close", () => fs.writeFileSync(${JSON.stringify(orphanMarker)}, "exited"));
          trackChild(orphan);
          process.on("SIGTERM", () => {
            terminateAllChildren({ graceMs: 2_000 }).then(() => {
              fs.writeFileSync(${JSON.stringify(teardownMarker)}, "done");
              process.exit(130);
            });
          });
          process.kill(process.pid, "SIGTERM");
        });
      `;
      const wrapper = spawn(process.execPath, ["-e", script], { stdio: "ignore" });
      const code = await new Promise<number | null>((resolve) => wrapper.on("close", resolve));
      expect(code).toBe(130);
      // Teardown completed after terminating the registered child.
      expect(await waitFor(() => existsSync(teardownMarker))).toBe(true);
      // The tracked sleeper was terminated by the SIGTERM handling — no orphan.
      expect(await waitFor(() => existsSync(orphanMarker))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runTrackedSubprocess material-subprocess lifecycle (amendment A3)", () => {
  const HOSTILE_KEYS = [
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_ANON_KEY",
    "SUPABASE_ACCESS_TOKEN",
    "ANON_KEY",
    "SERVICE_ROLE_KEY",
    "DB_URL",
    "NEXT_PUBLIC_SUPABASE_URL",
  ];

  it("captures a normal exit with output and auto-unregisters the child", async () => {
    const result = await runTrackedSubprocess(process.execPath, [
      "-e",
      "process.stdout.write('runtime captured\\nSERVICE_ROLE_KEY=\\\"eyJstopSentinel\\\"'); process.exit(0)",
    ]);
    expect(result.status).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toContain("runtime captured");
    expect(result.stderr).toBe("");
    // The child auto-unregisters on close — no registry leak for the next run.
    expect(activeChildCount()).toBe(0);
  });

  it("hits the hard deadline and SIGKILLs a teardown child that ignores SIGTERM (no orphan)", async () => {
    const started = Date.now();
    const result = await runTrackedSubprocess(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
      { timeoutMs: 400, killGraceMs: 200 }
    );
    const elapsed = Date.now() - started;
    // Hard bound: deadline (400ms) + SIGTERM grace (200ms) + reap margin.
    expect(elapsed).toBeLessThan(5_000);
    expect(result.timedOut).toBe(true);
    expect(result.status).toBeNull();
    expect(result.signal).toBe("SIGKILL"); // SIGTERM ignored; escalation landed
    // No orphan: the child is gone and no longer registered.
    expect(activeChildCount()).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(activeChildCount()).toBe(0);
  });

  it("never passes hostile inherited credentials into a material status/stop child", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ocf-tracked-"));
    try {
      const dumpFile = path.join(dir, "child-env.json");
      const bin = path.join(dir, "fake-status.cjs");
      writeFileSync(
        bin,
        [
          "#!/usr/bin/env node",
          'const fs = require("node:fs");',
          "const dump = process.env.TEST_ENV_DUMP;",
          "if (dump) fs.writeFileSync(dump, JSON.stringify(process.env));",
          "process.exit(0);",
        ].join("\n"),
        { mode: 0o755 }
      );
      const hostileEnv = {
        ...process.env,
        PATH: process.env.PATH ?? "",
        SUPABASE_SERVICE_ROLE_KEY: "hostile-service-role-key",
        SUPABASE_ANON_KEY: "hostile-anon-key",
        SUPABASE_ACCESS_TOKEN: "sbp_hostile_token",
        ANON_KEY: "hostile-anon-key",
        SERVICE_ROLE_KEY: "hostile-service-role-key",
        DB_URL: "postgresql://hosted:secret@db.internal.example:5432/prod",
        NEXT_PUBLIC_SUPABASE_URL: "https://hostile-project.supabase.co",
        TEST_ENV_DUMP: dumpFile,
      };
      const result = await runTrackedSubprocess(bin, ["status", "-o", "env"], { env: hostileEnv });
      expect(result.status).toBe(0);
      const childEnv = JSON.parse(readFileSync(dumpFile, "utf8"));
      for (const key of HOSTILE_KEYS) {
        expect(childEnv[key]).toBeUndefined();
      }
      expect(childEnv.PATH).toBeDefined();
      expect(childEnv.TEST_ENV_DUMP).toBe(dumpFile);
      expect(activeChildCount()).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("completeRetryableTeardown retry-path sequencing (amendment A3)", () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it("completes stop + workdir removal before the next attempt can begin", async () => {
    const events: string[] = [];
    const lane = { workdir: "/tmp/lane-1", cleanup: () => events.push("remove") };
    // Runner retryable path: capture the lane snapshot, await the FULL async
    // teardown (stop + workdir removal), and only then proceed to attempt 2.
    await completeRetryableTeardown({
      lane,
      stop: async () => {
        await sleep(25);
        events.push("stop");
      },
      removeWorkdir: (l) => l.cleanup(),
    });
    events.push("attempt-2");
    expect(events).toEqual(["stop", "remove", "attempt-2"]);
  });

  it("E2E Docker-probe path: the tracked docker probe completes before stop/removal and before the next attempt", async () => {
    const events: string[] = [];
    const lane = { workdir: "/tmp/lane-e2e", cleanup: () => events.push("remove") };
    await completeRetryableTeardown({
      lane,
      stop: async () => {
        // Analogue of the E2E teardown Docker availability probe: a TRACKED
        // async subprocess that must fully finish (and be unregistered) before
        // the stack is stopped.
        const probe = await runTrackedSubprocess(process.execPath, ["-e", "process.exit(0)"], {
          timeoutMs: 5_000,
        });
        expect(probe.status).toBe(0);
        events.push("docker-probe");
        events.push("stop");
      },
      removeWorkdir: (l) => l.cleanup(),
    });
    events.push("attempt-2");
    expect(events).toEqual(["docker-probe", "stop", "remove", "attempt-2"]);
    expect(activeChildCount()).toBe(0); // no orphan from the probe child
  });

  it("clears lane state only after the full async teardown resolves", async () => {
    // The runner nulls/clears its lane state AFTER `completeRetryableTeardown`
    // resolves, so the next attempt can never observe a half-stopped stack.
    const events: string[] = [];
    let lane = { id: 1, cleanup: () => events.push("remove-1") };
    await completeRetryableTeardown({
      lane,
      stop: async () => {
        await sleep(20);
        events.push("stop-1");
      },
      removeWorkdir: (l) => l.cleanup(),
    });
    lane = null as unknown as typeof lane; // runner clears its lane state only now
    events.push("attempt-2");
    expect(events).toEqual(["stop-1", "remove-1", "attempt-2"]);
  });

  it("a stale async teardown cannot clobber the lane installed by the next attempt", async () => {
    // Simulates the nulled-global hazard: a lingering teardown from attempt 1
    // must operate ONLY on its own stable snapshot, never on the global a
    // later attempt reassigns.
    const events: string[] = [];
    let lane = { id: 1, cleanup: () => events.push("remove-1") };
    const staleTeardown = completeRetryableTeardown({
      lane, // stable snapshot captured at call time
      stop: async () => {
        await sleep(30);
        events.push("stop-1");
      },
      removeWorkdir: (l) => l.cleanup(),
    });
    lane = { id: 2, cleanup: () => events.push("remove-2") }; // next attempt installs a fresh lane
    await staleTeardown;
    events.push("attempt-2-begins");
    lane.cleanup(); // the fresh lane is still valid — untouched by the stale teardown
    expect(events).toEqual(["stop-1", "remove-1", "attempt-2-begins", "remove-2"]);
  });

  it("a failing stop still removes the workdir and resolves (never blocks the retry)", async () => {
    const events: string[] = [];
    const errors: string[] = [];
    const lane = { cleanup: () => events.push("remove") };
    await completeRetryableTeardown({
      lane,
      stop: async () => {
        events.push("stop-attempt");
        throw new Error("stop exploded");
      },
      removeWorkdir: (l) => l.cleanup(),
      onError: (caught) => {
        errors.push((caught as Error).message);
        events.push("stop-error");
      },
    });
    events.push("attempt-2");
    expect(events).toEqual(["stop-attempt", "stop-error", "remove", "attempt-2"]);
    expect(errors).toEqual(["stop exploded"]);
  });

  it("is a no-op for a nulled/absent lane", async () => {
    const events: string[] = [];
    await completeRetryableTeardown({
      lane: null,
      stop: async () => {
        events.push("stop");
      },
      removeWorkdir: () => {
        events.push("remove");
      },
    });
    events.push("attempt-2");
    expect(events).toEqual(["attempt-2"]);
  });
});

describe("confirmTeardownBeforeRetry fail-closed retry gate", () => {
  it("permits a retry ONLY for explicit confirmed=true", async () => {
    const confirmed = await confirmTeardownBeforeRetry(async () => ({
      confirmed: true,
      projectId: "ocf-contract-abcd1234",
    }));
    expect(confirmed).toMatchObject({ retryable: true, confirmed: true });
    expect(confirmed.result).toMatchObject({ projectId: "ocf-contract-abcd1234" });

    for (const result of [
      undefined,
      null,
      false,
      true,
      {},
      { confirmed: false },
      { confirmed: "true" },
    ]) {
      const gate = await confirmTeardownBeforeRetry(async () => result);
      expect(gate.retryable).toBe(false);
      expect(gate.confirmed).toBe(false);
    }
  });

  it("fails closed when the teardown throws", async () => {
    const gate = await confirmTeardownBeforeRetry(async () => {
      throw new Error("scoped stop exploded");
    });
    expect(gate.retryable).toBe(false);
    expect(gate.confirmed).toBe(false);
    expect(gate.error).toBeInstanceOf(Error);
  });
});

describe("assertSafeProjectId dangerous-identifier guard (R13/NFR3)", () => {
  it("accepts lane-generated unique project ids", () => {
    expect(assertSafeProjectId("ocf-contract-abcd1234")).toBe("ocf-contract-abcd1234");
    expect(assertSafeProjectId("ocf-e2e-00112233")).toBe("ocf-e2e-00112233");
    expect(isSafeProjectId("ocf-schema-inventory-beef0001")).toBe(true);
  });

  it("rejects empty/whitespace ids before any command can be built", () => {
    expect(() => assertSafeProjectId("")).toThrow(/empty/i);
    expect(() => assertSafeProjectId("   ")).toThrow(/empty/i);
    expect(() => assertSafeProjectId(null as unknown as string)).toThrow(/empty/i);
    expect(isSafeProjectId(undefined as unknown as string)).toBe(false);
  });

  it("rejects repository and CLI-default project ids", () => {
    expect(() => assertSafeProjectId(REPOSITORY_PROJECT_ID)).toThrow(/repository/i);
    expect(() => assertSafeProjectId("supabase")).toThrow(/default/i);
    expect(isSafeProjectId(REPOSITORY_PROJECT_ID)).toBe(false);
  });

  it("rejects ids carrying unsafe characters", () => {
    expect(() => assertSafeProjectId("ocf-contract; echo pwned")).toThrow(/unsafe/i);
    expect(() => assertSafeProjectId("ocf contract 123")).toThrow(/unsafe/i);
  });

  it("honors an explicit repositoryProjectId override (rugged against repo rename)", () => {
    expect(() =>
      assertSafeProjectId("ocf-contract-abcd1234", { repositoryProjectId: "ocf-contract-abcd1234" })
    ).toThrow(/repository/i);
  });
});

describe("scoped Docker argument builders (label-only, no global commands)", () => {
  const ID = "ocf-contract-abcd1234";

  it("builds only label-scoped list commands for each resource kind", () => {
    expect(dockerScopedListArgs("container", ID)).toEqual([
      "ps",
      "-aq",
      "--filter",
      `label=${SUPABASE_PROJECT_LABEL}=${ID}`,
    ]);
    expect(dockerScopedListArgs("network", ID)).toEqual([
      "network",
      "ls",
      "-q",
      "--filter",
      `label=${SUPABASE_PROJECT_LABEL}=${ID}`,
    ]);
    expect(dockerScopedListArgs("volume", ID)).toEqual([
      "volume",
      "ls",
      "-q",
      "--filter",
      `label=${SUPABASE_PROJECT_LABEL}=${ID}`,
    ]);
  });

  it("never emits a global/unfiltered list command", () => {
    for (const kind of ["container", "network", "volume"] as const) {
      const args = dockerScopedListArgs(kind, ID);
      expect(args).not.toContain("--all");
      expect(args).not.toContain("prune");
      expect(args.join(" ")).toContain(`label=${SUPABASE_PROJECT_LABEL}=${ID}`);
    }
  });

  it("builds scoped remove commands for the exact returned ids only", () => {
    expect(dockerScopedRemoveArgs("container", ["abc", "def"])).toEqual(["rm", "-f", "abc", "def"]);
    expect(dockerScopedRemoveArgs("network", ["net1"])).toEqual(["network", "rm", "net1"]);
    expect(dockerScopedRemoveArgs("volume", ["vol1"])).toEqual(["volume", "rm", "vol1"]);
  });

  it("refuses an unfiltered remove (empty id list)", () => {
    expect(() => dockerScopedRemoveArgs("container", [])).toThrow(/unfiltered/i);
    expect(() => dockerScopedRemoveArgs("network", [])).toThrow(/unfiltered/i);
    expect(() => dockerScopedRemoveArgs("volume", [])).toThrow(/unfiltered/i);
  });

  it("throws for an unknown resource kind", () => {
    expect(() => dockerScopedListArgs("image" as never, ID)).toThrow(/kind/i);
    expect(() => dockerScopedRemoveArgs("image" as never, ["x"])).toThrow(/kind/i);
  });

  it("parses `docker ls -q` output into trimmed non-empty ids", () => {
    expect(parseDockerIds("abc123\r\ndef456\r\n\n   \n")).toEqual(["abc123", "def456"]);
    expect(parseDockerIds(null)).toEqual([]);
    expect(parseDockerIds("")).toEqual([]);
  });
});

describe("reapScopedDockerResources label-scoped reaper", () => {
  const ID = "ocf-e2e-00112233";
  const LABEL = `label=${SUPABASE_PROJECT_LABEL}=${ID}`;

  it("lists only label-scoped resources and removes ONLY the returned ids, in list→remove order", async () => {
    const calls: Array<[string, string[]]> = [];
    const run = async (_cmd: string, args: string[]) => {
      calls.push(["docker", args]);
      const joined = args.join(" ");
      if (joined.startsWith("ps ")) return { status: 0, stdout: "abc123\ndef456\n" };
      if (joined.startsWith("network ls")) return { status: 0, stdout: "net1\n" };
      if (joined.startsWith("volume ls")) return { status: 0, stdout: "vol1\n" };
      return { status: 0, stdout: "" };
    };

    const result = await reapScopedDockerResources({ projectId: ID, run });
    expect(result.confirmed).toBe(true);
    expect(result.removed).toEqual({ containers: 2, networks: 1, volumes: 1 });
    expect(result.errors).toEqual([]);

    expect(calls).toEqual([
      ["docker", ["ps", "-aq", "--filter", LABEL]],
      ["docker", ["rm", "-f", "abc123", "def456"]],
      ["docker", ["network", "ls", "-q", "--filter", LABEL]],
      ["docker", ["network", "rm", "net1"]],
      ["docker", ["volume", "ls", "-q", "--filter", LABEL]],
      ["docker", ["volume", "rm", "vol1"]],
    ]);
  });

  it("confirms immediately (and removes nothing) when no scoped resources exist", async () => {
    const calls: string[][] = [];
    const run = async (_cmd: string, args: string[]) => {
      calls.push(args);
      return { status: 0, stdout: "" };
    };
    const result = await reapScopedDockerResources({ projectId: ID, run });
    expect(result.confirmed).toBe(true);
    expect(result.removed).toEqual({ containers: 0, networks: 0, volumes: 0 });
    // Only the three scoped LIST commands ran; no remove was ever issued.
    expect(calls).toEqual([
      ["ps", "-aq", "--filter", LABEL],
      ["network", "ls", "-q", "--filter", LABEL],
      ["volume", "ls", "-q", "--filter", LABEL],
    ]);
  });

  it("is NOT confirmed when a scoped list fails, and removes nothing", async () => {
    const calls: string[][] = [];
    const run = async (_cmd: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "ps") return { status: 1, stdout: "daemon unavailable" };
      return { status: 0, stdout: "" };
    };
    const result = await reapScopedDockerResources({ projectId: ID, run });
    expect(result.confirmed).toBe(false);
    expect(result.removed).toEqual({ containers: 0, networks: 0, volumes: 0 });
    expect(result.errors.length).toBeGreaterThan(0);
    expect(calls.some((args) => args[0] === "rm")).toBe(false);
  });

  it("is NOT confirmed when a scoped remove fails", async () => {
    const run = async (_cmd: string, args: string[]) => {
      if (args[0] === "ps") return { status: 0, stdout: "abc123\n" };
      if (args[0] === "rm") return { status: 1, stdout: "" };
      return { status: 0, stdout: "" };
    };
    const result = await reapScopedDockerResources({ projectId: ID, run });
    expect(result.confirmed).toBe(false);
    expect(result.removed.containers).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rejects empty/repository project ids (never a global reap)", async () => {
    await expect(
      reapScopedDockerResources({ projectId: "", run: async () => ({ status: 0, stdout: "" }) })
    ).rejects.toThrow(/empty/i);
    await expect(
      reapScopedDockerResources({
        projectId: REPOSITORY_PROJECT_ID,
        run: async () => ({ status: 0, stdout: "" }),
      })
    ).rejects.toThrow(/repository/i);
  });

  it("never issues a global cleanup command across the whole lifecycle", async () => {
    const calls: Array<[string, string[]]> = [];
    const run = async (_cmd: string, args: string[]) => {
      calls.push(["docker", args]);
      if (args[0] === "ps") return { status: 0, stdout: "abc123\n" };
      if (args[0] === "network" && args[1] === "ls") return { status: 0, stdout: "net1\n" };
      if (args[0] === "volume" && args[1] === "ls") return { status: 0, stdout: "vol1\n" };
      return { status: 0, stdout: "" };
    };
    await reapScopedDockerResources({ projectId: ID, run });
    for (const [, args] of calls) {
      // No global token can ever be passed to Docker.
      expect(args).not.toContain("--all");
      expect(args.join(" ")).not.toMatch(/prune/i);
      // Every LIST is label-scoped; every REMOVE carries an explicit id list.
      if (args[0] === "ps" || (args[0] === "network" && args[1] === "ls") || (args[0] === "volume" && args[1] === "ls")) {
        expect(args).toContain("--filter");
        expect(args.join(" ")).toContain(LABEL);
      } else {
        expect(args.filter((a) => a.startsWith("--"))).toEqual([]);
        expect(args.filter((a) => a !== "rm" && a !== "-f" && a !== "network" && a !== "volume").length).toBeGreaterThan(0);
      }
    }
  });
});

describe("createScopedLaneTeardown memoized scoped teardown (R13)", () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  function makeLane(projectId: string, workdir: string) {
    return { projectId, workdir, cleanup: () => {} };
  }

  it("runs the normal stop first and removes the workdir only when confirmed", async () => {
    const events: string[] = [];
    const teardownLane = createScopedLaneTeardown({
      stop: async () => {
        events.push("stop");
        return { confirmed: true };
      },
      reap: async () => {
        events.push("reap");
        return { confirmed: true };
      },
      removeWorkdir: () => events.push("remove"),
    });
    const result = await teardownLane(makeLane("ocf-contract-abcd1234", "/tmp/lane"));
    expect(events).toEqual(["stop", "remove"]);
    expect(result.confirmed).toBe(true);
  });

  it("falls back to the label-scoped reaper ONLY when the normal stop cannot be confirmed", async () => {
    const events: string[] = [];
    const teardownLane = createScopedLaneTeardown({
      stop: async () => {
        events.push("stop");
        return { confirmed: false };
      },
      reap: async () => {
        events.push("reap");
        return { confirmed: true };
      },
      removeWorkdir: () => events.push("remove"),
    });
    const result = await teardownLane(makeLane("ocf-contract-abcd1234", "/tmp/lane"));
    expect(events).toEqual(["stop", "reap", "remove"]);
    expect(result.confirmed).toBe(true);
  });

  it("never runs the reaper when the normal stop is confirmed", async () => {
    const events: string[] = [];
    const teardownLane = createScopedLaneTeardown({
      stop: async () => {
        events.push("stop");
        return { confirmed: true };
      },
      reap: async () => {
        events.push("reap");
      },
      removeWorkdir: () => events.push("remove"),
    });
    await teardownLane(makeLane("ocf-contract-abcd1234", "/tmp/lane"));
    expect(events).toEqual(["stop", "remove"]);
  });

  it("retains the workdir and returns recovery metadata when cleanup cannot be confirmed", async () => {
    const events: string[] = [];
    const warnings: string[] = [];
    const lane = makeLane("ocf-contract-abcd1234", "/tmp/lane-retained");
    const teardownLane = createScopedLaneTeardown({
      stop: async () => ({ confirmed: false }),
      reap: async () => ({ confirmed: false }),
      removeWorkdir: () => events.push("remove"),
      warn: (message: unknown) => warnings.push(String(message)),
    });
    const result = await teardownLane(lane);
    // Workdir was NEVER removed.
    expect(events).toEqual([]);
    expect(result.confirmed).toBe(false);
    expect(result.projectId).toBe("ocf-contract-abcd1234");
    expect(result.workdir).toBe("/tmp/lane-retained");
    // The workdir-scoped recovery command is surfaced for deterministic
    // recovery (scope comes from --workdir, never a --project-id flag).
    expect(result.command).toContain("supabase stop --no-backup --yes --workdir /tmp/lane-retained");
    expect(result.command).not.toContain("--project-id");
    expect(result.command).toContain(SUPABASE_PROJECT_LABEL);
    expect(warnings.join("\n")).toContain("retaining workdir /tmp/lane-retained");
    expect(warnings.join("\n")).toContain("Recovery: supabase stop --no-backup --yes --workdir /tmp/lane-retained");
  });

  it("is memoized and idempotent for the same lane (signal handler + finally)", async () => {
    const events: string[] = [];
    const lane = makeLane("ocf-contract-abcd1234", "/tmp/lane");
    const teardownLane = createScopedLaneTeardown({
      stop: async () => {
        await sleep(20);
        events.push("stop");
        return { confirmed: true };
      },
      removeWorkdir: () => events.push("remove"),
    });
    const [first, second] = await Promise.all([teardownLane(lane), teardownLane(lane)]);
    expect(events.filter((event) => event === "stop")).toHaveLength(1);
    expect(events.filter((event) => event === "remove")).toHaveLength(1);
    expect(first.confirmed).toBe(true);
    expect(second.confirmed).toBe(true);
  });

  it("gives a fresh lane (retry attempt) its own teardown", async () => {
    const stops: string[] = [];
    const teardownLane = createScopedLaneTeardown({
      stop: async (lane) => {
        stops.push(lane.projectId);
        return { confirmed: true };
      },
    });
    const first = await teardownLane(makeLane("ocf-contract-11111111", "/tmp/lane-1"));
    const second = await teardownLane(makeLane("ocf-contract-22222222", "/tmp/lane-2"));
    expect(stops).toEqual(["ocf-contract-11111111", "ocf-contract-22222222"]);
    expect(first.projectId).toBe("ocf-contract-11111111");
    expect(second.projectId).toBe("ocf-contract-22222222");
  });

  it("a throwing stop routes to the reaper; a throwing reaper is non-fatal and retains the workdir", async () => {
    const events: string[] = [];
    const teardownLane = createScopedLaneTeardown({
      stop: async () => {
        events.push("stop");
        throw new Error("stop exploded");
      },
      reap: async () => {
        events.push("reap");
        throw new Error("reap exploded");
      },
      removeWorkdir: () => events.push("remove"),
    });
    const result = await teardownLane(makeLane("ocf-contract-abcd1234", "/tmp/lane"));
    expect(events).toEqual(["stop", "reap"]);
    expect(result.confirmed).toBe(false);
    expect(result.workdir).toBe("/tmp/lane");
  });

  it("is a no-op for a nulled/absent lane", async () => {
    const events: string[] = [];
    const teardownLane = createScopedLaneTeardown({
      stop: async () => events.push("stop"),
    });
    const result = await teardownLane(null);
    expect(result.confirmed).toBe(true);
    expect(result.skipped).toBe(true);
    expect(events).toEqual([]);
  });
});

describe("installSignalTeardown one-time awaited signal teardown", () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it("awaits terminate + teardown on SIGINT/SIGHUP and handles every signal exactly once", async () => {
    const events: string[] = [];
    const originalExit = process.exit;
    process.exit = ((code?: number) => {
      events.push(`exit:${code}`);
    }) as typeof process.exit;
    const dispose = installSignalTeardown({
      terminate: async () => {
        await sleep(5);
        events.push("terminate");
      },
      teardown: async () => {
        await sleep(15);
        events.push("teardown");
      },
      error: () => {},
    });
    try {
      process.emit("SIGINT");
      await sleep(10);
      // SIGHUP and SIGTERM arrive while teardown is still in flight: must be ignored.
      process.emit("SIGHUP");
      process.emit("SIGTERM");
      await sleep(60);
      expect(events).toEqual(["terminate", "teardown", "exit:130"]);
    } finally {
      dispose();
      process.exit = originalExit;
    }
  });

  it("supports a custom signal set and exit code, ignoring others", async () => {
    const events: string[] = [];
    const originalExit = process.exit;
    process.exit = ((code?: number) => {
      events.push(`exit:${code}`);
    }) as typeof process.exit;
    const dispose = installSignalTeardown({
      signals: ["SIGUSR2"],
      exitCode: 42,
      terminate: async () => events.push("terminate"),
      teardown: async () => events.push("teardown"),
      error: () => {},
    });
    try {
      process.emit("SIGINT");
      await sleep(10);
      expect(events).toEqual([]);
      process.emit("SIGUSR2");
      await sleep(30);
      expect(events).toEqual(["terminate", "teardown", "exit:42"]);
    } finally {
      dispose();
      process.exit = originalExit;
    }
  });

  it("the disposer removes the handlers so no teardown runs afterward", async () => {
    const events: string[] = [];
    const originalExit = process.exit;
    process.exit = ((code?: number) => {
      events.push(`exit:${code}`);
    }) as typeof process.exit;
    const dispose = installSignalTeardown({
      teardown: async () => events.push("teardown"),
      error: () => {},
    });
    try {
      dispose();
      process.emit("SIGHUP");
      await sleep(30);
      expect(events).toEqual([]);
    } finally {
      process.exit = originalExit;
    }
  });
});

describe("static dangerous-command guard (R13/NFR3)", () => {
  const MODULE_PATH = fileURLToPath(
    new URL("../../../../scripts/test-support/supabase-isolation.mjs", import.meta.url)
  );

  it("the harness source never contains a global Docker/Supabase cleanup command", () => {
    const source = readFileSync(MODULE_PATH, "utf8");
    // No Docker/system prune anywhere in the harness.
    expect(source).not.toMatch(/prune/i);
    // No all-projects Supabase stop flag anywhere in the harness.
    expect(source).not.toMatch(/--all\b/);
    // No unfiltered `docker … rm` with no id list is possible by construction
    // (the argument builder rejects empty id lists — covered above).
  });

  it("the exported command builders are provably project-scoped", () => {
    const id = "ocf-contract-abcd1234";
    for (const kind of ["container", "network", "volume"] as const) {
      const list = dockerScopedListArgs(kind, id);
      expect(list.join(" ")).toContain(`label=${SUPABASE_PROJECT_LABEL}=${id}`);
      expect(() => dockerScopedRemoveArgs(kind, [])).toThrow();
    }
    // The recovery command stays workdir-scoped (no unsupported --project-id),
    // with the label still naming the lane's own resources for the reaper.
    const recovery = laneRecoverySummary(id, { workdir: "/tmp/lane" });
    expect(recovery).toContain("supabase stop --no-backup --yes --workdir /tmp/lane");
    expect(recovery).not.toContain("--project-id");
    expect(recovery).toContain(SUPABASE_PROJECT_LABEL);
  });
});