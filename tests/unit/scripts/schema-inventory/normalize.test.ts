/**
 * tests/unit/scripts/schema-inventory/normalize.test.ts
 *
 * Unit tests for the pure normalization helpers: literal-safe SQL noise
 * removal, deterministic hashing, order-preserving search_path, ACL/role
 * normalization.
 */

import { describe, expect, it } from "vitest";
import {
  collapseWhitespace,
  mapActionCode,
  mapConstraintType,
  mapPolicyCommand,
  normalizeAcl,
  normalizeBoolean,
  normalizeRoles,
  normalizeSearchPath,
  normalizeSqlExpression,
  sha256Hex,
  sqlHash,
  toPrimitiveField,
  trimOrEmpty,
  verbatimHash,
} from "../../../../scripts/schema-inventory/normalize";

describe("collapseWhitespace", () => {
  it("collapses runs of whitespace and trims", () => {
    expect(collapseWhitespace("  a \n\t b   c  ")).toBe("a b c");
  });

  it("handles null / undefined as empty string", () => {
    expect(collapseWhitespace(null)).toBe("");
    expect(collapseWhitespace(undefined)).toBe("");
  });
});

describe("trimOrEmpty", () => {
  it("trims without altering internal content", () => {
    expect(trimOrEmpty("  advisor  ")).toBe("advisor");
    expect(trimOrEmpty("My  Table")).toBe("My  Table");
    expect(trimOrEmpty(null)).toBe("");
  });
});

describe("normalizeSqlExpression (literal-safe)", () => {
  it("collapses whitespace runs outside literals", () => {
    expect(normalizeSqlExpression("  SELECT  1  FROM  pg_class  ")).toBe("SELECT 1 FROM pg_class");
  });

  it("NEVER alters the content of single-quoted string literals", () => {
    // A literal with multiple spaces must survive verbatim.
    expect(normalizeSqlExpression("DEFAULT 'a  b'")).toBe("DEFAULT 'a  b'");
    // Literal containing an email / URL-shaped value must survive verbatim.
    expect(normalizeSqlExpression("CHECK (email = 'advisor@example.com')")).toBe(
      "CHECK (email = 'advisor@example.com')"
    );
    expect(normalizeSqlExpression("CHECK (url <> 'https://example.com/x')")).toBe(
      "CHECK (url <> 'https://example.com/x')"
    );
  });

  it("NEVER alters quoted identifiers and does not strip prefixes", () => {
    // `public.` inside a string literal must not be stripped.
    expect(normalizeSqlExpression("nextval('public.seq'::regclass)")).toBe(
      "nextval('public.seq'::regclass)"
    );
    // pg_catalog. prefix outside a literal is NOT stripped either (safe).
    expect(normalizeSqlExpression("pg_catalog.pg_class")).toBe("pg_catalog.pg_class");
    // Double-quoted identifiers with spaces survive verbatim.
    expect(normalizeSqlExpression('"Full  Name" IS NOT NULL')).toBe('"Full  Name" IS NOT NULL');
  });

  it("handles escaped quotes in literals", () => {
    expect(normalizeSqlExpression("CHECK (name = 'It''s')")).toBe("CHECK (name = 'It''s')");
  });

  it("is deterministic for identical inputs", () => {
    const a = normalizeSqlExpression("  SELECT  *  FROM  pg_class  ");
    const b = normalizeSqlExpression("SELECT * FROM pg_class");
    expect(a).toBe(b);
  });
});

describe("sha256Hex and sqlHash", () => {
  it("produces a deterministic 64-char hex digest", () => {
    const h1 = sha256Hex("same body");
    const h2 = sha256Hex("same body");
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs when the input differs", () => {
    expect(sha256Hex("body a")).not.toBe(sha256Hex("body b"));
  });

  it("sqlHash hashes the literal-safe normalized form", () => {
    expect(sqlHash("DEFAULT 'a  b'")).toBe(sha256Hex("DEFAULT 'a  b'"));
    // Whitespace-only differences normalize to the same hash.
    expect(sqlHash("  DEFAULT 'a'  ")).toBe(sqlHash("DEFAULT 'a'"));
    // Literal content differences produce different hashes.
    expect(sqlHash("DEFAULT 'a  b'")).not.toBe(sqlHash("DEFAULT 'a b'"));
  });
});

