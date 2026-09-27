/**
 * scripts/schema-inventory/validate.ts
 *
 * Input validation for the schema inventory/diff utility.
 *
 * Hard rejections:
 *   1. Non-loopback DB URLs are rejected — the utility may only ever capture
 *      from a disposable local database, never from a hosted/shared database.
 *   2. Non-catalog / data-bearing keys are rejected anywhere in an inventory
 *      packet — packets may only contain the documented catalog sections and
 *      fields; anything row-data-shaped (`rows`, `data`, `values`, ...) or
 *      credential-shaped (`password`, `secret`, `token`, `url`, ...) is
 *      refused so no row data or secret can ever enter or leave a packet.
 *   3. Incomplete packets fail closed: EVERY catalog section must be present
 *      (missing sections are rejected, never defaulted to empty).
 *   4. Raw SQL fields are rejected: records may only carry the documented
 *      safe structural fields and `*Hash` sha256 fields — never raw
 *      definitions/defaults/policy/check/index/trigger/view expressions.
 *
 * This module is side-effect-free (pure functions) except where noted.
 */

import {
  CATALOG_SECTIONS,
  INVENTORY_FORMAT_VERSION,
  MANIFEST_FORMAT_VERSION,
  type CatalogRecord,
  type CatalogSection,
  type DispositionManifest,
  type InventorySource,
  type ReviewedDisposition,
  type ReviewedDispositionValue,
  type SchemaInventory,
} from "./types";

/** Error raised for invalid packets / manifests / non-loopback URLs. */
export class InventoryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InventoryValidationError";
  }
}

// ---------------------------------------------------------------------------
// Loopback URL guard
// ---------------------------------------------------------------------------

/** Host names accepted as loopback for a local capture. */
const LOOPBACK_HOST = /^(?:127(?:\.\d{1,3}){3}|localhost|\[::1\]|::1)$/;

/** True only for a postgres(ql) URL bound to a loopback address. */
export function isLoopbackDbUrl(url: string): boolean {
  if (typeof url !== "string" || url.length === 0 || /\s/.test(url)) return false;
  try {
    const u = new URL(url);
    if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") return false;
    return LOOPBACK_HOST.test(u.hostname);
  } catch {
    return false;
  }
}

/**
 * Assert `url` is a loopback-only postgres URL. Throws without echoing the
 * URL (which may contain credentials) when it is not.
 */
export function assertLoopbackDbUrl(url: string): void {
  if (!isLoopbackDbUrl(url)) {
    throw new InventoryValidationError(
      "Refusing capture: database URL did not resolve to a loopback host. " +
        "Schema capture is only allowed against a disposable local database."
    );
  }
}

// ---------------------------------------------------------------------------
// Non-catalog / data-bearing key rejection
// ---------------------------------------------------------------------------

/**
 * Exact keys that are rejected ANYWHERE inside an inventory packet. Row-data
 * shapes and credential shapes are both refused. Matches are case-insensitive.
 */
const PROHIBITED_KEYS = new Set([
  // Row-data shapes
  "data",
  "rows",
  "row",
  "values",
  "result",
  "results",
  "query",
  "queries",
  "payload",
  "content",
  "body",
  "record",
  "records",
  "table_data",
  "tableData",
  "row_data",
  "rowData",
  "sample",
  "sample_rows",
  "sampleRows",
  "fixture",
  "fixtures",
  "seed",
  "seeds",
  "items",
  "item",
  // Credential / connection shapes
  "password",
  "passwords",
  "secret",
  "secrets",
  "token",
  "tokens",
  "key",
  "api_key",
  "apiKey",
  "service_role_key",
  "serviceRoleKey",
  "service_role",
  "serviceRole",
  "anon_key",
  "anonKey",
  "jwt",
  "jwt_secret",
  "jwtSecret",
  "url",
  "db_url",
  "dbUrl",
  "database_url",
  "databaseUrl",
  "connection_string",
  "connectionString",
  "dsn",
  "credentials",
  "credential",
  "auth",
  "authentication",
  "private_key",
  "privateKey",
  "public_key",
  "publicKey",
  "session",
  "sessions",
]);

