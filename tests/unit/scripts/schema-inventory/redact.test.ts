/**
 * tests/unit/scripts/schema-inventory/redact.test.ts
 *
 * Output redaction guarantees: no credentials, postgres URLs, JWTs, Supabase
 * tokens, or long key-shaped runs survive serialization; benign catalog text
 * passes through untouched.
 */

import { describe, expect, it } from "vitest";
import { redactString, redactValue, toRedactedJson } from "../../../../scripts/schema-inventory/redact";

describe("redactString", () => {
  it("masks credentials embedded in postgres URLs", () => {
    const out = redactString("postgresql://postgres:supersecret@127.0.0.1:54322/postgres");
    expect(out).not.toContain("supersecret");
    expect(out).toContain("[REDACTED]");
  });

  it("masks JWT-shaped tokens", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.signature";
    const out = redactString(`token ${jwt} leaked`);
    expect(out).not.toContain("eyJhbGci");
    expect(out).toContain("[REDACTED]");
  });

  it("masks Supabase publishable/secret tokens", () => {
    expect(redactString("sbp_local_key_abcdef123456")).toContain("[REDACTED]");
    expect(redactString("sb_secret_local_key_abcdef123456")).toContain("[REDACTED]");
    expect(redactString("sb_publishable_local_key_abcdef123456")).toContain("[REDACTED]");
  });

  it("masks long secret-shaped key runs (mixed-case + digits)", () => {
    const longKey = "eyJzZXJ2aWNlX3JvbGVfa2V5X3dpdGhfbWl4ZWRjYXNlXzEyMzQ1Ng";
    expect(redactString(`service key ${longKey}`)).not.toContain(longKey);
    expect(redactString(`service key ${longKey}`)).toContain("[REDACTED]");
  });

  it("preserves long lower-case snake_case identifiers (evidence value)", () => {
    const identifier = "public.advisor.advisor_select_self_or_active_staff";
    expect(redactString(identifier)).toBe(identifier);
  });

  it("preserves lower-case sha256 body hashes (hex, no upper-case)", () => {
    const hash = "ab".repeat(32);
    expect(redactString(hash)).toBe(hash);
  });

  it("masks KEY=value assignment lines for secret-ish keys", () => {
    const out = redactString('SERVICE_ROLE_KEY="eyJsecretvalue123"');
    expect(out).not.toContain("eyJsecretvalue123");
    expect(out).toContain("SERVICE_ROLE_KEY=[REDACTED]");
  });

  it("preserves benign catalog text", () => {
    const text = "constraint advisor_pkey PRIMARY KEY (advisor_id)";
    expect(redactString(text)).toBe(text);
  });

  it("is idempotent", () => {
    const input = "postgresql://user:pass@127.0.0.1/db and eyJabc.def.ghi";
    const once = redactString(input);
    expect(redactString(once)).toBe(once);
  });
});

describe("redactValue / toRedactedJson", () => {
  it("redacts strings deep inside objects and arrays", () => {
    const value = {
      ok: true,
      table: "advisor",
      connection: "postgresql://postgres:hunter2@127.0.0.1:54322/postgres",
      grants: [{ role: "anon", secret: "sb_secret_local_key_abcdef123456" }],
    };
    const redacted = redactValue(value) as typeof value;
    expect(redacted.connection).not.toContain("hunter2");
    expect(redacted.grants[0].secret).not.toContain("sb_secret");
    expect(redacted.table).toBe("advisor");
    expect(redacted.ok).toBe(true);
  });

  it("serializes redacted JSON without mutating the input", () => {
    const input = { url: "postgresql://u:p@127.0.0.1/db", count: 3 };
    const json = toRedactedJson(input);
    expect(json).not.toContain(":p@");
    expect(JSON.parse(json).count).toBe(3);
    // Input unchanged.
    expect(input.url).toBe("postgresql://u:p@127.0.0.1/db");
  });
});