describe("normalizeAcl", () => {
  it("strips grantor suffixes and sorts", () => {
    const input = ["authenticated=arwdDxt/postgres", "anon=r/postgres", "authenticated=arwdDxt/postgres"];
    expect(normalizeAcl(input)).toEqual(["anon=r", "authenticated=arwdDxt"]);
  });

  it("preserves default PUBLIC EXECUTE entries (empty grantee = PUBLIC)", () => {
    // `=X` is the aclitem for PUBLIC EXECUTE; it must never be dropped.
    expect(normalizeAcl(["=X/postgres", "postgres=X/postgres"])).toEqual(["=X", "postgres=X"]);
  });

  it("returns [] for null / empty input", () => {
    expect(normalizeAcl(null)).toEqual([]);
    expect(normalizeAcl([])).toEqual([]);
  });
});

describe("normalizeRoles", () => {
  it("trims, dedupes, and sorts role names", () => {
    expect(normalizeRoles([" authenticated ", "anon", "authenticated", "anon"])).toEqual([
      "anon",
      "authenticated",
    ]);
  });

  it("returns [] for null / empty input", () => {
    expect(normalizeRoles(null)).toEqual([]);
    expect(normalizeRoles([])).toEqual([]);
  });
});

describe("normalizeSearchPath", () => {
  it("parses and dedupes search_path entries while PRESERVING order", () => {
    expect(normalizeSearchPath('"$user", public, pg_catalog')).toEqual([
      "$user",
      "public",
      "pg_catalog",
    ]);
  });

  it("does not reorder entries", () => {
    expect(normalizeSearchPath("pg_catalog, public")).toEqual(["pg_catalog", "public"]);
    expect(normalizeSearchPath("public, pg_catalog")).toEqual(["public", "pg_catalog"]);
  });

  it("returns [] for null / empty input", () => {
    expect(normalizeSearchPath(null)).toEqual([]);
    expect(normalizeSearchPath("")).toEqual([]);
    expect(normalizeSearchPath('""')).toEqual([]);
  });
});

describe("normalizeBoolean", () => {
  it("normalizes common truthy / falsy representations", () => {
    expect(normalizeBoolean(true)).toBe(true);
    expect(normalizeBoolean("t")).toBe(true);
    expect(normalizeBoolean("true")).toBe(true);
    expect(normalizeBoolean(1)).toBe(true);
    expect(normalizeBoolean(false)).toBe(false);
    expect(normalizeBoolean("f")).toBe(false);
    expect(normalizeBoolean("false")).toBe(false);
    expect(normalizeBoolean(0)).toBe(false);
  });

  it("returns null for unrecognized values", () => {
    expect(normalizeBoolean("maybe")).toBeNull();
    expect(normalizeBoolean(null)).toBeNull();
    expect(normalizeBoolean(undefined)).toBeNull();
  });
});

describe("mapActionCode", () => {
  it("maps FK/constraint action codes to stable words", () => {
    expect(mapActionCode("a")).toBe("NO ACTION");
    expect(mapActionCode("r")).toBe("RESTRICT");
    expect(mapActionCode("c")).toBe("CASCADE");
    expect(mapActionCode("n")).toBe("SET NULL");
    expect(mapActionCode("d")).toBe("SET DEFAULT");
    expect(mapActionCode("p")).toBe("PRIMARY KEY");
    expect(mapActionCode("u")).toBe("UNIQUE");
    expect(mapActionCode("f")).toBe("FOREIGN KEY");
    expect(mapActionCode("x")).toBe("EXCLUDE");
  });

  it("returns the raw code when unrecognized", () => {
    expect(mapActionCode("z")).toBe("z");
    expect(mapActionCode(null)).toBe("");
  });
});