/**
 * Recursively scan a parsed JSON value for any prohibited key. Throws with a
 * precise path on the first hit.
 */
export function assertNoProhibitedKeys(value: unknown, path = "$"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoProhibitedKeys(item, `${path}[${index}]`));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const lower = key.toLowerCase();
      if (PROHIBITED_KEYS.has(lower)) {
        throw new InventoryValidationError(
          `Rejected prohibited key "${key}" at ${path}.${key}: inventory packets may only ` +
            "contain catalog metadata; row data and credential/connection fields are not allowed."
        );
      }
      assertNoProhibitedKeys(child, `${path}.${key}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Structural packet validation
// ---------------------------------------------------------------------------

/**
 * Allowed field keys per catalog section. Any other key inside a record is
 * rejected (non-catalog / data-bearing / raw-SQL keys are refused). Raw SQL
 * fields (`definition`, `default`, `using`, `withCheck`, `body`, ...) are NOT
 * in any allowlist: packets only carry structural fields and `*Hash` values.
 */
export const SECTION_FIELDS: Record<CatalogSection, readonly string[]> = {
  migrationLedger: ["version", "name"],
  tables: ["schema", "name", "kind", "persistence"],
  columns: [
    "schema",
    "table",
    "name",
    "ordinal",
    "dataType",
    "nullable",
    "defaultHash",
    "generated",
  ],
  constraints: ["schema", "table", "name", "type", "definitionHash"],
  foreignKeys: [
    "schema",
    "table",
    "name",
    "columns",
    "referencedSchema",
    "referencedTable",
    "referencedColumns",
    "onUpdate",
    "onDelete",
    "deferrable",
    "initiallyDeferred",
  ],
  indexes: ["schema", "table", "name", "unique", "definitionHash"],
  sequences: ["schema", "name", "dataType", "ownedBy"],
  views: ["schema", "name", "kind", "definitionHash"],
  functions: [
    "schema",
    "name",
    "signature",
    "returnType",
    "language",
    "volatility",
    "securityMode",
    "searchPath",
    "acl",
    "bodyHash",
  ],
  triggers: [
    "schema",
    "table",
    "name",
    "function",
    "timing",
    "events",
    "state",
    "definitionHash",
  ],
  rls: ["schema", "table", "enabled", "forced"],
  policies: [
    "schema",
    "table",
    "name",
    "command",
    "roles",
    "permissive",
    "usingHash",
    "withCheckHash",
  ],
  grants: [
    "schema",
    "objectType",
    "objectName",
    "grantee",
    "privilege",
    "grantable",
  ],
  schemaPrivileges: ["schema", "grantee", "privilege", "grantable"],
  defaultPrivileges: [
    "ownerRole",
    "schema",
    "objectType",
    "grantee",
    "privilege",
    "grantable",
  ],
  extensions: ["schema", "name", "version"],
};

/**
 * Expected type of each catalog field. Structural fields must match their
 * declared type exactly; every `*Hash` field must be a lowercase 64-char
 * SHA-256 hex string (or null where allowed), so raw SQL/emails/URLs/secret
 * values can never ride inside a hash field.
 */
export type FieldType =
  | "string"
  | "number"
  | "boolean"
  | "string-array"
  | "sha256"
  | "sha256-or-null"
  | "string-or-null";

/** Exact form of every SHA-256 content hash carried in a packet. */
export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Per-section field type expectations. Every field name present in
 * `SECTION_FIELDS` MUST have an entry here (a consistency test enforces it).
 */
export const FIELD_TYPES: Record<CatalogSection, Record<string, FieldType>> = {
  migrationLedger: {
    version: "string",
    name: "string",
  },
  tables: {
    schema: "string",
    name: "string",
    kind: "string",
    persistence: "string",
  },
  columns: {
    schema: "string",
    table: "string",
    name: "string",
    ordinal: "number",
    dataType: "string",
    nullable: "boolean",
    defaultHash: "sha256-or-null",
    generated: "string",
  },
  constraints: {
    schema: "string",
    table: "string",
    name: "string",
    type: "string",
    definitionHash: "sha256",
  },
  foreignKeys: {
    schema: "string",
    table: "string",
    name: "string",
    columns: "string-array",
    referencedSchema: "string",
    referencedTable: "string",
    referencedColumns: "string-array",
    onUpdate: "string",
    onDelete: "string",
    deferrable: "boolean",
    initiallyDeferred: "boolean",
  },
  indexes: {
    schema: "string",
    table: "string",
    name: "string",
    unique: "boolean",
    definitionHash: "sha256",
  },
  sequences: {
    schema: "string",
    name: "string",
    dataType: "string",
    ownedBy: "string-or-null",
  },
  views: {
    schema: "string",
    name: "string",
    kind: "string",
    definitionHash: "sha256",
  },
  functions: {
    schema: "string",
    name: "string",
    signature: "string",
    returnType: "string",
    language: "string",
    volatility: "string",
    securityMode: "string",
    searchPath: "string-array",
    acl: "string-array",
    bodyHash: "sha256",
  },
  triggers: {
    schema: "string",
    table: "string",
    name: "string",
    function: "string",
    timing: "string",
    events: "string-array",
    state: "string",
    definitionHash: "sha256",
  },
  rls: {
    schema: "string",
    table: "string",
    enabled: "boolean",
    forced: "boolean",
  },
  policies: {
    schema: "string",
    table: "string",
    name: "string",
    command: "string",
    roles: "string-array",
    permissive: "boolean",
    usingHash: "sha256-or-null",
    withCheckHash: "sha256-or-null",
  },
  grants: {
    schema: "string",
    objectType: "string",
    objectName: "string",
    grantee: "string",
    privilege: "string",
    grantable: "boolean",
  },
  schemaPrivileges: {
    schema: "string",
    grantee: "string",
    privilege: "string",
    grantable: "boolean",
  },
  defaultPrivileges: {
    ownerRole: "string",
    schema: "string",
    objectType: "string",
    grantee: "string",
    privilege: "string",
    grantable: "boolean",
  },
  extensions: {
    schema: "string",
    name: "string",
    version: "string",
  },
};

/** Metadata keys allowed on a record alongside its section fields. */
const RECORD_METADATA_KEYS = ["identity", "source"] as const;

/** Validate a single field value against its declared type. Returns an error
 * description or null when the value is acceptable. */
function fieldTypeError(expected: FieldType, value: unknown): string | null {
  switch (expected) {
    case "string":
      return typeof value === "string" ? null : "must be a string";
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? null : "must be a finite number";
    case "boolean":
      return typeof value === "boolean" ? null : "must be a boolean";
    case "string-array":
      return Array.isArray(value) && value.every((item) => typeof item === "string")
        ? null
        : "must be an array of strings";
    case "sha256":
      return typeof value === "string" && SHA256_HEX_PATTERN.test(value)
        ? null
        : "must be a lowercase 64-char SHA-256 hex string";
    case "sha256-or-null":
      return value === null ||
        (typeof value === "string" && SHA256_HEX_PATTERN.test(value))
        ? null
        : "must be null or a lowercase 64-char SHA-256 hex string";
    case "string-or-null":
      return value === null || typeof value === "string" ? null : "must be a string or null";
  }
}

function assertRecord(
  value: unknown,
  section: CatalogSection,
  path: string
): CatalogRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new InventoryValidationError(
      `Invalid record at ${path}: expected an object with identity, source, and fields.`
    );
  }
  const record = value as Record<string, unknown>;
  if (typeof record.identity !== "string" || record.identity.length === 0) {
    throw new InventoryValidationError(`Invalid record at ${path}: "identity" must be a non-empty string.`);
  }
  if (typeof record.source !== "string") {
    throw new InventoryValidationError(`Invalid record at ${path}: "source" must be a string.`);
  }
  const fields = record.fields;
  if (fields === null || typeof fields !== "object" || Array.isArray(fields)) {
    throw new InventoryValidationError(`Invalid record at ${path}: "fields" must be an object.`);
  }

  const allowed = new Set<string>([
    ...RECORD_METADATA_KEYS,
    "fields",
    ...SECTION_FIELDS[section],
  ]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new InventoryValidationError(
        `Rejected key "${key}" at ${path}: not a catalog field for section "${section}".`
      );
    }
  }

  for (const [key, fieldValue] of Object.entries(fields as Record<string, unknown>)) {
    if (!SECTION_FIELDS[section].includes(key)) {
      throw new InventoryValidationError(
        `Rejected field "${key}" at ${path}.fields: not a catalog field for section "${section}". ` +
          "Raw SQL fields are not allowed; only structural fields and *Hash hashes may be carried."
      );
    }
    const expectedType = FIELD_TYPES[section][key];
    if (!expectedType) {
      // Defensive: SECTION_FIELDS and FIELD_TYPES must stay in sync (a
      // consistency test enforces this).
      throw new InventoryValidationError(
        `Rejected field "${key}" at ${path}.fields: no declared type for section "${section}".`
      );
    }
    const typeError = fieldTypeError(expectedType, fieldValue);
    if (typeError !== null) {
      throw new InventoryValidationError(
        `Rejected field "${key}" at ${path}.fields: ${typeError} (expected ${expectedType}).`
      );
    }
  }

  return record as unknown as CatalogRecord;
}

/**
 * Parse and validate a serialized inventory packet. Throws
 * `InventoryValidationError` on any structural or prohibited-key violation.
 * Performs a full recursive prohibited-key scan before structural checks, and
 * FAILS CLOSED when any catalog section is missing.
 */
export function parseInventoryPacket(text: string): SchemaInventory {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new InventoryValidationError("Invalid inventory packet: not valid JSON.");
  }
  return validateInventoryPacket(parsed);
}

/** Validate an already-parsed inventory value (used by tests and the diff API). */
export function validateInventoryPacket(value: unknown): SchemaInventory {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new InventoryValidationError("Invalid inventory packet: expected a JSON object.");
  }
  // Full recursive scan first: no row-data/credential key anywhere.
  assertNoProhibitedKeys(value);

  const packet = value as Record<string, unknown>;
  const allowedTopLevel = new Set(["formatVersion", "source", "capturedAt", "catalog"]);
  for (const key of Object.keys(packet)) {
    if (!allowedTopLevel.has(key)) {
      throw new InventoryValidationError(
        `Rejected top-level key "${key}": only formatVersion, source, capturedAt, and catalog are allowed.`
      );
    }
  }

  if (packet.formatVersion !== INVENTORY_FORMAT_VERSION) {
    throw new InventoryValidationError(
      `Unsupported formatVersion ${JSON.stringify(packet.formatVersion)}: expected ${INVENTORY_FORMAT_VERSION}.`
    );
  }
  const source = packet.source;
  if (source !== "remote" && source !== "local") {
    throw new InventoryValidationError(
      `Invalid source ${JSON.stringify(source)}: expected "remote" or "local".`
    );
  }
  if (typeof packet.capturedAt !== "string") {
    throw new InventoryValidationError("Invalid packet: capturedAt must be a string.");
  }
  if (packet.catalog === null || typeof packet.catalog !== "object" || Array.isArray(packet.catalog)) {
    throw new InventoryValidationError("Invalid packet: catalog must be an object.");
  }

  const catalog = packet.catalog as Record<string, unknown>;
  for (const key of Object.keys(catalog)) {
    if (!(CATALOG_SECTIONS as readonly string[]).includes(key)) {
      throw new InventoryValidationError(
        `Rejected catalog key "${key}": not a known catalog section.`
      );
    }
  }

  const resultCatalog = {} as Record<CatalogSection, CatalogRecord[]>;
  for (const section of CATALOG_SECTIONS) {
    const rawSection = catalog[section];
    if (rawSection === undefined) {
      // Incomplete packets fail closed: every section is required.
      throw new InventoryValidationError(
        `Invalid packet: catalog.${section} is missing. Every catalog section is required; ` +
          "incomplete packets fail closed."
      );
    }
    if (!Array.isArray(rawSection)) {
      throw new InventoryValidationError(
        `Invalid packet: catalog.${section} must be an array of records.`
      );
    }
    resultCatalog[section] = rawSection.map((record, index) =>
      assertRecord(record, section, `catalog.${section}[${index}]`)
    );
  }

  return {
    formatVersion: INVENTORY_FORMAT_VERSION,
    source: source as InventorySource,
    capturedAt: packet.capturedAt as string,
    catalog: resultCatalog,
  };
}

// ---------------------------------------------------------------------------
// Disposition manifest validation
// ---------------------------------------------------------------------------

const REVIEWED_DISPOSITIONS: readonly ReviewedDispositionValue[] = [
  "remote-only intended",
  "local-only missing",
];

/**
 * Parse and validate a serialized disposition manifest. Throws
 * `InventoryValidationError` on any structural or prohibited-key violation.
 */
export function parseDispositionManifest(text: string): DispositionManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new InventoryValidationError("Invalid disposition manifest: not valid JSON.");
  }
  return validateDispositionManifest(parsed);
}

/** Validate an already-parsed disposition manifest value. */
export function validateDispositionManifest(value: unknown): DispositionManifest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new InventoryValidationError("Invalid disposition manifest: expected a JSON object.");
  }
  assertNoProhibitedKeys(value);

  const manifest = value as Record<string, unknown>;
  const allowedTopLevel = new Set(["formatVersion", "reviewed"]);
  for (const key of Object.keys(manifest)) {
    if (!allowedTopLevel.has(key)) {
      throw new InventoryValidationError(
        `Rejected manifest key "${key}": only formatVersion and reviewed are allowed.`
      );
    }
  }
  if (manifest.formatVersion !== MANIFEST_FORMAT_VERSION) {
    throw new InventoryValidationError(
      `Unsupported manifest formatVersion ${JSON.stringify(manifest.formatVersion)}: expected ${MANIFEST_FORMAT_VERSION}.`
    );
  }
  if (!Array.isArray(manifest.reviewed)) {
    throw new InventoryValidationError("Invalid manifest: reviewed must be an array.");
  }

  const reviewed = manifest.reviewed.map((entry, index): ReviewedDisposition => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new InventoryValidationError(`Invalid manifest entry ${index}: expected an object.`);
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.section !== "string" || !(CATALOG_SECTIONS as readonly string[]).includes(e.section)) {
      throw new InventoryValidationError(
        `Invalid manifest entry ${index}: "section" must be a known catalog section.`
      );
    }
    if (typeof e.identity !== "string" || e.identity.length === 0) {
      throw new InventoryValidationError(
        `Invalid manifest entry ${index}: "identity" must be a non-empty string.`
      );
    }
    if (typeof e.disposition !== "string" || !REVIEWED_DISPOSITIONS.includes(e.disposition as ReviewedDispositionValue)) {
      throw new InventoryValidationError(
        `Invalid manifest entry ${index}: "disposition" must be "remote-only intended" or "local-only missing".`
      );
    }
    const allowed = new Set(["section", "identity", "disposition", "reason"]);
    for (const key of Object.keys(e)) {
      if (!allowed.has(key)) {
        throw new InventoryValidationError(
          `Rejected manifest entry key "${key}" at reviewed[${index}].`
        );
      }
    }
    const result: ReviewedDisposition = {
      section: e.section as CatalogSection,
      identity: e.identity,
      disposition: e.disposition as ReviewedDispositionValue,
    };
    if (e.reason !== undefined) {
      if (typeof e.reason !== "string") {
        throw new InventoryValidationError(
          `Invalid manifest entry ${index}: "reason" must be a string.`
        );
      }
      result.reason = e.reason;
    }
    return result;
  });

  return { formatVersion: MANIFEST_FORMAT_VERSION, reviewed };
}