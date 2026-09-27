/**
 * scripts/schema-inventory/normalize.ts
 *
 * Pure normalization helpers: convert raw catalog rows into the normalized
 * `CatalogRecord` shape, strip environment noise, and compute deterministic
 * content hashes. No I/O, no secrets, no row data.
 *
 * Safety rules (review remediation):
 *   - SQL-shaped text is NEVER retained raw: only sha256 hashes of a
 *     literal-safe normalized form are stored.
 *   - `normalizeSqlExpression` collapses whitespace OUTSIDE single-quoted
 *     literals and double-quoted identifiers only, so string literals and
 *     quoted identifiers are never altered (no prefix stripping, no
 *     identifier unquoting).
 *   - ordered fields (FK columns, search_path) preserve their order.
 */

import { createHash } from "node:crypto";

/** Collapse all whitespace runs to a single space and trim. */
export function collapseWhitespace(input: string | null | undefined): string {
  if (input == null) return "";
  return input.replace(/\s+/g, " ").trim();
}

/** Trim a single-line identifier (names never gain/lose internal whitespace). */
export function trimOrEmpty(input: string | null | undefined): string {
  if (input == null) return "";
  return input.trim();
}

/**
 * Literal-safe SQL normalization for hashing:
 *   - collapses whitespace runs outside single-quoted literals and
 *     double-quoted identifiers to a single space;
 *   - preserves the content of single-quoted literals (including `''`
 *     escapes) and double-quoted identifiers VERBATIM;
 *   - does NOT strip `pg_catalog.`/`public.` prefixes and does NOT unquote
 *     identifiers (those transforms can alter literal/identifier content).
 *
 * Deterministic: identical inputs always produce identical output.
 */
export function normalizeSqlExpression(input: string | null | undefined): string {
  if (input == null) return "";
  let out = "";
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    const next = i + 1 < input.length ? input[i + 1] : "";

    // Inside a single-quoted literal: keep everything verbatim, handling the
    // standard '' escape (and backslash escapes for backslash-quoted engines).
    if (inSingle) {
      out += ch;
      if (ch === "\\" && next !== "") {
        out += next;
        i += 1;
      } else if (ch === "'" && next === "'") {
        out += "'";
        i += 1;
      } else if (ch === "'") {
        inSingle = false;
      }
      continue;
    }

    // Inside a double-quoted identifier: keep everything verbatim, handling
    // the "" escape.
    if (inDouble) {
      out += ch;
      if (ch === '"' && next === '"') {
        out += '"';
        i += 1;
      } else if (ch === '"') {
        inDouble = false;
      }
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      out += ch;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      out += ch;
      continue;
    }
    if (/\s/.test(ch)) {
      // Collapse whitespace runs to a single space, skipping a leading space.
      if (out.length > 0 && !/\s$/.test(out)) out += " ";
      continue;
    }
    out += ch;
  }

  return out.trim();
}

/** sha256 hex digest of a normalized string (used for body/content hashes). */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Stable hash of a SQL-shaped string: sha256 over the literal-safe normalized
 * form. Use this for EXPRESSIONS (defaults, constraint/index/trigger/view
 * definitions, policy qualifiers) so packets never retain SQL text.
 */
export function sqlHash(input: string | null | undefined): string {
  return sha256Hex(normalizeSqlExpression(input));
}

/**
 * Verbatim sha256 hash of a SQL string with NO whitespace normalization.
 * Use this for FUNCTION BODIES: whitespace is semantically significant there
 * (`--` line comments run to end-of-line, block comments and dollar-quoted
 * strings contain arbitrary text, and quoted strings may carry whitespace).
 * Any normalization would silently change the meaning of such bodies.
 */
export function verbatimHash(input: string | null | undefined): string {
  return sha256Hex(String(input ?? ""));
}