describe("mapConstraintType (separate pg_constraint contype mapper)", () => {
  it("maps pg_constraint contype codes to stable type names", () => {
    // The critical distinction: `c` is CHECK as a constraint type, NEVER
    // CASCADE (which is only an FK action code).
    expect(mapConstraintType("c")).toBe("CHECK");
    expect(mapConstraintType("p")).toBe("PRIMARY KEY");
    expect(mapConstraintType("u")).toBe("UNIQUE");
    expect(mapConstraintType("f")).toBe("FOREIGN KEY");
    expect(mapConstraintType("x")).toBe("EXCLUDE");
    expect(mapConstraintType("t")).toBe("TRIGGER");
    expect(mapConstraintType("n")).toBe("NOT NULL");
  });

  it("does NOT mislabel CHECK as CASCADE", () => {
    expect(mapConstraintType("c")).not.toBe("CASCADE");
  });

  it("returns the raw code when unrecognized", () => {
    expect(mapConstraintType("z")).toBe("z");
    expect(mapConstraintType(null)).toBe("");
  });
});

describe("verbatimHash (semantic-safe function body hashing)", () => {
  it("hashes the body verbatim with NO whitespace normalization", () => {
    const body = "SELECT 1 -- line comment\n, 2";
    expect(verbatimHash(body)).toBe(sha256Hex(body));
    expect(verbatimHash(body)).not.toBe(sqlHash(body));
  });

  it("keeps -- line-comment semantics intact", () => {
    // `--` comments run to end-of-line: collapsing the newline would swallow
    // the following tokens into the comment. Verbatim hashing keeps them
    // distinct.
    const a = "SELECT 1 -- comment\n+ 2";
    const b = "SELECT 1 -- comment + 2";
    expect(verbatimHash(a)).not.toBe(verbatimHash(b));
  });

  it("keeps block-comment content distinct", () => {
    const a = "SELECT 1 /* a  b */";
    const b = "SELECT 1 /* a b */";
    expect(verbatimHash(a)).not.toBe(verbatimHash(b));
  });

  it("keeps dollar-quoted strings intact", () => {
    const a = "SELECT $tag$a  b$tag$";
    const b = "SELECT $tag$a b$tag$";
    expect(verbatimHash(a)).not.toBe(verbatimHash(b));
  });

  it("keeps quoted-string whitespace intact", () => {
    const a = "SELECT 'a  b'";
    const b = "SELECT 'a b'";
    expect(verbatimHash(a)).not.toBe(verbatimHash(b));
  });

  it("is deterministic and always 64-char hex", () => {
    const body = "BEGIN IF NEW.x IS NULL THEN RETURN NEW; END IF; END;";
    expect(verbatimHash(body)).toMatch(/^[0-9a-f]{64}$/);
    expect(verbatimHash(body)).toBe(verbatimHash(body));
  });

  it("hashes null/undefined as the empty-string hash", () => {
    expect(verbatimHash(null)).toBe(sha256Hex(""));
    expect(verbatimHash(undefined)).toBe(sha256Hex(""));
  });
});

describe("mapPolicyCommand", () => {
  it("maps policy command codes to stable words", () => {
    expect(mapPolicyCommand("r")).toBe("SELECT");
    expect(mapPolicyCommand("a")).toBe("INSERT");
    expect(mapPolicyCommand("w")).toBe("UPDATE");
    expect(mapPolicyCommand("d")).toBe("DELETE");
    expect(mapPolicyCommand("*")).toBe("ALL");
  });

  it("returns the raw code when unrecognized", () => {
    expect(mapPolicyCommand("x")).toBe("x");
    expect(mapPolicyCommand(null)).toBe("");
  });
});

describe("toPrimitiveField", () => {
  it("passes through primitives and dates", () => {
    expect(toPrimitiveField("x")).toBe("x");
    expect(toPrimitiveField(42)).toBe(42);
    expect(toPrimitiveField(true)).toBe(true);
    expect(toPrimitiveField(null)).toBe(null);
    expect(toPrimitiveField(new Date("2026-01-01T00:00:00Z"))).toBe("2026-01-01T00:00:00.000Z");
  });

  it("drops objects and arrays (never trusted into a record)", () => {
    expect(toPrimitiveField({ a: 1 })).toBeNull();
    expect(toPrimitiveField([1, 2])).toBeNull();
    expect(toPrimitiveField(undefined)).toBeNull();
  });
});