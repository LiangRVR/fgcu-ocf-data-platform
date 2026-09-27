/**
 * scripts/schema-inventory/redact.ts
 *
 * Output redaction: guarantees that serialized inventory/diff output never
 * contains credentials, postgres URLs, JWT-shaped tokens, or long
 * key-shaped runs. Applied to every string the CLI prints or writes.
 *
 * Defense in depth: input validation already rejects credential-shaped keys,
 * but redaction also catches values that happen to be embedded in catalog
 * text (e.g. a CHECK default containing a URL-like literal).
 */

/** Placeholder used for every redacted value. */
const MARKER = "[REDACTED]";

const REDACTIONS: ReadonlyArray<{ name: string; test: RegExp; replace: string }> = [
  // postgres/postgresql URLs with credentials (userinfo). Keep scheme + host,
  // mask the password and user.
  {
    name: "postgres-url-userinfo",
    test: /(postgres(?:ql)?:\/\/)([^/@\s]+)@/g,
    replace: `$1${MARKER}@`,
  },
  // JWT-shaped tokens: base64url.header.payload[.signature].
  {
    name: "jwt",
    test: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    replace: MARKER,
  },
  // Supabase publishable/secret service tokens (sbp_..., sb_secret_...).
  {
    name: "supabase-token",
    test: /\b(?:sbp_|sb_secret_|sb_publishable_)[A-Za-z0-9_-]+/g,
    replace: MARKER,
  },
  // Long key-shaped runs (>= 24 chars) that LOOK like secrets: base64-style
  // tokens containing both upper- and lower-case and a digit, or explicit
  // base64 padding. Pure lower-case snake_case identifiers (policy/trigger
  // names, long definitions) are preserved so the diff register keeps its
  // evidence value.
  {
    name: "long-key-run",
    test: /[A-Za-z0-9+/=_-]{24,}/g,
    replace: MARKER,
  },
  // Key=value or KEY = value assignment lines for known secret-ish key names.
  {
    name: "secret-assignment",
    test: /(\b[A-Z][A-Z0-9_]*(?:_KEY|_TOKEN|_SECRET|_PASSWORD|_URL|_DSN|_CREDENTIAL)\b)\s*[:=]\s*"?[^\s"]+"?/g,
    replace: `$1=${MARKER}`,
  },
];

/** True when a long alphanumeric run has secret-like shape (key material). */
function isSecretLikeRun(run: string): boolean {
  if (run.length < 24) return false;
  // Base64 padding / slash / plus => clearly encoded key material.
  if (/[+/=]/.test(run)) return true;
  const hasUpper = /[A-Z]/.test(run);
  const hasLower = /[a-z]/.test(run);
  const hasDigit = /[0-9]/.test(run);
  // Mixed-case AND digit => typical base64url secret.
  if (hasUpper && hasLower && hasDigit) return true;
  // All-uppercase key-like token with a digit (AWS-style access key IDs).
  if (hasUpper && !hasLower && hasDigit && run.length >= 20) return true;
  return false;
}

/**
 * Redact a single string. Idempotent and safe on already-redacted text.
 */
export function redactString(input: string): string {
  let out = input;
  for (const rule of REDACTIONS) {
    if (rule.name === "long-key-run") {
      out = out.replace(rule.test, (run) => (isSecretLikeRun(run) ? MARKER : run));
      continue;
    }
    out = out.replace(rule.test, rule.replace);
  }
  return out;
}

/**
 * Redact every string reachable in a JSON-serializable value (objects,
 * arrays, strings). Returns a deep copy; the input is never mutated.
 */
export function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactValue(child);
    }
    return out;
  }
  return value;
}

/**
 * Serialize a value to a redacted JSON string (pretty-printed, 2-space).
 */
export function toRedactedJson(value: unknown): string {
  return JSON.stringify(redactValue(value), null, 2);
}