/**
 * Normalize a `proacl` / `relacl` array of ACL strings: keep role names and
 * privilege sets, drop the grantor suffix (environment noise), sort. `PUBLIC`
 * entries (grantee empty, e.g. `=X`) are preserved — effective ACLs must not
 * hide default PUBLIC EXECUTE.
 */
export function normalizeAcl(acl: string[] | null | undefined): string[] {
  if (!acl) return [];
  const normalized = acl.map((entry) => {
    const slash = entry.indexOf("/");
    return slash >= 0 ? entry.slice(0, slash) : entry;
  });
  return [...new Set(normalized)].sort();
}

/**
 * Normalize a role name list: trim, de-duplicate, sort. A single PUBLIC role
 * collapses to `["PUBLIC"]`.
 */
export function normalizeRoles(roles: string[] | null | undefined): string[] {
  if (!roles) return [];
  const cleaned = roles.map((r) => trimOrEmpty(r)).filter((r) => r.length > 0);
  return [...new Set(cleaned)].sort();
}

/**
 * Normalize a search_path string (e.g. `"$user", public, pg_catalog`) into an
 * ORDER-PRESERVING, de-duplicated array. Order matters in a search_path and is
 * never sorted. Empty/`""` becomes `[]`.
 */
export function normalizeSearchPath(searchPath: string | null | undefined): string[] {
  if (searchPath == null) return [];
  const parts = searchPath
    .split(",")
    .map((p) => p.trim().replace(/^"|"$/g, ""))
    .filter((p) => p.length > 0);
  return [...new Set(parts)];
}

/**
 * Normalize a boolean-ish value from a catalog query into a real boolean,
 * or `null` when the source value is unrecognized.
 */
export function normalizeBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === "t" || value === "true" || value === 1 || value === "1") return true;
  if (value === "f" || value === "false" || value === 0 || value === "0") return false;
  return null;
}

/**
 * Map a `contype` / `polcmd` style single-letter code to a stable word, or
 * return the raw code when unrecognized (callers decide how to classify).
 */
export function mapActionCode(code: string | null | undefined): string {
  const map: Record<string, string> = {
    a: "NO ACTION",
    r: "RESTRICT",
    c: "CASCADE",
    n: "SET NULL",
    d: "SET DEFAULT",
    p: "PRIMARY KEY",
    u: "UNIQUE",
    f: "FOREIGN KEY",
    x: "EXCLUDE",
    t: "TRIGGER",
    i: "INDEX",
    s: "SEQUENCE",
    v: "VIEW",
    m: "MATERIALIZED VIEW",
    "*": "ALL",
  };
  return map[code ?? ""] ?? String(code ?? "");
}

/**
 * Map a `pg_constraint.contype` code to its stable type name.
 *
 * IMPORTANT: this is a SEPARATE mapper from `mapActionCode` because the same
 * letter means different things in the two contexts — `c` is `CHECK` as a
 * constraint type but `CASCADE` as a foreign-key action. Using the FK action
 * mapper for constraint types mislabels every CHECK constraint as CASCADE.
 */
export function mapConstraintType(code: string | null | undefined): string {
  const map: Record<string, string> = {
    p: "PRIMARY KEY",
    u: "UNIQUE",
    c: "CHECK",
    f: "FOREIGN KEY",
    x: "EXCLUDE",
    t: "TRIGGER",
    n: "NOT NULL",
    i: "INDEX",
  };
  return map[code ?? ""] ?? String(code ?? "");
}

/**
 * Map a policy command code to a stable word.
 */
export function mapPolicyCommand(code: string | null | undefined): string {
  const map: Record<string, string> = {
    r: "SELECT",
    a: "INSERT",
    w: "UPDATE",
    d: "DELETE",
    "*": "ALL",
  };
  return map[code ?? ""] ?? String(code ?? "");
}

/**
 * Convert a raw catalog value into a stable `string | number | boolean | null`
 * record field. Rejects objects/arrays (never trusted into a normalized
 * record) and truncates nothing — values are either primitives or dropped.
 */
export function toPrimitiveField(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  return null;
}